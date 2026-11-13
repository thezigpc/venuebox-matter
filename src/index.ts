import { mkdirSync } from "node:fs";
import { createIntegration } from "@bargames/sdk/integration";
import type { IntegrationCatalog } from "@bargames/sdk";
import { Bridge } from "./bridge.js";
import { loadIdentity, resetIdentity } from "./identity.js";
import { configureMatterEnvironment, MatterHost } from "./matter.js";
import { Registry } from "./registry.js";
import { buildReport } from "./report.js";

const dataDir = process.env.BG_DATA_DIR || "/data";
mkdirSync(dataDir, { recursive: true });

const log = (msg: string) => console.log(`[matter-bridge] ${msg}`);
configureMatterEnvironment(dataDir);

const box = createIntegration({ onWarn: (m) => log(`box: ${m}`) });
const registry = Registry.inDataDir(dataDir);
let identity = loadIdentity(dataDir);

let bridge: Bridge;
const host = new MatterHost({
  dataDir,
  identity,
  box: registry.state.box ?? { id: "unknown", venue: "" },
  onSwitch: (key, on) => void bridge.onSwitch(key, on),
  onChange: () => scheduleReport(),
  log,
});
bridge = new Bridge(host, box, registry, { log });

// ---- report ------------------------------------------------------------------------------

let connected = false;
let reportTimer: NodeJS.Timeout | undefined;
let lastReport = "";

function scheduleReport(): void {
  if (reportTimer) return;
  reportTimer = setTimeout(() => {
    reportTimer = undefined;
    void sendReport();
  }, 250);
}

async function sendReport(force = false): Promise<void> {
  if (!box.onBox || !connected) return;
  const { scenes, tvs } = bridge.counts();
  const r = buildReport({
    running: host.running,
    error: host.error,
    fabrics: host.fabrics(),
    window: host.window(),
    scenes,
    tvs,
  });
  const json = JSON.stringify(r);
  if (!force && json === lastReport) return;
  try {
    await box.report(r);
    lastReport = json;
  } catch (e) {
    log(`report failed: ${(e as Error).message}`);
  }
}

// Minutes left on the "another app" window: refresh while it's open.
setInterval(() => {
  if (host.window()?.kind === "another") void sendReport();
}, 60_000).unref();

// ---- Matter node -------------------------------------------------------------------------

let starting: Promise<void> | undefined;

async function startMatter(): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await host.start();
      return;
    } catch (e) {
      host.error = (e as Error).message;
      log(`Matter failed to start: ${host.error}`);
      scheduleReport();
      try {
        await host.stop();
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, Math.min(60_000, 2_000 * 2 ** attempt)));
    }
  }
}

function ensureMatter(): Promise<void> {
  starting ??= startMatter();
  return starting;
}

async function onCatalog(catalog: IntegrationCatalog): Promise<void> {
  await host.setBox(catalog.box).catch((e) => log(`node label: ${(e as Error).message}`));
  await bridge.sync(catalog).catch((e) => log(`sync failed: ${(e as Error).message}`));
  // First start ever: wait for the box id (the Matter serial number) before going on the network.
  void ensureMatter();
  scheduleReport();
}

async function onAction(action: string): Promise<void> {
  try {
    if (action === "pair-another") {
      await host.openAnotherWindow();
    } else if (action === "reset") {
      log("forgetting all pairings");
      identity = resetIdentity(dataDir);
      await starting;
      await host.factoryReset(identity);
    }
  } catch (e) {
    log(`${action}: ${(e as Error).message}`);
  }
  await sendReport(true);
}

// ---- main --------------------------------------------------------------------------------

await bridge.restore();
if (registry.state.box) void ensureMatter();

if (!box.onBox) {
  log("BG_CORE_URL isn't set: running without a box (no catalog). Set BG_CORE_URL and BG_GAME_TOKEN.");
}

const stopStream = box.connect({
  onCatalog: (catalog) => void onCatalog(catalog),
  onAction: (id) => void onAction(id),
  onConnection: (up) => {
    if (up !== connected) log(up ? "box connected" : "box connection lost, reconnecting");
    connected = up;
    void bridge.setConnected(up);
    if (up) {
      lastReport = "";
      scheduleReport();
    }
  },
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`${signal}: stopping`);
  stopStream();
  bridge.close();
  try {
    await host.stop();
  } catch (e) {
    log(`stop: ${(e as Error).message}`);
  }
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
