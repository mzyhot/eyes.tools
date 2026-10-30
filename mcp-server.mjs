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
 * (`AGENT_TOOLS`); the page registers those with the browser, and the workers
 * of mcp-worker.mjs read the same block out of the page file and run it, after
 * the scripts the page's registry row names in `deps`. So a tool's behaviour
 * is written once, in its page, and an agent gets the same answer, and the
 * same refusal, wherever it asks. Tools that work on something only the
 * visitor has (the scratchpad, a share room) are not in any core and are not
 * offered here; a tool that works on a file takes it as base64.
 *
 * Every tool describes its input and its answer with JSON Schema. A call's
 * arguments are checked against the input's before a worker sees them, by
 * agent-schema.js, which the pages use too, so a mistake gets the same words
 * everywhere. An answer is sent as structured content and as its JSON in text;
 * an image in it (a QR code, a resized photo, a spectrogram) goes as image
 * content instead, so neither the text nor the structured content carries
 * megabytes of base64.
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
 *   Bodies are capped before they are parsed (MAX_BODY_BYTES, enough for a
 *   10 MB file as base64), and all the bodies being read at once together
 *   (BODY_BUDGET), one message per request, and every tool keeps the limits
 *   its page has. This process also relays share signaling, so calls run in
 *   worker threads (mcp-worker.mjs), one at a time each: a call still running
 *   after CALL_TIMEOUT_MS ends with its worker, which is replaced, and only
 *   QUEUE_LIMIT calls may wait for a worker at once.
 */

import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { originPolicy } from "./request-origin.mjs";

const ENDPOINT = "/mcp";
const ROOT = dirname(fileURLToPath(import.meta.url));
const WORKER_FILE = new URL("./mcp-worker.mjs", import.meta.url);
/* Newest first: the first is offered to a client asking for one we lack. */
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const BODY_BUDGET = 64 * 1024 * 1024;
const CALL_TIMEOUT_MS = 20000;
const QUEUE_LIMIT = 8;
const WORKER_HEAP_MB = 512;
/* A core's own network use (a drand draw) is small and quick, or it is not
   going to happen. */
const FETCH_TIMEOUT_MS = 10000;
const FETCH_LIMIT_BYTES = 1024 * 1024;
const SERVER_NOTE = " Runs on the eyes.tools server, which keeps nothing it is sent.";
/* The images a client can show; any other file stays in the JSON. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const INSTRUCTIONS = "eyes.tools is a set of small tools: text and code (clean code in 69 languages, json, diffs, counts, " +
  "case, base64, urls and hashes), colors, time and time zones, units and arithmetic, randomness (passwords, ids, numbers, " +
  "dice and coins, verifiable through drand), qr codes and barcodes, and files: an image's metadata, resizing or converting " +
  "an image, a file's checksums, and a sound's spectrogram. Each tool here is the same code its page runs in a visitor's " +
  "browser, so it answers the same way. Give a file as base64, or as a data: URL, in the argument the tool names; an image " +
  "a tool makes comes back as image content. Calls send their input to the eyes.tools server, which uses it for the one " +
  "answer and keeps nothing. Every tool is also a page at https://eyes.tools.";

/** Something a JSON-RPC caller did wrong, answered as an error object. */
class RpcError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}
/** A tool's refusal, or its failing: a result the agent reads, not a protocol error. */
class ToolError extends Error {}

/* The same checks the pages make, from the same file. */
const checker = createContext({});
runInContext(readFileSync(join(ROOT, "agent-schema.js"), "utf8"), checker, { filename: "agent-schema.js" });
const AgentSchema = checker.AgentSchema;

/**
 * Workers that each load every core and run one call at a time.
 * @param {object} options
 * @param {string} options.root Where the site's files are.
 * @param {number} options.size How many workers.
 * @param {Function} options.send The fetch a core's network use goes through.
 * @param {number} options.callTimeout How long a call may take, waiting included.
 * @returns {{ready: Promise<{tools: object[], version: string}>, run: Function, close: Function}}
 */
function createPool({ root, size, send, callTimeout }) {
  let closing = false, ids = 0, listing = null, settle;
  const idle = [], waiting = [], workers = new Set();
  const ready = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  /* Nothing waits on a pool that never starts but a request, which reports it. */
  ready.catch(() => {});

  function spawn() {
    const worker = new Worker(WORKER_FILE, { workerData: { root }, resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB } });
    const entry = { worker, call: null, ready: false };
    workers.add(entry);
    worker.on("message", message => {
      if (message.type === "ready") {
        entry.ready = true;
        if (!listing) { listing = message; settle.resolve(message); }
        next(entry);
      } else if (message.type === "failed") {
        settle.reject(new Error(message.message));
        worker.terminate();
      } else if (message.type === "fetch") {
        proxy(worker, message);
      } else if (message.type === "result" && entry.call && entry.call.id === message.id) {
        const call = entry.call;
        entry.call = null;
        call.finish(message);
        next(entry);
      }
    });
    worker.on("error", error => { if (!entry.ready) settle.reject(error); });
    worker.on("exit", () => {
      workers.delete(entry);
      const at = idle.indexOf(entry);
      if (at >= 0) idle.splice(at, 1);
      if (entry.call) {
        const call = entry.call;
        entry.call = null;
        call.finish({ error: "the tool stopped before it answered; try again" });
      }
      /* One that never got ready would only fail again. */
      if (!closing && entry.ready) spawn();
    });
  }

  function next(entry) {
    const call = waiting.shift();
    if (call) start(entry, call);
    else idle.push(entry);
  }
  function start(entry, call) {
    entry.call = call;
    call.entry = entry;
    entry.worker.postMessage({ type: "call", id: call.id, name: call.name, args: call.args });
  }

  function run(name, args) {
    return new Promise((resolve, reject) => {
      const call = { id: ++ids, name, args, entry: null };
      const busy = () => new ToolError("the server is busy with other calls; try again in a few seconds");
      call.finish = message => {
        clearTimeout(call.timer);
        if (message.error !== undefined) reject(new ToolError(message.error));
        else resolve(message.result);
      };
      call.timer = setTimeout(() => {
        const at = waiting.indexOf(call);
        if (at >= 0) { waiting.splice(at, 1); reject(busy()); return; }
        if (call.entry && call.entry.call === call) {
          call.entry.call = null;
          call.entry.worker.terminate();
        }
        reject(new ToolError("the tool took too long; try a smaller input"));
      }, callTimeout);
      const entry = idle.pop();
      if (entry) start(entry, call);
      else if (waiting.length >= QUEUE_LIMIT) { clearTimeout(call.timer); reject(busy()); }
      else waiting.push(call);
    });
  }

  /* A worker's fetch, made here: https only, bounded in time and size. */
  async function proxy(worker, { id, url, init }) {
    let reply;
    try {
      if (!/^https:\/\//i.test(url)) throw new TypeError("only https may be fetched");
      const response = await send(url, { method: init.method, headers: init.headers, body: init.body, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const body = await response.arrayBuffer();
      if (body.byteLength > FETCH_LIMIT_BYTES) throw new TypeError("the response was too large");
      reply = { type: "fetched", id, status: response.status, headers: [...response.headers], body };
    } catch (error) {
      reply = { type: "fetched", id, error: (error && error.message) || "fetch failed" };
    }
    try { worker.postMessage(reply, reply.body ? [reply.body] : []); } catch {}
  }

  for (let i = 0; i < size; i++) spawn();
  return {
    ready, run,
    close() {
      closing = true;
      for (const { worker } of workers) worker.terminate();
    }
  };
}

/** A tool as `tools/list` describes it. */
function describe(tool) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description + SERVER_NOTE,
    inputSchema: tool.input || { type: "object", properties: {} },
    ...(tool.output ? { outputSchema: tool.output } : {}),
    annotations: {
      title: tool.title,
      readOnlyHint: !!tool.readOnly,
      destructiveHint: false,
      openWorldHint: !!tool.network
    }
  };
}

/**
 * A tool's answer as `tools/call` returns it: structured content, its JSON as
 * text, and each image in it as image content, left out of the other two.
 */
function present(result) {
  const structured = result && typeof result === "object" && !Array.isArray(result) ? result : { result };
  const images = [];
  for (const [key, value] of Object.entries(structured)) {
    if (value && typeof value === "object" && typeof value.data === "string" && IMAGE_TYPES.has(value.mimeType)) {
      images.push({ type: "image", data: value.data, mimeType: value.mimeType });
      const { data, ...described } = value;
      structured[key] = described;
    }
  }
  return { content: [{ type: "text", text: JSON.stringify(structured) }, ...images], structuredContent: structured, isError: false };
}

/**
 * Build the MCP service.
 * @param {object} [options]
 * @param {string} [options.root] Where the site's files are.
 * @param {string} [options.allowedOrigins] Comma-separated origins, besides this
 *   site's, that may call from a browser.
 * @param {number} [options.workers] How many calls may run at once; one per
 *   worker thread, each holding every page's core. `MCP_WORKERS` sets it for
 *   the server; one fewer than the processor's cores, up to four, otherwise.
 * @param {number} [options.callTimeout] How long a call may take before its
 *   worker is ended, in milliseconds.
 */
export function createMcpService({
  root = ROOT,
  allowedOrigins = process.env.MCP_ALLOWED_ORIGINS,
  workers = Number(process.env.MCP_WORKERS) || Math.max(1, Math.min(4, availableParallelism() - 1)),
  callTimeout = CALL_TIMEOUT_MS
} = {}) {
  const { allowedCrossOrigin, sameOrigin } = originPolicy(allowedOrigins);
  /* The network a core reaches goes through the fetch this process has now,
     which is also where the tests stand in for it. */
  const fetchNow = globalThis.fetch;
  const pool = createPool({ root, size: workers, callTimeout, send: (...args) => fetchNow(...args) });
  let tools = null, version = "", buffered = 0;
  const ready = pool.ready.then(listing => {
    tools = new Map(listing.tools.map(tool => [tool.name, tool]));
    version = listing.version;
  });
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
    try {
      for await (const chunk of request) {
        size += chunk.length;
        buffered += chunk.length;
        if (size > MAX_BODY_BYTES) throw new RpcError(-32600, "message too large: the most one may be is 16 MB", 413);
        if (buffered > BODY_BUDGET) throw new RpcError(-32000, "the server is busy reading other messages; try again in a few seconds", 503);
        chunks.push(chunk);
      }
    } finally {
      buffered -= size;
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  async function call(params) {
    if (!params || typeof params.name !== "string") throw new RpcError(-32602, "tools/call needs a tool name");
    const tool = tools.get(params.name);
    if (!tool) throw new RpcError(-32602, "unknown tool: " + params.name);
    const args = params.arguments == null ? {} : params.arguments;
    if (typeof args !== "object" || Array.isArray(args)) throw new RpcError(-32602, "arguments must be an object");

    try {
      const wrong = AgentSchema.check(tool.input || { type: "object" }, args);
      if (wrong) throw new ToolError(wrong);
      return present(await pool.run(tool.name, args));
    } catch (error) {
      /* A tool refusing its input is a result the agent can read and act on,
         not a protocol failure. */
      return { content: [{ type: "text", text: (error instanceof ToolError && error.message) || "the tool failed" }], isError: true };
    }
  }

  async function dispatch(message) {
    switch (message.method) {
      case "initialize": {
        const asked = message.params && message.params.protocolVersion;
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "eyes.tools", title: "𓁹𓁹 eyes.tools", version, websiteUrl: "https://eyes.tools" },
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
      const refused = error instanceof RpcError;
      return reply(response, refused ? error.status : 400, {
        jsonrpc: "2.0", id: null,
        error: refused ? { code: error.code, message: error.message } : { code: -32700, message: "the body is not JSON" }
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
    close() { pool.close(); }
  };
}
