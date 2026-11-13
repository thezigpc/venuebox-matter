import { createHash, randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Endpoint, Environment, Logger, ServerNode, VendorId } from "@matter/main";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import { CommissioningServer } from "@matter/main/node";
import { OnOffPlugInUnitDevice } from "@matter/main/devices/on-off-plug-in-unit";
import { AggregatorEndpoint } from "@matter/main/endpoints/aggregator";
import { DeviceCommissioner, PaseServer, SessionManager } from "@matter/main/protocol";
import {
  CommissioningFlowType,
  DiscoveryCapabilitiesSchema,
  ManualPairingCodeCodec,
  QrPairingCodeCodec,
} from "@matter/main/types";
import { AdministratorCommissioning } from "@matter/main/clusters/administrator-commissioning";
import type { DeviceHost } from "./bridge.js";
import { randomDiscriminator, randomPasscode, type Identity } from "./identity.js";
import type { DeviceKind } from "./registry.js";
import type { Fabric, PairingWindow } from "./report.js";

export const VENDOR_ID = 0xfff1; // test vendor id: uncertified device
export const PRODUCT_ID = 0x8000; // test product id
export const PRODUCT_NAME = "Bar Games box";
export const VENDOR_NAME = "Bar Games";
export const MATTER_PORT = 5540;
/** "Pair another app": how long the multi-admin window stays open. */
export const ANOTHER_WINDOW_MS = 15 * 60_000;

/**
 * matter.js logs the passcode, discriminator and pairing codes when the node is uncommissioned.
 * We show the codes on the box's Smart home page instead, and never log them.
 */
class QuietCommissioningServer extends CommissioningServer {
  protected override initiateCommissioning(): void {}
}

const BridgeRoot = ServerNode.RootEndpoint.with(QuietCommissioningServer);
const BridgedSwitch = OnOffPlugInUnitDevice.with(BridgedDeviceBasicInformationServer);

interface Spec {
  key: string;
  number: number;
  kind: DeviceKind;
  name: string;
  reachable: boolean;
  on: boolean;
}

export interface MatterHostOptions {
  dataDir: string;
  identity: Identity;
  box: { id: string; venue: string };
  /** A controller (or we) changed a switch. */
  onSwitch: (key: string, on: boolean) => void;
  /** Fabrics or the pairing window changed: send a new report. */
  onChange: () => void;
  log: (msg: string) => void;
}

/** Bridged devices need a stable unique id (max 32 chars) that survives renames. */
export function uniqueIdFor(boxId: string, key: string): string {
  return createHash("sha256").update(`${boxId}\n${key}`).digest("hex").slice(0, 32);
}

export function configureMatterEnvironment(dataDir: string): void {
  const env = Environment.default;
  const root = join(dataDir, "matter");
  env.vars.set("path.root", root);
  env.vars.set("storage.path", root);
  env.vars.set("runtime.signals", false); // we handle SIGTERM ourselves
  env.vars.set("runtime.exitcode", false);
  Logger.level = (process.env.MATTER_LOG_LEVEL as string | undefined) ?? "notice";
}

/** Builds the onboarding payloads for a given passcode / discriminator. */
export function pairingCodes(passcode: number, discriminator: number): { qr: string; code: string } {
  const qr = QrPairingCodeCodec.encode([
    {
      version: 0,
      vendorId: VENDOR_ID,
      productId: PRODUCT_ID,
      flowType: CommissioningFlowType.Standard,
      discriminator,
      passcode,
      discoveryCapabilities: DiscoveryCapabilitiesSchema.encode({ onIpNetwork: true }),
    },
  ]);
  const code = ManualPairingCodeCodec.encode({ discriminator, passcode, flowType: CommissioningFlowType.Standard });
  return { qr, code };
}

/**
 * The Matter side: one ServerNode with an Aggregator, and an On/Off Plug-in Unit per scene and
 * switchable TV. Implements DeviceHost for the Bridge.
 */
export class MatterHost implements DeviceHost {
  private node?: ServerNode<typeof BridgeRoot>;
  private aggregator?: Endpoint<AggregatorEndpoint>;
  private readonly endpoints = new Map<string, Endpoint<typeof BridgedSwitch>>();
  private readonly specs = new Map<string, Spec>();
  private another?: PairingWindow;
  private windowTimer?: NodeJS.Timeout;
  private watchdog?: NodeJS.Timeout;
  private identity: Identity;
  private box: { id: string; venue: string };
  running = false;
  error?: string;

  constructor(private readonly opts: MatterHostOptions) {
    this.identity = opts.identity;
    this.box = opts.box;
  }

  // ---- lifecycle -------------------------------------------------------------------------

  async start(): Promise<void> {
    const { log } = this.opts;
    const node = await ServerNode.create(BridgeRoot, {
      id: "venuebox",
      network: { port: MATTER_PORT },
      commissioning: { passcode: this.identity.passcode, discriminator: this.identity.discriminator },
      productDescription: { name: PRODUCT_NAME, deviceType: AggregatorEndpoint.deviceType },
      basicInformation: {
        vendorName: VENDOR_NAME,
        vendorId: VendorId(VENDOR_ID),
        productName: PRODUCT_NAME,
        productLabel: "Venue box", // matter.js warns when the label repeats the vendor name
        productId: PRODUCT_ID,
        nodeLabel: clip(this.box.venue || PRODUCT_NAME),
        serialNumber: clip(this.box.id),
        uniqueId: uniqueIdFor(this.box.id, "node"),
        hardwareVersion: 1,
        softwareVersion: 1,
        softwareVersionString: "0.1.0",
      },
    });
    const aggregator = new Endpoint(AggregatorEndpoint, { id: "bridge", number: 1 });
    await node.add(aggregator);
    this.node = node;
    this.aggregator = aggregator;

    for (const spec of [...this.specs.values()].sort((a, b) => a.number - b.number)) await this.addEndpoint(spec);

    node.events.commissioning.fabricsChanged.on((_index, action) => {
      log(`pairing ${action}`);
      // A new fabric from the "another" window closes it (Matter does that itself).
      if (action === "added" && this.another) this.closeAnother();
      this.opts.onChange();
    });
    node.events.commissioning.commissioned.on(() => this.opts.onChange());
    node.events.commissioning.decommissioned.on(() => this.opts.onChange());

    await node.start();
    // A scene switch persisted as "on" (the process stopped mid-pulse) would be stuck on.
    for (const [key, ep] of this.endpoints) {
      if (this.specs.get(key)?.kind === "scene" && ep.state.onOff.onOff) await ep.set({ onOff: { onOff: false } });
    }
    this.running = true;
    this.error = undefined;
    log(`Matter node running on UDP ${MATTER_PORT}, ${this.endpoints.size} bridged devices`);

    // An unpaired node's window closes after a while; keep it open until someone pairs.
    this.watchdog = setInterval(() => void this.keepInitialWindowOpen(), 60_000);
    this.watchdog.unref();
    this.opts.onChange();
  }

  async stop(): Promise<void> {
    if (this.watchdog) clearInterval(this.watchdog);
    this.closeAnother(false);
    this.running = false;
    const node = this.node;
    this.node = undefined;
    this.aggregator = undefined;
    this.endpoints.clear();
    if (node) await node.close();
  }

  /** "Forget all pairings": wipe Matter's storage, new passcode, start again. */
  async factoryReset(identity: Identity): Promise<void> {
    await this.stop();
    await rm(join(this.opts.dataDir, "matter"), { recursive: true, force: true });
    this.identity = identity;
    for (const s of this.specs.values()) s.on = false;
    await this.start();
  }

  // ---- what the report needs ---------------------------------------------------------------

  fabrics(): Fabric[] {
    if (!this.node || !this.running) return [];
    const all = this.node.state.commissioning.fabrics ?? {};
    return Object.values(all).map((f) => ({ label: f.label ?? "", vendorId: Number(f.rootVendorId) }));
  }

  /** The open window's codes: the original ones while unpaired, or a fresh multi-admin one. */
  window(): PairingWindow | undefined {
    if (!this.node || !this.running) return undefined;
    if (this.fabrics().length === 0) {
      if (this.commissioner()?.windowStatus === AdministratorCommissioning.CommissioningWindowStatus.WindowNotOpen) {
        return undefined;
      }
      return { ...pairingCodes(this.identity.passcode, this.identity.discriminator), kind: "initial" };
    }
    return this.another;
  }

  private commissioner(): DeviceCommissioner | undefined {
    try {
      return this.node?.env.get(DeviceCommissioner);
    } catch {
      return undefined;
    }
  }

  private async keepInitialWindowOpen(): Promise<void> {
    const node = this.node;
    if (!node || !this.running || this.fabrics().length > 0) return;
    if (this.commissioner()?.windowStatus !== AdministratorCommissioning.CommissioningWindowStatus.WindowNotOpen) return;
    try {
      await node.act((agent) => agent.get(QuietCommissioningServer).enterCommissionableMode());
      this.opts.log("pairing window reopened");
      this.opts.onChange();
    } catch (e) {
      this.opts.log(`couldn't reopen the pairing window: ${(e as Error).message}`);
    }
  }

  /**
   * "Pair another app": an Enhanced Commissioning Window with a fresh, one-off passcode and
   * discriminator (Matter multi-admin), open for about 15 minutes.
   */
  async openAnotherWindow(): Promise<void> {
    const node = this.node;
    if (!node || !this.running) throw new Error("Matter isn't running");
    if (this.fabrics().length === 0) throw new Error("not paired yet: use the code on the page");
    const commissioner = node.env.get(DeviceCommissioner);
    if (commissioner.isAdministratorWindowOpen) {
      if (this.another) return; // already open: keep showing the same code
      throw new Error("a paired app has a pairing window open right now; try again in a few minutes");
    }
    const passcode = randomPasscode();
    const discriminator = randomDiscriminator();
    const pase = await PaseServer.fromPin(node.env.get(SessionManager), passcode, {
      iterations: 1000,
      salt: new Uint8Array(randomBytes(32)),
    });
    await commissioner.allowEnhancedCommissioning(discriminator, pase, {
      timeout: ANOTHER_WINDOW_MS as never,
      byAdministrator: true,
      onClose: () => this.closeAnother(),
    });
    const closesAt = Date.now() + ANOTHER_WINDOW_MS;
    this.another = { ...pairingCodes(passcode, discriminator), kind: "another", closesAt };
    // Belt and braces: drop the code from the report when the window should be gone.
    this.windowTimer = setTimeout(() => this.closeAnother(), ANOTHER_WINDOW_MS + 5_000);
    this.windowTimer.unref();
    this.opts.log("pairing window for another app opened for 15 minutes");
    this.opts.onChange();
  }

  private closeAnother(notify = true): void {
    if (this.windowTimer) clearTimeout(this.windowTimer);
    this.windowTimer = undefined;
    if (!this.another) return;
    this.another = undefined;
    this.opts.log("pairing window for another app closed");
    if (notify) this.opts.onChange();
  }

  /** The venue was renamed (or the box id learned): the node label follows. */
  async setBox(box: { id: string; venue: string }): Promise<void> {
    const changed = box.venue !== this.box.venue || box.id !== this.box.id;
    this.box = { id: box.id, venue: box.venue };
    if (!changed || !this.node) return;
    await this.node.set({
      basicInformation: { nodeLabel: clip(box.venue || PRODUCT_NAME), serialNumber: clip(box.id) },
    } as never);
  }

  // ---- DeviceHost --------------------------------------------------------------------------

  async add(d: { key: string; number: number; kind: DeviceKind; name: string; reachable: boolean }): Promise<void> {
    const spec: Spec = { ...d, on: false };
    this.specs.set(d.key, spec);
    if (this.aggregator) await this.addEndpoint(spec);
  }

  private async addEndpoint(spec: Spec): Promise<void> {
    const endpoint = new Endpoint(BridgedSwitch, {
      id: `ep${spec.number}`,
      number: spec.number,
      bridgedDeviceBasicInformation: {
        nodeLabel: spec.name,
        productName: spec.kind === "scene" ? "Scene" : "TV",
        vendorName: VENDOR_NAME,
        reachable: spec.reachable,
        uniqueId: uniqueIdFor(this.box.id, spec.key),
      },
      onOff: { onOff: spec.on },
    });
    await this.aggregator!.add(endpoint);
    this.endpoints.set(spec.key, endpoint);
    // A persisted "on" from before a restart would leave a scene stuck on.
    if (spec.kind === "scene" && endpoint.state.onOff.onOff) await endpoint.set({ onOff: { onOff: false } });
    endpoint.events.onOff.onOff$Changed.on((value) => {
      spec.on = value;
      this.opts.onSwitch(spec.key, value);
    });
  }

  async update(key: string, patch: { name?: string; reachable?: boolean }): Promise<void> {
    const spec = this.specs.get(key);
    if (!spec) return;
    if (patch.name !== undefined) spec.name = patch.name;
    if (patch.reachable !== undefined) spec.reachable = patch.reachable;
    const ep = this.endpoints.get(key);
    if (!ep) return;
    const info: { nodeLabel?: string; reachable?: boolean } = {};
    if (patch.name !== undefined) info.nodeLabel = patch.name;
    if (patch.reachable !== undefined) info.reachable = patch.reachable;
    await ep.set({ bridgedDeviceBasicInformation: info });
  }

  async remove(key: string): Promise<void> {
    this.specs.delete(key);
    const ep = this.endpoints.get(key);
    this.endpoints.delete(key);
    if (ep) await ep.delete();
  }

  async setOn(key: string, on: boolean): Promise<void> {
    const spec = this.specs.get(key);
    if (spec) spec.on = on;
    const ep = this.endpoints.get(key);
    if (ep) await ep.set({ onOff: { onOff: on } });
  }
}

function clip(s: string): string {
  return [...s].slice(0, 32).join("");
}
