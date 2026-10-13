/* 𓁹𓁹: where the MCP server runs the tools.
 *
 * mcp-server.mjs keeps a few of these and gives each one call at a time. A
 * worker reads every tool page's core into a realm of its own, as the page
 * runs it, says which tools it has, and then answers calls:
 *
 *   in   { type: "call", id, name, args }
 *   out  { type: "result", id, result } or { type: "result", id, error }
 *
 * The work happens here, off the thread that answers every request, so an
 * image being resized or a sound being drawn holds up nothing else: share's
 * signaling least of all. A call that runs too long is stopped by ending its
 * worker, which no timer on the main thread could do to work in progress.
 *
 * A core that reaches the network (a drand draw) does it through `fetch`,
 * which here asks the main thread to make the request: { type: "fetch" } out,
 * { type: "fetched" } back. The server's outbound requests stay in one place,
 * and the tests can stand in for the network there.
 */

import { parentPort, workerData } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { Script, createContext, runInContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { join } from "node:path";

import { PUBLIC_ROOT_FILES } from "./public-files.mjs";

const PUBLISHED = new Set(PUBLIC_ROOT_FILES);
/* The block every tool page marks as shareable: from the line opening with
   `/* ── core` to the one opening with `/* ── end core`. */
const CORE_BLOCK = /\/\* ── core\b[^]*?\*\/([^]*?)\/\* ── end core\b/;
/* A call runs inside its page's realm, as a script; the arguments cross as
   JSON, so the tool sees objects of its own realm. */
const INVOKE = new Script("__eyesTool.compute(JSON.parse(__eyesArgs))", { filename: "mcp tools/call" });

/**
 * Stand-ins for the few browser objects the pages' dependencies look for.
 * The QR encoder draws into an element as a side effect of building its
 * model; the model is all a core uses, so the element only has to absorb it.
 */
function browserShims() {
  const element = () => ({
    style: {}, childNodes: [{ offsetWidth: 0, offsetHeight: 0, style: {} }], innerHTML: "",
    appendChild() {}, setAttribute() {}, getContext: () => null
  });
  return {
    document: { documentElement: { tagName: "HTML" }, createElement: element },
    navigator: { userAgent: "eyes.tools mcp" }
  };
}

/* The libraries the cores use talk to the console (ExifReader warns that it
   cannot read XMP without a DOMParser on every call); a failure reaches the
   agent as its result, so the server's log is spared the chatter. */
const QUIET = Object.fromEntries(["log", "info", "debug", "warn", "error", "trace"].map(name => [name, () => {}]));

/* `fetch`, made by the main thread. */
const fetches = new Map();
let fetchIds = 0;
function fetchThroughServer(resource, init = {}) {
  const id = ++fetchIds;
  return new Promise((resolve, reject) => {
    fetches.set(id, { resolve, reject });
    parentPort.postMessage({
      type: "fetch", id, url: String(resource && resource.url ? resource.url : resource),
      init: { method: init.method, headers: init.headers ? Object.fromEntries(new Headers(init.headers)) : undefined, body: typeof init.body === "string" ? init.body : undefined }
    });
  });
}
function fetched({ id, error, status, headers, body }) {
  const waiting = fetches.get(id);
  if (!waiting) return;
  fetches.delete(id);
  if (error) waiting.reject(new TypeError(error));
  else waiting.resolve(new Response(status === 204 || status === 304 ? null : body, { status, headers }));
}

/**
 * Read every tool page's core and the tools it offers.
 * @returns {Promise<{tools: Map<string, {spec: object, scope: object}>, version: string}>}
 */
async function loadTools(root) {
  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const registry = createContext({});
  registry.window = registry;
  runInContext(await readFile(join(root, "tools.js"), "utf8"), registry);
  const rows = JSON.parse(JSON.stringify(registry.TOOLS));
  const tools = new Map();

  for (const row of rows) {
    const page = await readFile(join(root, "t", row.slug + ".html"), "utf8");
    const match = CORE_BLOCK.exec(page);
    if (!match) continue;

    /* A fresh global for each page, as each page has its own. Only what a core
       or a page's dependency may use is put in it. */
    const scope = createContext({
      ...browserShims(),
      console: QUIET, crypto: webcrypto, TextEncoder, TextDecoder, URL, URLSearchParams, atob, btoa,
      setTimeout, clearTimeout, queueMicrotask, structuredClone, performance,
      CompressionStream, DecompressionStream, Blob, Response, Headers, fetch: fetchThroughServer
    });
    scope.window = scope;
    scope.self = scope;
    /* A core may load more of the site's published files when it first needs
       them, as its page does: a script, run in this realm once, or a
       WebAssembly module's bytes. Nothing the site does not publish. */
    const published = name => PUBLISHED.has(name) ? readFile(join(root, name)) : Promise.reject(new Error("not a published file: " + name));
    const ran = new Set();
    scope.eyesLoadScript = name => published(name).then(file => {
      if (ran.has(name)) return;
      runInContext(file.toString("utf8"), scope, { filename: name });
      ran.add(name);
    });
    scope.eyesLoadBytes = name => published(name).then(file => runInContext("Uint8Array", scope).from(file));
    for (const dep of row.deps || []) runInContext(await readFile(join(root, dep), "utf8"), scope, { filename: dep });
    /* Inside a function, as the page runs it: a core's own names are then
       its function's, not properties of the realm's global, which a vm
       context makes slow to reach (a spectrogram takes fifteen times as long). */
    const offered = runInContext('(function () {\n"use strict";\n' + match[1] + '\nreturn typeof AGENT_TOOLS === "undefined" ? [] : AGENT_TOOLS;\n})()',
      scope, { filename: "t/" + row.slug + ".html (core)" });
    for (const spec of offered) {
      if (tools.has(spec.name)) throw new Error("two pages offer " + spec.name);
      tools.set(spec.name, { spec, scope });
    }
  }
  return { tools, version };
}

/* What the main thread needs to describe a tool: its spec, less the code. */
function described(spec) {
  return JSON.parse(JSON.stringify({
    name: spec.name, title: spec.title, description: spec.description, input: spec.input, output: spec.output,
    readOnly: spec.readOnly, network: spec.network
  }));
}

async function call({ id, name, args }) {
  const tool = tools.get(name);
  try {
    tool.scope.__eyesTool = tool.spec;
    tool.scope.__eyesArgs = JSON.stringify(args);
    let result;
    try { result = INVOKE.runInContext(tool.scope); }
    finally { delete tool.scope.__eyesTool; delete tool.scope.__eyesArgs; }
    result = await result;
    /* Results come from the page's own realm; a JSON round trip gives plain
       objects, and anything that would not survive JSON fails here. */
    parentPort.postMessage({ type: "result", id, result: JSON.parse(JSON.stringify(result === undefined ? {} : result)) });
  } catch (error) {
    parentPort.postMessage({ type: "result", id, error: (error && error.message) || String(error) || "the tool failed" });
  }
}

let tools;
try {
  const loaded = await loadTools(workerData.root);
  tools = loaded.tools;
  parentPort.on("message", message => {
    if (message.type === "call") call(message);
    else if (message.type === "fetched") fetched(message);
  });
  parentPort.postMessage({ type: "ready", version: loaded.version, tools: [...tools.values()].map(tool => described(tool.spec)) });
} catch (error) {
  parentPort.postMessage({ type: "failed", message: (error && error.stack) || String(error) });
}
