/**
 * Dev tool: a fake box core for the integration API. Use `bargames mock-box` first (SDK 0.13.1
 * has controls for buttons, stream drops and catalog edits); this covers what it doesn't:
 *   - the box staying down for a while (mock-box's drop reconnects at once), so the devices
 *     sit unreachable;
 *   - TV power answering from the edited catalog: an offline TV, or one without power
 *     control, answers { ok: false }, which tests the switch going back.
 *
 *   npx tsx scripts/fake-core.ts            # listens on 127.0.0.1:7198, token dev-token
 *
 * Then, in other terminals:
 *   BG_CORE_URL=http://127.0.0.1:7198 BG_GAME_TOKEN=dev-token BG_DATA_DIR=./.data npm run dev
 *   curl -X POST localhost:7198/dev/down?s=20               # box gone for 20 s
 *   curl -X PUT  localhost:7198/dev/catalog -d @catalog.json  # replace the catalog
 *   curl -X POST localhost:7198/dev/action/pair-another     # press a button
 *   curl localhost:7198/dev/report                          # the last report
 */
import { createServer, type ServerResponse } from "node:http";

const PORT = Number(process.env.FAKE_CORE_PORT ?? 7198);
const TOKEN = "dev-token";

let catalog = {
  box: { id: "fake0000box00001", version: "dev", venue: "Fake Venue" },
  permissions: ["scenes", "tvs", "lan"],
  scenes: [
    { id: "bingo-night", name: "Bingo Night" },
    { id: "last-call", name: "Last call" },
  ],
  tvs: [
    { id: "roku:bar", name: "Bar TV", online: true, power: true },
    { id: "roku:patio", name: "Patio TV", online: true, power: true },
    { id: "airplay:lounge", name: "Lounge", online: true, power: false },
  ],
};
let lastReport: unknown;
let downUntil = 0;
const streams = new Set<ServerResponse>();

const send = (res: ServerResponse, msg: unknown) => res.write(`data: ${JSON.stringify(msg)}\n\n`);
const broadcast = (msg: unknown) => streams.forEach((s) => send(s, msg));
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const readBody = (req: import("node:http").IncomingMessage) =>
  new Promise<string>((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const p = url.pathname;

  if (p.startsWith("/dev/")) {
    if (p.startsWith("/dev/action/")) {
      const action = p.slice("/dev/action/".length);
      broadcast({ type: "action", action, at: new Date().toISOString() });
      console.log(`→ action ${action}`);
      return json(res, 200, { ok: true, streams: streams.size });
    }
    if (p === "/dev/down") {
      const s = Number(url.searchParams.get("s") ?? 20);
      downUntil = Date.now() + s * 1000;
      streams.forEach((r) => r.destroy());
      streams.clear();
      console.log(`→ box down for ${s} s`);
      return json(res, 200, { ok: true });
    }
    if (p === "/dev/catalog" && req.method === "PUT") {
      catalog = JSON.parse(await readBody(req));
      broadcast({ type: "catalog", catalog });
      console.log("→ catalog replaced");
      return json(res, 200, { ok: true });
    }
    if (p === "/dev/catalog") return json(res, 200, catalog);
    if (p === "/dev/report") return json(res, 200, lastReport ?? null);
    return json(res, 404, { error: "unknown dev path" });
  }

  if (Date.now() < downUntil) {
    req.socket.destroy();
    return;
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { error: "bad token" });

  if (p === "/internal/integration/catalog") return json(res, 200, catalog);
  if (p === "/internal/integration/stream") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    streams.add(res);
    req.on("close", () => streams.delete(res));
    send(res, { type: "hello", catalog });
    return;
  }
  if (p === "/internal/integration/report" && req.method === "PUT") {
    lastReport = JSON.parse(await readBody(req));
    console.log(`report ${JSON.stringify(lastReport)}`);
    return json(res, 200, { ok: true });
  }
  let m = /^\/internal\/integration\/scenes\/([^/]+)\/run$/.exec(p);
  if (m && req.method === "POST") {
    const id = decodeURIComponent(m[1]);
    const ok = catalog.scenes.some((s) => s.id === id);
    console.log(`scene ${id}: ${ok ? "ran" : "unknown"}`);
    return json(res, ok ? 200 : 404, ok ? { ok: true, steps: [] } : { error: "no such scene" });
  }
  m = /^\/internal\/integration\/tvs\/([^/]+)\/power$/.exec(p);
  if (m && req.method === "POST") {
    const id = decodeURIComponent(m[1]);
    const { on } = JSON.parse(await readBody(req));
    const tv = catalog.tvs.find((t) => t.id === id);
    const ok = Boolean(tv?.power && tv.online);
    console.log(`tv ${id} ${on ? "on" : "off"}: ${ok ? "ok" : "refused"}`);
    return json(res, 200, { ok });
  }
  json(res, 404, { error: "not found" });
}).listen(PORT, "127.0.0.1", () => console.log(`fake core on http://127.0.0.1:${PORT}`));
