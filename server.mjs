#!/usr/bin/env node
/**
 * Pokerpot — self-hosted sync server.
 *
 * Serves index.html and keeps one shared table in sync across every phone at
 * the table. No dependencies: Node's own http module, SSE for the push side,
 * and a JSON file on disk so a restart doesn't lose the night.
 *
 *   PORT=8080 node server.mjs
 */

import { createServer } from "node:http";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const STATE_FILE = process.env.POKERPOT_STATE || join(ROOT, "data", "table.json");
// Where the app is mounted, e.g. "/poker" for litescript.net/poker. Normalised
// to a leading and trailing slash: "/" when it sits at the domain root.
const BASE = ("/" + (process.env.POKERPOT_BASE || "").trim().replace(/^\/+|\/+$/g, "") + "/")
  .replace(/^\/\/$/, "/");
const MAX_BODY = 1_000_000; // a table is a few KB; anything near this is junk

/* ---------------------------------------------------------------- state */

let table = null;
let saving = null;          // in-flight write, so concurrent saves queue
const clients = new Set();  // open SSE responses

function blankTable() {
  return {
    rev: 1,
    name: "Home game",
    createdAt: new Date().toISOString(),
    demo: false,
    config: { sb: 25, bb: 50, ante: 0, buyinChips: 2000, buyinCost: 20 },
    players: [],
    buttonId: null,
    handNo: 0,
    hand: null,
    log: [],
  };
}

async function loadTable() {
  try {
    table = JSON.parse(await readFile(STATE_FILE, "utf8"));
    console.log(`[pokerpot] resumed "${table.name}" at rev ${table.rev}`);
  } catch (e) {
    table = blankTable();
    console.log("[pokerpot] starting a fresh table");
  }
}

// Write through a temp file so a crash mid-save can't leave a truncated table.
async function saveTable() {
  await saving;
  saving = (async () => {
    await mkdir(dirname(STATE_FILE), { recursive: true });
    const tmp = STATE_FILE + ".tmp";
    await writeFile(tmp, JSON.stringify(table));
    await rename(tmp, STATE_FILE);
  })();
  return saving;
}

function broadcast() {
  const frame = `data: ${JSON.stringify(table)}\n\n`;
  for (const res of clients) {
    try { res.write(frame); } catch (e) { clients.delete(res); }
  }
}

/* ------------------------------------------------------------- requests */

function send(res, code, body, type = "application/json") {
  res.writeHead(code, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on("data", c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; }
      parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

// A table must look like a table before it replaces the real one.
function isPlausibleTable(t) {
  return t && typeof t === "object" && !Array.isArray(t)
    && typeof t.rev === "number" && Number.isFinite(t.rev)
    && Array.isArray(t.players)
    && t.config && typeof t.config === "object";
}

const PAGE = readFileSync(join(ROOT, "index.html"), "utf8");
const DOC = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<script>window.__POKERPOT_BASE__=${JSON.stringify(BASE)}</script>
<style>:root{padding-top:env(safe-area-inset-top,0);padding-bottom:env(safe-area-inset-bottom,0)}
body{margin:0;font:14px system-ui,sans-serif;background:#EFF1EC}
img{max-width:100%}[hidden]{display:none!important}</style>
</head><body>
${PAGE}
</body></html>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  // Works behind `handle_path /poker*` (prefix already stripped) and behind a
  // plain `handle` (prefix still present) — strip it here if it survived.
  let path = url.pathname;
  if (BASE !== "/") {
    const bare = BASE.slice(0, -1);              // "/poker"
    if (path === bare) path = "/";
    else if (path.startsWith(BASE)) path = path.slice(bare.length);
  }

  if (path === "/" || path === "/index.html") {
    return send(res, 200, DOC, "text/html; charset=utf-8");
  }

  if (path === "/api/state" && req.method === "GET") {
    return send(res, 200, JSON.stringify(table));
  }

  if (path === "/api/state" && req.method === "POST") {
    let next;
    try {
      next = JSON.parse(await readBody(req));
    } catch (e) {
      return send(res, 400, '{"error":"bad json"}');
    }
    if (!isPlausibleTable(next)) return send(res, 400, '{"error":"not a table"}');

    // Optimistic concurrency: a write built on a stale table loses, and the
    // loser gets the current one back so the page can re-render rather than
    // silently clobber whoever acted first.
    if (next.rev <= table.rev) return send(res, 409, JSON.stringify(table));

    table = next;
    broadcast();
    saveTable().catch(err => console.error("[pokerpot] save failed:", err.message));
    return send(res, 200, '{"ok":true}');
  }

  if (path === "/api/stream" && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no",   // tell nginx not to buffer the stream
    });
    res.write(`data: ${JSON.stringify(table)}\n\n`);
    clients.add(res);
    const beat = setInterval(() => { try { res.write(": beat\n\n"); } catch (e) {} }, 25000);
    req.on("close", () => { clearInterval(beat); clients.delete(res); });
    return;
  }

  if (path === "/api/health") {
    return send(res, 200, JSON.stringify({ ok: true, rev: table.rev, viewers: clients.size }));
  }

  send(res, 404, '{"error":"not found"}');
});

server.on("error", err => {
  console.error(err.code === "EADDRINUSE"
    ? `[pokerpot] port ${PORT} is already in use — set PORT to something free`
    : `[pokerpot] ${err.message}`);
  process.exit(1);
});

await loadTable();
server.listen(PORT, HOST, () => {
  console.log(`[pokerpot] http://${HOST}:${PORT}${BASE === "/" ? "" : BASE}`);
  if (BASE !== "/") console.log(`[pokerpot] mounted at ${BASE}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    console.log("\n[pokerpot] saving and shutting down");
    try { await saveTable(); } catch (e) {}
    process.exit(0);
  });
}
