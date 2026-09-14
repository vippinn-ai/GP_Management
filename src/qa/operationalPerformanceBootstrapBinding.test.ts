import { describe, expect, it } from "vitest";
import { assertBootstrapPerformanceBinding } from "../../scripts/operational-performance-bootstrap-binding.mjs";

const projectRef = "tkbdyzxwwbhkpztgjjxh";
const appStateBefore = {
  version: 735,
  bytes: 4_800_000,
  md5: "0123456789abcdef0123456789abcdef",
  updated_at: "2026-09-14T08:00:00.000000+00:00",
  updated_by: "00000000-0000-4000-8000-000000000001"
};
const appStateAfter = {
  version: 736,
  bytes: 4_886_227,
  md5: "23a110924286b34e0a559aee0996fce4",
  updated_at: "2026-09-14T08:01:00.000000+00:00",
  updated_by: "00000000-0000-4000-8000-000000000002"
};

function fixture() {
  const manifest = {
    environment: "staging",
    projectRef,
    systemIdentifier: "7623125441096521075",
    runId: "normops-20260914-0900-bootstrap-binding",
    sourceCommit: "a".repeat(40),
    reviewedSql: { bodyMd5: "b".repeat(32) }
  };
  const collectionCounts = {
    combos: 4,
    customer_tabs: 0,
    inventory_categories: 8,
    inventory_items: 42,
    pricing_rules: 3,
    profiles: 5,
    sale_variants: 11,
    sessions: 0,
    stations: 9
  };
  const verification = {
    projectRef,
    systemIdentifier: manifest.systemIdentifier,
    runId: manifest.runId,
    sourceCommit: manifest.sourceCommit,
    manifestSha256: "c".repeat(64),
    appStateUnchanged: true,
    appState: structuredClone(appStateAfter),
    incompleteMutations: 0,
    cleanPreflightFloor: true,
    installedFunctionBodyMd5: manifest.reviewedSql.bodyMd5,
    payload: {
      bytes: 133_365,
      limitBytes: 160_992,
      marginBytes: 27_627,
      actorId: "11111111-2222-4333-8444-555555555555",
      collectionCounts
    }
  };
  const scaleFixtureVerification = {
    appStateBefore: structuredClone(appStateBefore),
    appStateAfter: structuredClone(appStateAfter)
  };
  const dataset = {
    app_state: structuredClone(appStateAfter),
    open_sessions: 0,
    open_customer_tabs: 0,
    public_counts: {
      combos: 4,
      inventory_categories: 8,
      inventory_items: 42,
      pricing_rules: 3,
      sale_variants: 11,
      stations: 9
    }
  };
  return { manifest, verification, scaleFixtureVerification, dataset };
}

function assertFixture(value: ReturnType<typeof fixture>) {
  assertBootstrapPerformanceBinding({
    ...value,
    manifestSha256: value.verification.manifestSha256,
    stagingProjectRef: projectRef
  });
}

describe("operational bootstrap performance evidence binding", () => {
  it("binds the postflight to the active post-fixture app_state and dataset counts", () => {
    const value = fixture();
    expect(value.scaleFixtureVerification.appStateBefore.version).toBe(735);
    expect(value.scaleFixtureVerification.appStateAfter.version).toBe(736);
    expect(() => assertFixture(value)).not.toThrow();
  });

  it("rejects evidence that matches only the obsolete pre-fixture identity", () => {
    const value = fixture();
    value.verification.appState = structuredClone(appStateBefore);
    expect(() => assertFixture(value)).toThrow(/active scale fixture/);
  });

  it("rejects drift between the verification and current dataset identity", () => {
    const value = fixture();
    value.dataset.app_state.version += 1;
    expect(() => assertFixture(value)).toThrow(/active scale fixture/);
  });

  it("rejects dataset-correlated count drift", () => {
    const value = fixture();
    value.verification.payload.collectionCounts.inventory_items += 1;
    expect(() => assertFixture(value)).toThrow(/do not match/);
  });

  it("rejects missing count keys and malformed actors", () => {
    const missingCount = fixture();
    delete (missingCount.verification.payload.collectionCounts as Partial<typeof missingCount.verification.payload.collectionCounts>).sale_variants;
    expect(() => assertFixture(missingCount)).toThrow(/shape is invalid/);

    const malformedActor = fixture();
    malformedActor.verification.payload.actorId = "client-supplied-user";
    expect(() => assertFixture(malformedActor)).toThrow(/shape is invalid/);

    const extraPayloadField = fixture();
    Object.assign(extraPayloadField.verification.payload, { ignoredExtra: true });
    expect(() => assertFixture(extraPayloadField)).toThrow(/unchanged staging installation/);
  });

  it("rejects manifest, source, body, and payload-budget mismatches", () => {
    const manifestHash = fixture();
    expect(() => assertBootstrapPerformanceBinding({
      ...manifestHash,
      manifestSha256: "d".repeat(64),
      stagingProjectRef: projectRef
    })).toThrow(/unchanged staging installation/);

    const source = fixture();
    source.verification.sourceCommit = "e".repeat(40);
    expect(() => assertFixture(source)).toThrow(/unchanged staging installation/);

    const body = fixture();
    body.verification.installedFunctionBodyMd5 = "f".repeat(32);
    expect(() => assertFixture(body)).toThrow(/unchanged staging installation/);

    const budget = fixture();
    budget.verification.payload.bytes = 160_993;
    budget.verification.payload.marginBytes = -1;
    expect(() => assertFixture(budget)).toThrow(/unchanged staging installation/);
  });
});
