/* 𓁹𓁹: the site's MCP server.
 *
 * One endpoint, POST /mcp, speaking the Model Context Protocol's Streamable
 * HTTP transport: JSON-RPC in, JSON out, one message per request, no session
 * and no event stream. An agent that never opens a browser can list the
 * site's tools and call them; Cloudflare's WebMCP "Site MCP server" pack
 * reads the same endpoint and hands its tools to agents inside the browser.
 *
 * The tools are the pages' own. Each tool page keeps its pure logic in a block
 * marked `core` inside its script, ending with the list of tools it offers
 * (`AGENT_TOOLS`); the page registers those with the browser, and this module
 * reads the same block out of the page file and runs it here, after the
 * scripts the page's registry row names in `deps`. So a tool's behaviour is
 * written once, in its page, and an agent gets the same answer, and the same
 * refusal, wherever it asks. Tools that work on something only the visitor
 * has (a chosen file, the scratchpad, a share room) are not in any core and
 * are not offered here.
 *
 * Unlike the pages, which run in the visitor's browser, a call here sends its
 * input to this server. Nothing is stored or logged: the input is used for the
 * one answer and dropped. The initialize reply and every tool's description
 * say so.
 *
 * Defensive details
 *
 *   A request with an Origin header must come from this site, or from an
 *   origin the operator lists in `MCP_ALLOWED_ORIGINS`, which alone get CORS
 *   headers. A request without one, from an agent's own server, is fine; the
 *   check is the protocol's guard against a page on another site driving it
 *   through a visitor's browser.
 *
 *   Bodies are capped before they are parsed, one message per request, and
 *   every tool keeps the limits its page has. This process also relays share
 *   signaling, so a tool's synchronous work, which holds everything else up
 *   while it runs, is cut off after SYNC_LIMIT_MS, and a call still waiting
 *   after CALL_TIMEOUT_MS, such as a drand draw, is answered as an error
 *   rather than held open. Only MAX_PENDING_CALLS may wait at once, counted
 *   until their work settles, so a flood cannot queue work without bound.
 */

import { readFile } from "node:fs/promises";
import { Script, createContext, runInContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { PUBLIC_ROOT_FILES } from "./public-files.mjs";
import { originPolicy } from "./request-origin.mjs";

const ENDPOINT = "/mcp";
const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLISHED = new Set(PUBLIC_ROOT_FILES);
/* Newest first: the first is offered to a client asking for one we lack. */
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const MAX_BODY_BYTES = 1024 * 1024;
const SYNC_LIMIT_MS = 2000;
const CALL_TIMEOUT_MS = 20000;
const MAX_PENDING_CALLS = 6;
/* The block every tool page marks as shareable: from the line opening with
   `/* ── core` to the one opening with `/* ── end core`. */
const CORE_BLOCK = /\/\* ── core\b[^]*?\*\/([^]*?)\/\* ── end core\b/;
const SERVER_NOTE = " Runs on the eyes.tools server, which keeps nothing it is sent.";
/* A call runs inside its page's realm, as a script, so the vm's timeout covers
   the tool's synchronous work; the arguments cross as JSON, so the tool sees
   objects of its own realm. */
const INVOKE = new Script("__eyesTool.compute(JSON.parse(__eyesArgs))", { filename: "mcp tools/call" });

const INSTRUCTIONS = "eyes.tools is a set of small tools for text, code, colors, time, randomness and codes. " +
  "Each tool here is the same code its page runs in a visitor's browser, so it answers the same way. " +
  "Calls send their input to the eyes.tools server, which uses it for the one answer and keeps nothing. " +
  "Tools that need something only a visitor has, such as a file on their device, are on the pages at https://eyes.tools.";

/** Something a JSON-RPC caller did wrong, answered as an error object. */
class RpcError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

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

/**
 * Read every tool page's core and the tools it offers.
 * @returns {Promise<{tools: Map<string, object>, version: string}>} Tool
 *   name → { spec, slug, scope }, and the site's version.
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
      console, crypto: webcrypto, TextEncoder, TextDecoder, URL, URLSearchParams, atob, btoa,
      setTimeout, clearTimeout, queueMicrotask, structuredClone, fetch: globalThis.fetch
    });
    scope.window = scope;
    scope.self = scope;
    /* A core may load more of the site's published files when it first needs
       them, as its page does: a script, run in this realm once, or a
       WebAssembly formatter's bytes. Nothing the site does not publish. */
    const published = name => PUBLISHED.has(name) ? readFile(join(root, name)) : Promise.reject(new Error("not a published file: " + name));
    const ran = new Set();
    scope.eyesLoadScript = name => published(name).then(file => {
      if (ran.has(name)) return;
      runInContext(file.toString("utf8"), scope, { filename: name });
      ran.add(name);
    });
    scope.eyesLoadBytes = name => published(name).then(file => new Uint8Array(file));
    for (const dep of row.deps || []) runInContext(await readFile(join(root, dep), "utf8"), scope, { filename: dep });
    runInContext('"use strict";\n' + match[1], scope, { filename: "t/" + row.slug + ".html (core)" });

    const offered = runInContext("typeof AGENT_TOOLS === 'undefined' ? [] : AGENT_TOOLS", scope);
    for (const spec of offered) {
      if (tools.has(spec.name)) throw new Error("two pages offer " + spec.name);
      tools.set(spec.name, { spec, slug: row.slug, scope });
    }
  }
  return { tools, version };
}

/** A tool as `tools/list` describes it. */
function describe({ spec }) {
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description + SERVER_NOTE,
    inputSchema: JSON.parse(JSON.stringify(spec.input || { type: "object", properties: {} })),
    annotations: {
      title: spec.title,
      readOnlyHint: !!spec.readOnly,
      destructiveHint: false,
      openWorldHint: !!spec.network
    }
  };
}

/**
 * Build the MCP service.
 * @param {object} [options]
 * @param {string} [options.root] Where the site's files are.
 * @param {string} [options.allowedOrigins] Comma-separated origins, besides this
 *   site's, that may call from a browser.
 */
export function createMcpService({ root = ROOT, allowedOrigins = process.env.MCP_ALLOWED_ORIGINS } = {}) {
  const { allowedCrossOrigin, sameOrigin } = originPolicy(allowedOrigins);
  let tools = null, version = "", pending = 0;
  const ready = loadTools(root).then(loaded => { tools = loaded.tools; version = loaded.version; });
  /* A page whose core cannot load is a bug to see at startup, not a quiet gap
     in the tool list. The first request reports it too. */
  ready.catch(error => console.error("mcp tools failed to load:", error.message));

  function reply(response, status, body, headers = {}) {
    const bytes = body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    response.writeHead(status, {
      ...(body === null ? {} : { "Content-Type": "application/json; charset=utf-8" }),
      "Content-Length": bytes.byteLength,
      "Cache-Control": "no-store",
      ...headers
    });
    response.end(bytes);
  }

  async function readBody(request) {
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new RpcError(-32600, "message too large");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  /** Run a tool in its page's realm, its synchronous work under the limit. */
  function invoke({ spec, scope }, args) {
    scope.__eyesTool = spec;
    scope.__eyesArgs = JSON.stringify(args);
    try {
      return INVOKE.runInContext(scope, { timeout: SYNC_LIMIT_MS });
    } catch (error) {
      if (error && error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") throw new Error("the tool took too long; try a smaller input");
      throw error;
    } finally {
      delete scope.__eyesTool;
      delete scope.__eyesArgs;
    }
  }

  async function call(params) {
    if (!params || typeof params.name !== "string") throw new RpcError(-32602, "tools/call needs a tool name");
    const tool = tools.get(params.name);
    if (!tool) throw new RpcError(-32602, "unknown tool: " + params.name);
    const args = params.arguments == null ? {} : params.arguments;
    if (typeof args !== "object" || Array.isArray(args)) throw new RpcError(-32602, "arguments must be an object");

    let timer;
    try {
      const absent = (tool.spec.input && tool.spec.input.required || []).find(key => args[key] == null);
      if (absent) throw new Error(absent + " is required");
      if (pending >= MAX_PENDING_CALLS) throw new Error("the server is busy with other calls; try again in a few seconds");
      let work = invoke(tool, args);
      if (work && typeof work.then === "function") {
        pending++;
        work = Promise.resolve(work).finally(() => { pending--; });
      }
      const result = await Promise.race([
        work,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("the tool took too long; try again")), CALL_TIMEOUT_MS); })
      ]);
      /* Results come from the page's own realm; a JSON round trip gives plain
         objects, and anything that would not survive JSON fails here, not in
         the client. */
      const plain = JSON.parse(JSON.stringify(result === undefined ? {} : result));
      const structured = plain && typeof plain === "object" && !Array.isArray(plain) ? plain : { result: plain };
      return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured, isError: false };
    } catch (error) {
      /* A tool refusing its input is a result the agent can read and act on,
         not a protocol failure. */
      return { content: [{ type: "text", text: (error && error.message) || "the tool failed" }], isError: true };
    } finally {
      clearTimeout(timer);
    }
  }

  async function dispatch(message) {
    switch (message.method) {
      case "initialize": {
        const asked = message.params && message.params.protocolVersion;
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "eyes.tools", title: "𓁹𓁹 eyes.tools", version },
          instructions: INSTRUCTIONS
        };
      }
      case "ping": return {};
      case "tools/list": return { tools: [...tools.values()].map(describe) };
      case "tools/call": return call(message.params);
      default: throw new RpcError(-32601, "method not found: " + message.method);
    }
  }

  async function handle(request, response, url) {
    if (url.pathname !== ENDPOINT) return reply(response, 404, { error: "not found" });

    /* Browser requests must stay on this site, or come from a listed origin,
       which alone gets CORS headers. */
    const cross = allowedCrossOrigin(request);
    if (!cross && !sameOrigin(request)) return reply(response, 403, { error: "this origin may not use the mcp server" });
    const cors = cross ? { "Access-Control-Allow-Origin": cross, Vary: "Origin" } : {};

    if (request.method === "OPTIONS" && cross) {
      return reply(response, 204, null, {
        ...cors,
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id",
        "Access-Control-Max-Age": "600"
      });
    }
    /* No event stream is offered, and there is no session to end. */
    if (request.method !== "POST") return reply(response, 405, { error: "use POST" }, { ...cors, Allow: "POST" });

    const version = request.headers["mcp-protocol-version"];
    if (version && !PROTOCOL_VERSIONS.includes(version)) {
      return reply(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "unsupported protocol version: " + version } }, cors);
    }

    let message;
    try {
      message = JSON.parse(await readBody(request));
    } catch (error) {
      const tooLarge = error instanceof RpcError;
      return reply(response, tooLarge ? 413 : 400, {
        jsonrpc: "2.0", id: null,
        error: tooLarge ? { code: error.code, message: error.message } : { code: -32700, message: "the body is not JSON" }
      }, cors);
    }
    if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") {
      return reply(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "send one JSON-RPC 2.0 message per request" } }, cors);
    }
    /* Notifications and responses need no answer beyond acceptance. */
    if (message.id === undefined || typeof message.method !== "string") return reply(response, 202, null, cors);

    try {
      await ready;
      return reply(response, 200, { jsonrpc: "2.0", id: message.id, result: await dispatch(message) }, cors);
    } catch (error) {
      const code = error instanceof RpcError ? error.code : -32603;
      const text = error instanceof RpcError ? error.message : "the server could not load its tools";
      return reply(response, 200, { jsonrpc: "2.0", id: message.id, error: { code, message: text } }, cors);
    }
  }

  return {
    ready,
    async handle(request, response, url) {
      try { await handle(request, response, url); }
      catch {
        if (!response.headersSent && !response.destroyed) reply(response, 400, { error: "bad request" });
      }
    },
    close() {}
  };
}
