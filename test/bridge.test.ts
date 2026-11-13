import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { IntegrationCatalog } from "@bargames/sdk";
import { Bridge, type DeviceHost } from "../src/bridge.js";
import { Registry } from "../src/registry.js";

type Call = [string, ...unknown[]];

/** A DeviceHost that records calls and echoes setOn back like matter.js does. */
class FakeHost implements DeviceHost {
  calls: Call[] = [];
  bridge?: Bridge;
  async add(d: { key: string; number: number; name: string; reachable: boolean }) {
    this.calls.push(["add", d.key, d.number, d.name, d.reachable]);
  }
  async update(key: string, patch: object) {
    this.calls.push(["update", key, patch]);
  }
  async remove(key: string) {
    this.calls.push(["remove", key]);
  }
  async setOn(key: string, on: boolean) {
    this.calls.push(["setOn", key, on]);
    await this.bridge?.onSwitch(key, on); // matter.js fires onOff$Changed for our own writes too
  }
}

class FakeBox {
  calls: Call[] = [];
  tvOk = true;
  async runScene(id: string) {
    this.calls.push(["runScene", id]);
    return { ok: true };
  }
  async tvPower(id: string, on: boolean) {
    this.calls.push(["tvPower", id, on]);
    return { ok: this.tvOk };
  }
}

class FakeTimers {
  pending = new Map<number, () => void>();
  delays: number[] = [];
  private id = 0;
  set = (fn: () => void, ms: number) => {
    this.delays.push(ms);
    this.pending.set(++this.id, fn);
    return this.id;
  };
  clear = (t: unknown) => void this.pending.delete(t as number);
  fireAll() {
    const fns = [...this.pending.values()];
    this.pending.clear();
    fns.forEach((f) => f());
  }
}

const catalog = (over: Partial<IntegrationCatalog> = {}): IntegrationCatalog => ({
  box: { id: "box1", version: "1", venue: "Venue" },
  permissions: ["scenes", "tvs", "lan"],
  scenes: [
    { id: "bingo-night", name: "Bingo Night" },
    { id: "last-call", name: "Last call" },
  ],
  tvs: [
    { id: "roku:bar", name: "Bar", online: true, power: true },
    { id: "roku:patio", name: "Patio", online: false, power: true },
    { id: "airplay:lounge", name: "Lounge", online: true, power: false },
  ],
  ...over,
});

function setup(file?: string) {
  const host = new FakeHost();
  const box = new FakeBox();
  const timers = new FakeTimers();
  const registry = new Registry(file);
  const bridge = new Bridge(host, box, registry, { setTimer: timers.set, clearTimer: timers.clear });
  host.bridge = bridge;
  return { host, box, timers, registry, bridge };
}

const tick = () => new Promise((r) => setImmediate(r));

describe("catalog → endpoints", () => {
  it("adds a switch per scene and per switchable TV, skipping TVs without power control", async () => {
    const { host, bridge } = setup();
    await bridge.setConnected(true);
    await bridge.sync(catalog());
    assert.deepEqual(host.calls, [
      ["add", "scene:bingo-night", 2, "Bingo Night", true],
      ["add", "scene:last-call", 3, "Last call", true],
      ["add", "tv:roku:bar", 4, "Bar", true],
      ["add", "tv:roku:patio", 5, "Patio", false], // offline TV: unreachable
    ]);
    assert.deepEqual(bridge.counts(), { scenes: 2, tvs: 2 });
  });

  it("renames, removes and adds to match a changed catalog", async () => {
    const { host, bridge } = setup();
    await bridge.setConnected(true);
    await bridge.sync(catalog());
    host.calls = [];
    await bridge.sync(
      catalog({
        scenes: [
          { id: "bingo-night", name: "Bingo Night!" },
          { id: "trivia", name: "Trivia" },
        ],
      }),
    );
    assert.deepEqual(host.calls, [
      ["remove", "scene:last-call"],
      ["update", "scene:bingo-night", { name: "Bingo Night!" }],
      ["add", "scene:trivia", 6, "Trivia", true], // 3 is retired, not reused
    ]);
  });

  it("follows a TV going online and offline", async () => {
    const { host, bridge } = setup();
    await bridge.setConnected(true);
    await bridge.sync(catalog());
    host.calls = [];
    const c = catalog();
    c.tvs![1].online = true;
    await bridge.sync(c);
    assert.deepEqual(host.calls, [["update", "tv:roku:patio", { reachable: true }]]);
  });

  it("treats a TV whose id changed (new driver) as a new device", async () => {
    const { host, bridge } = setup();
    await bridge.setConnected(true);
    await bridge.sync(catalog());
    host.calls = [];
    const c = catalog();
    c.tvs![0].id = "vizio:bar";
    await bridge.sync(c);
    assert.deepEqual(host.calls, [
      ["remove", "tv:roku:bar"],
      ["add", "tv:vizio:bar", 6, "Bar", true],
    ]);
  });

  it("clips names to Matter's 32 characters", async () => {
    const { host, bridge } = setup();
    await bridge.sync(catalog({ scenes: [{ id: "x", name: "A".repeat(40) }], tvs: [] }));
    assert.equal((host.calls[0][3] as string).length, 32);
  });
});

describe("stable endpoint numbers", () => {
  it("keeps numbers across restarts, and restores devices unreachable before the box connects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vbm-"));
    const file = join(dir, "bridge.json");
    const first = setup(file);
    await first.bridge.setConnected(true);
    await first.bridge.sync(catalog());
    await first.bridge.sync(catalog({ scenes: [{ id: "last-call", name: "Last call" }] })); // bingo removed

    const second = setup(file);
    await second.bridge.restore();
    assert.deepEqual(second.host.calls, [
      ["add", "scene:last-call", 3, "Last call", false],
      ["add", "tv:roku:bar", 4, "Bar", false],
      ["add", "tv:roku:patio", 5, "Patio", false],
    ]);
    assert.deepEqual(second.registry.state.box, { id: "box1", venue: "Venue" });

    second.host.calls = [];
    await second.bridge.setConnected(true);
    await second.bridge.sync(catalog()); // bingo is back: a new number, never 2 again
    assert.deepEqual(second.host.calls, [
      // restored devices stay unreachable until the catalog confirms them; then bingo comes
      // back under a new number, and the others become reachable
      ["add", "scene:bingo-night", 6, "Bingo Night", true],
      ["update", "scene:last-call", { reachable: true }],
      ["update", "tv:roku:bar", { reachable: true }],
    ]);
    assert.equal(second.registry.state.devices["scene:bingo-night"].number, 6);
    assert.equal(second.registry.state.devices["scene:last-call"].number, 3);
    assert.equal(second.registry.state.devices["tv:roku:bar"].number, 4);
  });
});

describe("box connection", () => {
  it("marks everything unreachable while the box is gone, and back when it returns", async () => {
    const { host, bridge } = setup();
    await bridge.setConnected(true);
    await bridge.sync(catalog());
    host.calls = [];
    await bridge.setConnected(false);
    assert.deepEqual(host.calls, [
      ["update", "scene:bingo-night", { reachable: false }],
      ["update", "scene:last-call", { reachable: false }],
      ["update", "tv:roku:bar", { reachable: false }],
      // patio was already unreachable (offline)
    ]);
    host.calls = [];
    await bridge.setConnected(true);
    assert.deepEqual(host.calls, [
      ["update", "scene:bingo-night", { reachable: true }],
      ["update", "scene:last-call", { reachable: true }],
      ["update", "tv:roku:bar", { reachable: true }],
    ]);
  });
});

describe("momentary scene switches", () => {
  it("runs the scene on 'on' and switches itself off about 2 s later", async () => {
    const { host, box, timers, bridge } = setup();
    await bridge.setConnected(true);
    await bridge.sync(catalog());
    host.calls = [];
    await bridge.onSwitch("scene:bingo-night", true);
    assert.deepEqual(box.calls, [["runScene", "bingo-night"]]);
    assert.deepEqual(timers.delays, [2000]);
    timers.fireAll();
    await tick();
    assert.deepEqual(host.calls, [["setOn", "scene:bingo-night", false]]);
    // our own "off" did not run anything
    assert.deepEqual(box.calls, [["runScene", "bingo-night"]]);
    // and it can be used again
    await bridge.onSwitch("scene:bingo-night", true);
    assert.deepEqual(box.calls, [
      ["runScene", "bingo-night"],
      ["runScene", "bingo-night"],
    ]);
  });

  it("'off' from a controller does nothing on the box and cancels the pending reset", async () => {
    const { host, box, timers, bridge } = setup();
    await bridge.sync(catalog());
    await bridge.onSwitch("scene:last-call", true);
    await bridge.onSwitch("scene:last-call", false);
    assert.equal(timers.pending.size, 0);
    assert.deepEqual(box.calls, [["runScene", "last-call"]]);
    assert.ok(!host.calls.some((c) => c[0] === "setOn"));
  });
});

describe("TV switches", () => {
  it("calls tvPower and stays where the controller put it (optimistic)", async () => {
    const { host, box, bridge } = setup();
    await bridge.sync(catalog());
    host.calls = [];
    await bridge.onSwitch("tv:roku:bar", true);
    await bridge.onSwitch("tv:roku:bar", false);
    assert.deepEqual(box.calls, [
      ["tvPower", "roku:bar", true],
      ["tvPower", "roku:bar", false],
    ]);
    assert.deepEqual(host.calls, []);
  });

  it("puts the switch back when the box refuses", async () => {
    const { host, box, bridge } = setup();
    await bridge.sync(catalog());
    host.calls = [];
    box.tvOk = false;
    await bridge.onSwitch("tv:roku:patio", true);
    assert.deepEqual(host.calls, [["setOn", "tv:roku:patio", false]]);
    assert.deepEqual(box.calls, [["tvPower", "roku:patio", true]]); // the revert isn't sent to the box
  });

  it("ignores switches it doesn't know", async () => {
    const { box, bridge } = setup();
    await bridge.onSwitch("tv:nope", true);
    assert.deepEqual(box.calls, []);
  });
});
