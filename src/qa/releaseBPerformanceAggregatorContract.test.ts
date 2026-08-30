import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.join(process.cwd(), "scripts/aggregate-release-b-performance-evidence.mjs"), "utf8");

describe("Release B historical performance evidence aggregator", () => {
  it("is staging-only, SHA-bound, collision-safe, and read-only", () => {
    expect(source).toContain('const stagingProjectRef = "tkbdyzxwwbhkpztgjjxh"');
    expect(source).toContain('productionAllowed: false');
    expect(source).toContain('safeForAutomaticRetry: false');
    expect(source).toContain('flag: "wx"');
    expect(source).toContain("SHA-256 mismatch");
    expect(source).not.toContain("createClient");
    expect(source).not.toContain("fetch(");
  });

  it("deduplicates exact mutation identities and rejects conflicting evidence", () => {
    expect(source).toContain('mutationKeyContract: "organization_id|mutation_id|mutation_kind"');
    expect(source).toContain("const uniqueMutations = new Map()");
    expect(source).toContain("nullableInvariantFields");
    expect(source).toContain("enrichmentProvenance");
    expect(source).toContain("changedRowsSha256");
    expect(source).toContain("canonicalBillSha256");
    expect(source).toContain("duplicateConflicts.push");
    expect(source).toContain("conflicting duplicate mutation timing records");
  });

  it("does not misclassify whole-test duration as browser completion", () => {
    expect(source).toContain("collectExplicitBrowserDurations");
    expect(source).toContain("browserDurationMs|browser_completion_ms|checkoutBrowserDurationMs");
    expect(source).not.toMatch(/\^\(durationMs/);
    expect(source).toContain("No explicit complex checkout browser-completion timing distribution");
    expect(source).toContain("mixedRepresentative: false");
  });

  it("enforces the approved acceptance thresholds and forbidden error classes", () => {
    expect(source).toContain("databaseP95MsExclusive: 2000");
    expect(source).toContain("databaseMaxMsExclusive: 5000");
    expect(source).toContain("browserMaxMsExclusive: 7000");
    expect(source).toContain("\\b57014\\b|deadlock detected|statement timeout|client timeout|timed out|timeout.*exceeded");
    expect(source).toContain("terminalContract");
    expect(source).toContain("verified-by-explicit-terminal-contract");
  });
});
