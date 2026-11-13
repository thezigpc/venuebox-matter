import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAllowedPasscode, randomDiscriminator, randomPasscode } from "../src/identity.js";
import { pairingCodes, uniqueIdFor } from "../src/matter.js";
import { buildReport, fabricName } from "../src/report.js";

const window = { qr: "MT:TEST", code: "12345678901", kind: "initial" as const };

describe("report", () => {
  it("not paired: setup, with the QR and code, and only the reset button", () => {
    const r = buildReport({ running: true, fabrics: [], window, scenes: 3, tvs: 2 });
    assert.equal(r.state, "setup");
    assert.equal(r.message, "Not paired yet: scan the code in the Alexa, Google Home or Apple Home app");
    assert.equal(r.pairing?.qr, "MT:TEST");
    assert.equal(r.pairing?.code, "12345678901");
    assert.ok(r.pairing?.note);
    assert.deepEqual(r.actions?.map((a) => a.id), ["reset"]);
    assert.deepEqual(r.details, [
      { label: "Scenes", value: "3" },
      { label: "TVs", value: "2" },
    ]);
  });

  it("paired with 2 apps: ok, lists each fabric and what's exposed, no code", () => {
    const r = buildReport({
      running: true,
      fabrics: [
        { label: "", vendorId: 0x1217 },
        { label: "Google", vendorId: 0x6006 },
      ],
      scenes: 3,
      tvs: 2,
    });
    assert.equal(r.state, "ok");
    assert.equal(r.message, "Paired with 2 apps");
    assert.equal(r.pairing, undefined);
    assert.deepEqual(r.details, [
      { label: "App 1", value: "Amazon Alexa" },
      { label: "App 2", value: "Google" },
      { label: "Scenes", value: "3" },
      { label: "TVs", value: "2" },
    ]);
    assert.deepEqual(r.actions, [
      { id: "pair-another", label: "Pair another app" },
      {
        id: "reset",
        label: "Forget all pairings",
        confirm: "Alexa, Google and Apple Home will lose the box and its scenes.",
      },
    ]);
  });

  it("paired with 1 app (singular)", () => {
    const r = buildReport({ running: true, fabrics: [{ label: "Amazon", vendorId: 1 }], scenes: 0, tvs: 0 });
    assert.equal(r.message, "Paired with 1 app");
  });

  it("pair another: shows the new code and how long it's open", () => {
    const now = 1_000_000;
    const r = buildReport(
      {
        running: true,
        fabrics: [{ label: "Amazon", vendorId: 0x1217 }],
        window: { ...window, kind: "another", closesAt: now + 15 * 60_000 },
        scenes: 1,
        tvs: 0,
      },
      now,
    );
    assert.equal(r.state, "ok");
    assert.match(r.message!, /open for 15 minutes/);
    assert.equal(r.pairing?.code, "12345678901");
  });

  it("stays within the SDK's limits (12 details, 4 actions)", () => {
    const fabrics = Array.from({ length: 20 }, (_, i) => ({ label: `F${i}`, vendorId: 1 }));
    const r = buildReport({ running: true, fabrics, scenes: 1, tvs: 1 });
    assert.ok(r.details!.length <= 12);
    assert.ok(r.actions!.length <= 4);
  });

  it("not running: error with the reason", () => {
    const r = buildReport({ running: false, error: "port 5540 in use", fabrics: [], scenes: 0, tvs: 0 });
    assert.equal(r.state, "error");
    assert.match(r.message!, /5540/);
  });

  it("names fabrics by label, then vendor, then the vendor id", () => {
    assert.equal(fabricName({ label: " Home ", vendorId: 0x1349 }), "Home");
    assert.equal(fabricName({ label: "", vendorId: 0x1349 }), "Apple Home");
    assert.equal(fabricName({ label: "", vendorId: 0x1234 }), "Vendor 0x1234");
  });
});

describe("identity and pairing codes", () => {
  it("never picks a forbidden passcode", () => {
    for (const p of [0, 11111111, 12345678, 87654321, 20202021, 99999999, 100000000]) {
      assert.equal(isAllowedPasscode(p), false, String(p));
    }
    // a "random" source that returns forbidden values first
    const seq = [11111111, 20202021, 12345678, 34567890];
    assert.equal(randomPasscode(() => seq.shift()!), 34567890);
    for (let i = 0; i < 200; i++) {
      assert.ok(isAllowedPasscode(randomPasscode()));
      const d = randomDiscriminator();
      assert.ok(d >= 0 && d < 4096);
    }
  });

  it("builds a Matter QR payload and an 11-digit manual code", () => {
    const { qr, code } = pairingCodes(34567890, 3840);
    assert.match(qr, /^MT:[0-9A-Z.\-]+$/);
    assert.match(code, /^\d{11}$/);
    assert.ok(!qr.includes("34567890") && !code.includes("34567890"));
  });

  it("gives bridged devices a stable 32-char unique id", () => {
    const a = uniqueIdFor("box1", "scene:bingo");
    assert.equal(a.length, 32);
    assert.equal(a, uniqueIdFor("box1", "scene:bingo"));
    assert.notEqual(a, uniqueIdFor("box1", "scene:trivia"));
  });
});
