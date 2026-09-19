/**
 * Boot checks for pokerpot.
 *
 * The client picks a sync transport at startup, and every failure path in that
 * code returns null and falls back to local-only. That makes a genuine bug
 * look exactly like "no server here" — a const in the temporal dead zone once
 * shipped as a page that loaded fine and silently never synced.
 *
 * So: stub the browser, serve a table over a fake fetch, and assert the client
 * actually reaches the API and opens the stream.  Run: node test/boot.test.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const page = readFileSync(join(root, "index.html"), "utf8");
const body = page.slice(page.indexOf("<script>") + 8, page.lastIndexOf("</script>"));
const out = join(mkdtempSync(join(tmpdir(), "pokerpot-boot-")), "page.cjs");
writeFileSync(out, body);

/* ---------- the smallest browser this page will run in ---------- */
const node = new Proxy(function () {}, {
  get: (t, k) =>
    k === "style" || k === "dataset" || k === "classList" || k === "lastElementChild"
      ? node
      : k === "value" || k === "textContent" || k === "innerHTML" || k === "className"
        ? ""
        : typeof k === "symbol"
          ? undefined
          : node,
  set: () => true,
  apply: () => node,
});

const fetched = [];
const streamed = [];
let consoleErrors = [];

globalThis.document = {
  createElement: () => node,
  createDocumentFragment: () => node,
  querySelector: () => node,
  querySelectorAll: () => [],
  addEventListener() {},
};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.confirm = () => true;
globalThis.prompt = () => null;

const TABLE = {
  rev: 7,
  name: "Live table",
  config: { sb: 25, bb: 50, ante: 0, buyinChips: 2000, buyinCost: 20 },
  players: [],
  buttonId: null,
  handNo: 0,
  hand: null,
  log: [],
};

globalThis.fetch = async (url, opts = {}) => {
  fetched.push({ url, method: opts.method || "GET" });
  return { ok: true, status: 200, json: async () => TABLE };
};
globalThis.EventSource = class {
  constructor(url) { streamed.push(url); }
  close() {}
};

// The server injects this; no window.claude, so the artifact transport is out.
globalThis.window = { __POKERPOT_BASE__: "/poker/" };

const realError = console.error;
console.error = (...a) => { consoleErrors.push(a.join(" ")); };

await import(pathToFileURL(out).href);
await new Promise(r => setTimeout(r, 50));   // let the async boot settle
console.error = realError;

/* ---------- assertions ---------- */
let fails = 0;
const chk = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(
    (ok ? "  ok  " : "  FAIL") + "  " + label +
    (ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`)
  );
};

console.log("\n— the page reaches its API at the injected mount point —");
chk("fetched the table once", fetched.filter(f => f.method === "GET").length, 1);
chk("used the /poker mount, not a relative URL",
    fetched[0] && fetched[0].url, "/poker/api/state");
chk("opened the event stream", streamed, ["/poker/api/stream"]);
chk("no errors logged during boot", consoleErrors, []);

console.log(fails ? `\n${fails} FAILING\n` : "\nall boot checks pass\n");
process.exit(fails ? 1 : 0);
