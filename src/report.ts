import type { IntegrationReport } from "@bargames/sdk";

export interface Fabric {
  label: string;
  vendorId: number;
}

export interface PairingWindow {
  qr: string;
  code: string;
  /** "initial": the box isn't paired yet. "another": multi-admin window from "Pair another app". */
  kind: "initial" | "another";
  /** When the window closes (ms since epoch), if known. */
  closesAt?: number;
}

export interface BridgeStatus {
  /** The Matter node is up (it may still be starting, or failing to). */
  running: boolean;
  error?: string;
  fabrics: Fabric[];
  window?: PairingWindow;
  scenes: number;
  tvs: number;
}

/** Root vendor ids of the big controllers, for fabrics that don't set a label. */
const VENDORS: Record<number, string> = {
  0x1217: "Amazon Alexa",
  0x6006: "Google Home",
  0x1349: "Apple Home",
  0x1384: "Apple Home",
  0x110a: "SmartThings",
  0xfff1: "Test controller",
};

export function fabricName(f: Fabric): string {
  const label = f.label.trim();
  return label || VENDORS[f.vendorId] || `Vendor 0x${f.vendorId.toString(16).toUpperCase().padStart(4, "0")}`;
}

export const PAIR_ANOTHER = { id: "pair-another", label: "Pair another app" } as const;
export const RESET = {
  id: "reset",
  label: "Forget all pairings",
  confirm: "Alexa, Google and Apple Home will lose the box and its scenes.",
} as const;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function minutesLeft(closesAt: number | undefined, now: number): string | undefined {
  if (!closesAt) return undefined;
  const m = Math.max(1, Math.round((closesAt - now) / 60_000));
  return plural(m, "minute");
}

/** What the venue sees on Settings → Smart home. Never contains the passcode on its own. */
export function buildReport(s: BridgeStatus, now = Date.now()): IntegrationReport {
  const exposed = [
    { label: "Scenes", value: String(s.scenes) },
    { label: "TVs", value: String(s.tvs) },
  ];

  if (!s.running) {
    return {
      state: s.error ? "error" : "setup",
      message: s.error ? `Matter isn't running: ${s.error}` : "Starting Matter…",
      details: exposed,
      actions: [RESET],
    };
  }

  if (s.fabrics.length === 0) {
    const r: IntegrationReport = {
      state: "setup",
      message: "Not paired yet: scan the code in the Alexa, Google Home or Apple Home app",
      details: exposed,
      actions: [RESET],
    };
    if (s.window) {
      r.pairing = {
        qr: s.window.qr,
        code: s.window.code,
        note: "In the app, add a Matter device and scan this code, or type the 11-digit code. The app will warn that the device isn't certified: that's expected, choose to continue.",
      };
    } else {
      r.message = "Not paired yet: the pairing window is closed and will reopen shortly";
    }
    return r;
  }

  const details = [
    ...s.fabrics.slice(0, 8).map((f, i) => ({ label: `App ${i + 1}`, value: fabricName(f) })),
    ...exposed,
  ];
  const r: IntegrationReport = {
    state: "ok",
    message: `Paired with ${plural(s.fabrics.length, "app")}`,
    details,
    actions: [PAIR_ANOTHER, RESET],
  };
  if (s.window) {
    const left = minutesLeft(s.window.closesAt, now);
    r.message = `Paired with ${plural(s.fabrics.length, "app")}. Pairing another app is open${left ? ` for ${left}` : ""}`;
    r.pairing = {
      qr: s.window.qr,
      code: s.window.code,
      note: "In the other app, add a Matter device and scan this code, or type the 11-digit code.",
    };
    // Box 0.15.4+ counts down and greys the code out after this, even if we stop reporting.
    if (s.window.closesAt) r.pairing.expiresAt = new Date(s.window.closesAt).toISOString();
  }
  return r;
}
