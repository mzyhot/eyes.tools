/* 𓁹𓁹: the server's API modules.
 *
 * Every same-origin endpoint the Node server mounts, one row each. The router
 * knows nothing about what they do: it matches the prefix and hands the request
 * over, so adding an API is a module that exports a factory plus a row here,
 * and removing one is deleting both. A prefix ending in `/` takes every path
 * under it; any other takes that one path alone.
 *
 * A module's factory is called once per server with the options
 * `createEyesServer` was given, and returns:
 *   handle(request, response, url)  answers one request
 *   close()                         releases whatever it holds, on shutdown
 *
 * Static hosts run none of this; they serve the pages only.
 */
import { createGithubWebhookService } from "./github-webhook.mjs";
import { createMcpService } from "./mcp-server.mjs";
import { createShareService } from "./share-server.mjs";

export const API_MODULES = [
  {
    prefix: "/api/github/",
    create: (options) => createGithubWebhookService(options.githubWebhookOptions)
  },
  {
    prefix: "/api/share/",
    create: (options) => createShareService(options.shareOptions)
  },
  {
    /* The tools, for AI agents, over the Model Context Protocol. */
    prefix: "/mcp",
    create: (options) => createMcpService(options.mcpOptions)
  }
];
