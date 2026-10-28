// The page and its read-only API, shared by `agy-local-telemetry serve` (plain Node) and the
// AGY 2.0 Hub plugin (Sidecar SDK). Every route is a GET: the Sidecar SDK requires a token on
// other methods, and nothing here changes anything but the local record.

import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { conversation, conversations, detail, groups, options, overview } from "./api.mjs";
import { scan } from "./store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// ui/ sits beside lib/ at the plugin root.
export const UI_FILE = join(HERE, "..", "ui", "index.html");

export function apiRoutes(store, { geminiDir, demo = false } = {}) {
  return {
    "/api/overview": (p) => overview(store, p),
    "/api/groups": (p) => groups(store, p),
    "/api/detail": (p) => detail(store, p),
    "/api/options": (p) => options(store, p),
    "/api/conversations": (p) => conversations(store, p),
    "/api/conversation": (p) => conversation(store, p),
    "/api/scan": () => {
      if (demo) return { demo: true, read: 0, newCalls: 0, folders: [] };
      const results = scan(store, { geminiDir });
      return {
        read: results.reduce((s, r) => s + r.read, 0),
        newCalls: results.reduce((s, r) => s + r.newCalls, 0),
        folders: results.map((r) => ({ folder: r.folder, surface: r.surface, conversations: r.conversations, read: r.read, errors: r.errors.length })),
      };
    },
  };
}

export const page = () => readFileSync(UI_FILE, "utf8");

// Standalone server. Loopback unless HOST says otherwise; there is no login.
export function servePlain(store, { port, host = "127.0.0.1", geminiDir, demo = false } = {}) {
  if (!existsSync(UI_FILE)) throw new Error(`Page not found: ${UI_FILE}`);
  const routes = apiRoutes(store, { geminiDir, demo });
  const send = (res, status, body, type = "application/json; charset=utf-8") => {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method !== "GET") return send(res, 405, { error: "Method Not Allowed" });
    try {
      if (routes[url.pathname]) return send(res, 200, routes[url.pathname](Object.fromEntries(url.searchParams)));
      if (url.pathname === "/preload.js") return send(res, 200, "// standalone: no Hub bridge", "application/javascript");
      if (url.pathname === "/" || url.pathname === "/index.html") return send(res, 200, page(), "text/html; charset=utf-8");
      return send(res, 404, { error: "Not found" });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
