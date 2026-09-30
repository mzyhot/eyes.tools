/* 𓁹𓁹 — the signed GitHub deployment webhook.
 *
 * GitHub sends the request body exactly as it was signed, so verification has
 * to happen over the raw bytes before JSON parsing. A valid request only asks
 * the local updater to check main; it never carries a command, a ref to check,
 * or credentials for the GitHub API.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";

const ENDPOINT = "/api/github/sync";
const REPOSITORY = "mzyhot/eyes.tools";
const MAX_BODY_BYTES = 1024 * 1024;
const ALLOW = "POST";

/**
 * Start the systemd updater with its own protected GitHub credentials. The
 * webhook process deliberately does not receive the updater's API token.
 */
function startUpdater() {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/systemctl", ["start", "--no-block", "eyes-updater.service"], {
      stdio: "ignore"
    });
    child.once("error", reject);
    child.once("exit", code => {
      if (code === 0) resolve();
      else reject(new Error("updater could not be queued"));
    });
  });
}

/** Send a small uncached JSON response without reflecting request data. */
function reply(response, status, body, headers = {}) {
  const bytes = Buffer.from(JSON.stringify(body) + "\n");
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": bytes.byteLength,
    "Content-Type": "application/json; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    ...headers
  });
  response.end(bytes);
}

/** Read the body once, keeping the size bound ahead of JSON parsing. */
async function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers["content-type"] || ""))) {
    throw new Error("use application/json");
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("payload too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Verify GitHub's sha256 signature without exposing a timing oracle. */
function hasValidSignature(rawBody, supplied, secret) {
  if (!secret || typeof supplied !== "string" || !/^sha256=[0-9a-f]{64}$/i.test(supplied)) return false;
  const actual = Buffer.from(supplied.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Build the webhook service.
 *
 * `sync` is injectable for tests. Production queues the fixed systemd unit;
 * it never interpolates anything from the webhook into a shell command.
 */
export function createGithubWebhookService({ secret = process.env.GITHUB_SECRET, sync = startUpdater } = {}) {
  async function handle(request, response, url) {
    if (url.pathname !== ENDPOINT) return reply(response, 404, { error: "not found" });
    if (request.method !== "POST") return reply(response, 405, { error: "method not allowed" }, { Allow: ALLOW });
    if (!secret) return reply(response, 503, { error: "webhook is not configured" });

    let rawBody;
    try {
      rawBody = await readBody(request);
    } catch {
      return reply(response, 400, { error: "invalid payload" });
    }
    if (!hasValidSignature(rawBody, request.headers["x-hub-signature-256"], secret)) {
      return reply(response, 401, { error: "invalid signature" });
    }

    let payload;
    try { payload = JSON.parse(rawBody.toString("utf8")); }
    catch { return reply(response, 400, { error: "invalid payload" }); }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return reply(response, 400, { error: "invalid payload" });
    }
    if (payload.repository?.full_name !== REPOSITORY) {
      return reply(response, 403, { error: "repository not accepted" });
    }

    try {
      await sync({
        delivery: request.headers["x-github-delivery"] || "",
        event: request.headers["x-github-event"] || "",
        payload
      });
    } catch {
      return reply(response, 503, { error: "sync could not be queued" });
    }
    return reply(response, 202, { accepted: true });
  }

  return {
    async handle(request, response, url) {
      try { await handle(request, response, url); }
      catch {
        if (!response.headersSent && !response.destroyed) reply(response, 400, { error: "invalid payload" });
      }
    },
    close() {}
  };
}
