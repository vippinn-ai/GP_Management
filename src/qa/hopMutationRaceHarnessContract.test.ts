import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const spec = fs.readFileSync(path.join(root, "tests/e2e/staging/operational-lifecycle-v2-hop-mutation-races.e2e.ts"), "utf8");

describe("hop mutation race live harness binding", () => {
  it("acknowledges the -15 minute fixture start before race setup", () => {
    const edit = spec.indexOf('browserDateTimeLocal(observer.page, -15)');
    const acknowledged = spec.indexOf('fixtureTimingResponse).status()', edit);
    const competitor = spec.indexOf('const observerManaged = await openManagedSession', acknowledged);
    expect(edit).toBeGreaterThan(-1);
    expect(acknowledged).toBeGreaterThan(edit);
    expect(competitor).toBeGreaterThan(acknowledged);
  });

  it("captures the competing immutable command before preparing the hop", () => {
    const competing = spec.indexOf("const capturedMutation = await mutationCommand.captured");
    const hopDialog = spec.indexOf('const originManaged = await openManagedSession(page, station)', competing);
    const hopCapture = spec.indexOf("const capturedHop = await hopCommand.captured", hopDialog);
    expect(competing).toBeGreaterThan(-1);
    expect(hopDialog).toBeGreaterThan(competing);
    expect(hopCapture).toBeGreaterThan(hopDialog);
    expect(spec.slice(hopCapture, spec.indexOf("const hopResponse", hopCapture))).toContain("Promise.all");
    expect(spec).toContain("validateCapturedHopEnd({");
    expect(spec).not.toContain('getByLabel("Session End Time", { exact: true }).fill');
    const lastRead = spec.lastIndexOf("readRestRows", competing);
    expect(lastRead).toBeLessThan(competing);
    expect(spec.slice(competing, spec.indexOf("const submissions", competing))).not.toContain("readRestRows");
    expect(spec).toContain("toBeLessThanOrEqual(12_000)");
  });

  it("records sanitized two-response evidence before outcome assertions", () => {
    const evidence = spec.indexOf('`operational-v2-hop-mutation-${kind}-responses`');
    const assertion = spec.indexOf("hop must commit exactly once", evidence);
    expect(evidence).toBeGreaterThan(-1);
    expect(assertion).toBeGreaterThan(evidence);
    expect(spec).toContain('`operational-v2-hop-mutation-${kind}-transport-failure`');
    const safeResponse = spec.slice(spec.indexOf("function safeResponseEvidence"), spec.indexOf("async function timedSubmit"));
    expect(safeResponse).not.toMatch(/headers|message/);
    expect(safeResponse).toContain("eventId");
    expect(safeResponse).toContain("rejectionCode");
  });

  it("uses exact captured item identities and exact set deltas", () => {
    expect(spec).toContain("capturedItemId(kind, mutationParts.payload)");
    expect(spec).toContain("exactItemDelta(itemsBeforeRace.map((row) => row.id), itemsAfterBill.map((row) => row.id))");
    expect(spec).toContain('row.id === `line-item-${itemId}`');
    expect(spec).not.toContain("attemptedItemName");
    expect(spec).not.toContain("row.description === attemptedItemName");
  });
});
