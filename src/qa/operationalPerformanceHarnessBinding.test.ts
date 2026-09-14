import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertMatchingOperationalPerformanceHarness,
  buildOperationalPerformanceHarnessIdentity
} from "../../scripts/operational-performance-harness-binding.mjs";

const created: string[] = [];
const sha256 = (value: string | Buffer) => crypto.createHash("sha256").update(value).digest("hex");

afterEach(() => {
  for (const target of created.splice(0)) fs.rmSync(target, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bp-performance-harness-"));
  created.push(root);
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests", "e2e", "staging"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", "run.mjs"), "runner\n");
  fs.writeFileSync(path.join(root, "config.ts"), "config\n");
  fs.writeFileSync(path.join(root, "tests", "e2e", "staging", "spec.ts"), "spec\n");
  const files = ["tests/e2e/staging/spec.ts", "scripts/run.mjs", "config.ts"];
  return { root, files };
}

describe("operational performance harness evidence binding", () => {
  it("records deterministic exact file hashes and accepts an identical baseline", () => {
    const { root, files } = fixture();
    const identity = buildOperationalPerformanceHarnessIdentity(root, files);
    expect(identity.files.map((entry: { path: string }) => entry.path)).toEqual([
      "config.ts", "scripts/run.mjs", "tests/e2e/staging/spec.ts"
    ]);
    expect(identity.files[0]).toEqual({
      path: "config.ts",
      bytes: 7,
      sha256: sha256("config\n")
    });
    expect(identity.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => assertMatchingOperationalPerformanceHarness(structuredClone(identity), identity)).not.toThrow();
  });

  it("rejects a candidate when any harness file changes", () => {
    const { root, files } = fixture();
    const baseline = buildOperationalPerformanceHarnessIdentity(root, files);
    fs.writeFileSync(path.join(root, "config.ts"), "changed config\n");
    const candidate = buildOperationalPerformanceHarnessIdentity(root, files);
    expect(() => assertMatchingOperationalPerformanceHarness(baseline, candidate)).toThrow(/identities differ/);
  });

  it("rejects unsafe, duplicate, or incomplete identities", () => {
    const { root, files } = fixture();
    expect(() => buildOperationalPerformanceHarnessIdentity(root, [files[0], files[0]])).toThrow(/unique repository-relative/);
    expect(() => buildOperationalPerformanceHarnessIdentity(root, ["../outside.ts"])).toThrow(/unique repository-relative/);
    const identity = buildOperationalPerformanceHarnessIdentity(root, files);
    expect(() => assertMatchingOperationalPerformanceHarness({}, identity)).toThrow(/identities differ/);
  });
});
