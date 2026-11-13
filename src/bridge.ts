import type { IntegrationCatalog } from "@bargames/sdk";
import { desiredDevices, type DesiredDevice, type DeviceKind, Registry } from "./registry.js";

/** How the bridge talks to the Matter side (matter.js in production, a fake in tests). */
export interface DeviceHost {
  add(d: { key: string; number: number; kind: DeviceKind; name: string; reachable: boolean }): Promise<void>;
  update(key: string, patch: { name?: string; reachable?: boolean }): Promise<void>;
  remove(key: string): Promise<void>;
  /** Sets the switch's on/off state from our side (no command is sent to the box). */
  setOn(key: string, on: boolean): Promise<void>;
}

/** How the bridge talks to the box. */
export interface BoxActions {
  runScene(id: string): Promise<{ ok: boolean }>;
  tvPower(id: string, on: boolean): Promise<{ ok: boolean }>;
}

export interface BridgeOptions {
  /** How long a scene switch stays on before it switches itself back off. */
  momentaryMs?: number;
  log?: (msg: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

interface Live extends DesiredDevice {
  number: number;
  reachable: boolean;
  on: boolean;
}

/**
 * Keeps the Matter bridge's devices in line with the box catalog, and turns switch changes
 * into box calls. Pure logic: it knows nothing about matter.js.
 */
export class Bridge {
  readonly devices = new Map<string, Live>();
  private connected = false;
  private readonly timers = new Map<string, unknown>();
  /** Keys whose next state change came from us, not from a controller. */
  private readonly ours = new Map<string, boolean>();
  private queue: Promise<void> = Promise.resolve();
  private readonly momentaryMs: number;
  private readonly log: (msg: string) => void;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(
    private readonly host: DeviceHost,
    private readonly box: BoxActions,
    readonly registry: Registry,
    opts: BridgeOptions = {},
  ) {
    this.momentaryMs = opts.momentaryMs ?? 2000;
    this.log = opts.log ?? (() => {});
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  }

  /** Serializes structural changes so a burst of catalogs can't interleave. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  counts(): { scenes: number; tvs: number } {
    let scenes = 0;
    let tvs = 0;
    for (const d of this.devices.values()) d.kind === "scene" ? scenes++ : tvs++;
    return { scenes, tvs };
  }

  /** Adds what /data remembers, unreachable, before the box connects (or the node starts). */
  restore(): Promise<void> {
    return this.serial(async () => {
      for (const d of this.registry.remembered()) {
        if (this.devices.has(d.key)) continue;
        await this.host.add({ key: d.key, number: d.number, kind: d.kind, name: d.name, reachable: false });
        this.devices.set(d.key, { ...d, reachable: false, on: false });
      }
    });
  }

  /** On every catalog: add, rename and remove endpoints to match, and refresh reachability. */
  sync(catalog: IntegrationCatalog): Promise<void> {
    return this.serial(async () => {
      this.registry.setBox(catalog.box);
      const want = desiredDevices(catalog);
      const wantKeys = new Set(want.map((d) => d.key));

      for (const [key] of this.devices) {
        if (wantKeys.has(key)) continue;
        this.cancelTimer(key);
        await this.host.remove(key);
        this.devices.delete(key);
        this.registry.remove(key);
        this.log(`removed ${key}`);
      }
      // A remembered device that never made it into `devices` (shouldn't happen) is dropped too.
      for (const key of Object.keys(this.registry.state.devices)) {
        if (!wantKeys.has(key) && !this.devices.has(key)) this.registry.remove(key);
      }

      for (const d of want) {
        const reachable = this.connected && d.online;
        const live = this.devices.get(d.key);
        if (!live) {
          const number = this.registry.numberFor(d);
          await this.host.add({ key: d.key, number, kind: d.kind, name: d.name, reachable });
          this.devices.set(d.key, { ...d, number, reachable, on: false });
          this.log(`added ${d.key} as endpoint ${number}`);
          continue;
        }
        const patch: { name?: string; reachable?: boolean } = {};
        if (live.name !== d.name) patch.name = d.name;
        if (live.reachable !== reachable) patch.reachable = reachable;
        live.online = d.online;
        if (patch.name !== undefined || patch.reachable !== undefined) {
          await this.host.update(d.key, patch);
          if (patch.name !== undefined) {
            live.name = d.name;
            this.registry.rename(d.key, d.name);
          }
          if (patch.reachable !== undefined) live.reachable = reachable;
        }
      }
      this.registry.save();
    });
  }

  /** The box stream went down (false) or came back (true). The Matter node keeps running. */
  setConnected(up: boolean): Promise<void> {
    this.connected = up;
    return this.serial(async () => {
      for (const d of this.devices.values()) {
        const reachable = up && d.online;
        if (d.reachable === reachable) continue;
        d.reachable = reachable;
        await this.host.update(d.key, { reachable });
      }
    });
  }

  /** A controller (or we) changed a switch. Called by the host for every on/off change. */
  async onSwitch(key: string, on: boolean): Promise<void> {
    const d = this.devices.get(key);
    if (!d) return;
    const mine = this.ours.get(key);
    if (mine !== undefined && mine === on) {
      this.ours.delete(key);
      d.on = on;
      return;
    }
    d.on = on;
    if (d.kind === "scene") return this.sceneSwitch(d, on);
    return this.tvSwitch(d, on);
  }

  private async sceneSwitch(d: Live, on: boolean): Promise<void> {
    if (!on) {
      this.cancelTimer(d.key);
      return;
    }
    // Momentary: back off after a moment, whatever the scene's result, so it can be used again.
    this.cancelTimer(d.key);
    this.timers.set(
      d.key,
      this.setTimer(() => {
        this.timers.delete(d.key);
        void this.setOwn(d.key, false);
      }, this.momentaryMs),
    );
    try {
      const r = await this.box.runScene(d.ref);
      this.log(`scene ${d.ref}: ${r.ok ? "ran" : "failed"}`);
    } catch (e) {
      this.log(`scene ${d.ref}: ${(e as Error).message}`);
    }
  }

  private async tvSwitch(d: Live, on: boolean): Promise<void> {
    let ok = false;
    try {
      ok = (await this.box.tvPower(d.ref, on)).ok;
    } catch (e) {
      this.log(`tv ${d.ref}: ${(e as Error).message}`);
    }
    this.log(`tv ${d.ref} ${on ? "on" : "off"}: ${ok ? "ok" : "failed"}`);
    // Optimistic: the box can't read a TV's power, so a success leaves the switch where the
    // controller put it. A refusal puts it back, so the app shows it didn't happen.
    if (!ok) await this.setOwn(d.key, !on);
  }

  private async setOwn(key: string, on: boolean): Promise<void> {
    const d = this.devices.get(key);
    if (!d || d.on === on) return;
    this.ours.set(key, on);
    d.on = on;
    try {
      await this.host.setOn(key, on);
    } catch (e) {
      this.ours.delete(key);
      this.log(`set ${key}: ${(e as Error).message}`);
    }
  }

  private cancelTimer(key: string): void {
    const t = this.timers.get(key);
    if (t !== undefined) {
      this.clearTimer(t);
      this.timers.delete(key);
    }
  }

  close(): void {
    for (const key of [...this.timers.keys()]) this.cancelTimer(key);
  }
}
