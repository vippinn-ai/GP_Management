import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export const OPERATIONAL_PERFORMANCE_HARNESS_FILES = Object.freeze([
  "playwright.operational-performance.staging.config.ts",
  "scripts/run-operational-performance-staging-e2e.mjs",
  "tests/e2e/staging/operational-performance.e2e.ts"
]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function buildOperationalPerformanceHarnessIdentity(root, files = OPERATIONAL_PERFORMANCE_HARNESS_FILES) {
  const normalizedFiles = [...files].map((entry) => entry.replaceAll("\\", "/")).sort();
  if (new Set(normalizedFiles).size !== normalizedFiles.length || normalizedFiles.some((entry) => path.isAbsolute(entry) || entry.startsWith("../") || entry.includes("/../"))) {
    throw new Error("Performance harness file set must contain unique repository-relative paths.");
  }
  const fileRecords = normalizedFiles.map((entry) => {
    const bytes = fs.readFileSync(path.resolve(root, entry));
    return { path: entry, bytes: bytes.length, sha256: sha256(bytes) };
  });
  return {
    schemaVersion: 1,
    files: fileRecords,
    sha256: sha256(JSON.stringify(fileRecords))
  };
}

export function assertMatchingOperationalPerformanceHarness(baselineHarness, currentHarness) {
  if (!baselineHarness || !currentHarness
    || baselineHarness.schemaVersion !== 1
    || currentHarness.schemaVersion !== 1
    || !/^[a-f0-9]{64}$/i.test(baselineHarness.sha256 ?? "")
    || !/^[a-f0-9]{64}$/i.test(currentHarness.sha256 ?? "")
    || !isDeepStrictEqual(baselineHarness, currentHarness)) {
    throw new Error("Candidate and baseline performance harness identities differ.");
  }
}
