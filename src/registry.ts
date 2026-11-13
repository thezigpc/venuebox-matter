import { join } from "node:path";
import type { IntegrationCatalog } from "@bargames/sdk";
import { readJson, writeJson } from "./store.js";

export type DeviceKind = "scene" | "tv";

/** One switch the bridge exposes, as derived from the box catalog. */
export interface DesiredDevice {
  /** "scene:<id>" or "tv:<id>": stable across restarts and the key for the endpoint number. */
  key: string;
  kind: DeviceKind;
  /** The scene or TV id on the box. */
  ref: string;
  name: string;
  /** For TVs, the catalog's `online`. Scenes are always online while the box is connected. */
  online: boolean;
}

/** What /data remembers about a device, so it comes back before the box does. */
export interface StoredDevice {
  number: number;
  kind: DeviceKind;
  ref: string;
  name: string;
}

export interface RegistryState {
  /** The next endpoint number to hand out. Numbers are never reused for another device. */
  next: number;
  devices: Record<string, StoredDevice>;
  /** The box as last seen (serial number and venue name), so the node can start offline. */
  box?: { id: string; venue: string };
}

/** Root is endpoint 0 and the aggregator 1, so bridged devices start at 2. */
export const FIRST_ENDPOINT = 2;

/** Matter's limit for NodeLabel and other names. */
export const MAX_NAME = 32;

export function clipName(name: string): string {
  const n = name.trim().replace(/\s+/g, " ") || "Unnamed";
  return [...n].length <= MAX_NAME ? n : [...n].slice(0, MAX_NAME).join("").trimEnd();
}

/** The switches the catalog asks for: every scene, and every TV the box can switch. */
export function desiredDevices(catalog: IntegrationCatalog): DesiredDevice[] {
  const out: DesiredDevice[] = [];
  for (const s of catalog.scenes ?? []) {
    out.push({ key: `scene:${s.id}`, kind: "scene", ref: s.id, name: clipName(s.name), online: true });
  }
  for (const t of catalog.tvs ?? []) {
    if (!t.power) continue;
    out.push({ key: `tv:${t.id}`, kind: "tv", ref: t.id, name: clipName(t.name), online: t.online });
  }
  return out;
}

/**
 * Keeps endpoint numbers stable per scene / TV id, in /data, so Alexa, Google and Apple Home
 * keep their devices and routines across restarts and updates.
 */
export class Registry {
  state: RegistryState;

  constructor(private readonly file?: string) {
    const stored = file ? readJson<RegistryState>(file) : undefined;
    this.state =
      stored && typeof stored.next === "number" && stored.devices
        ? stored
        : { next: FIRST_ENDPOINT, devices: {} };
  }

  static inDataDir(dataDir: string): Registry {
    return new Registry(join(dataDir, "bridge.json"));
  }

  /** The endpoint number for a key, allocating (and saving) a new one if needed. */
  numberFor(d: DesiredDevice): number {
    const existing = this.state.devices[d.key];
    if (existing) return existing.number;
    const number = this.state.next++;
    this.state.devices[d.key] = { number, kind: d.kind, ref: d.ref, name: d.name };
    return number;
  }

  rename(key: string, name: string): void {
    const d = this.state.devices[key];
    if (d) d.name = name;
  }

  remove(key: string): void {
    delete this.state.devices[key];
  }

  setBox(box: { id: string; venue: string }): void {
    this.state.box = { id: box.id, venue: box.venue };
  }

  save(): void {
    if (this.file) writeJson(this.file, this.state);
  }

  /** Everything remembered, as offline devices, for start-up before the box connects. */
  remembered(): (DesiredDevice & { number: number })[] {
    return Object.entries(this.state.devices)
      .map(([key, d]) => ({ key, kind: d.kind, ref: d.ref, name: d.name, online: false, number: d.number }))
      .sort((a, b) => a.number - b.number);
  }
}
