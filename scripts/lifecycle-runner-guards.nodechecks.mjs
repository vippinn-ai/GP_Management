// Run with node --test; deliberately outside Vitest's *.test.* discovery.
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseLifecycleArguments, assertStagingBundleUrl, assertLifecycleSqlBinding, LIFECYCLE_FUNCTION_SOURCES,
  expectedLifecycleTests, assertCompleteLifecycleSummary, lifecycleSourceIdentity, lifecycleRuntimeIdentity } from "./lifecycle-runner-guards.mjs";
import CompactEvidenceReporter from "./playwright-compact-reporter.mjs";

test("runtime identity binds fixture values without retaining credentials", () => {
  const original = lifecycleRuntimeIdentity({ E2E_HOP_STATION: "one", E2E_PASSWORD_A: "private" });
  assert.equal(JSON.stringify(original).includes("private"), false);
  assert.notEqual(lifecycleRuntimeIdentity({ E2E_HOP_STATION: "two" }).sha256, original.sha256);
  assert.throws(() => lifecycleRuntimeIdentity({ E2E_GUARDED_HOPPED_SESSION_ID: "x" }));
});
test("compact reporter and JSON discovery use identical file/project/title identity", () => {
  const reporter = new CompactEvidenceReporter({ runId: "run-a" });
  const rootDir = path.resolve("tests/e2e/staging");
  reporter.onBegin({ rootDir });
  reporter.onTestEnd({ location: { file: path.join(rootDir, "sample.e2e.ts") },
    parent: { project: () => ({ name: "" }) }, titlePath: () => ["", "", "sample.e2e.ts", "suite", "case"]
  }, { status: "passed", duration: 1, retry: 0, errors: [], attachments: [] });
  assertCompleteLifecycleSummary({ runId: "run-a", status: "passed", tests: reporter.tests }, expectedLifecycleTests(discovery), "run-a");
});

test("only complete live execution or nonexecuting discovery is permitted", () => {
  assert.equal(parseLifecycleArguments([]).discoveryOnly, false);
  for (const arg of ["--list", "--help"]) assert.equal(parseLifecycleArguments([arg]).discoveryOnly, true);
  for (const args of [["--retries=1"], ["--workers=2"], ["--config=x"], ["--project=x"], ["--grep=x"], ["--list", "--grep=x"], ["--repeat-each=2"], ["--pass-with-no-tests"], ["--reporter=json"]]) assert.throws(() => parseLifecycleArguments(args));
});
test("bundle URL stays on the staging asset origin", () => {
  const base = "https://staging.example/";
  assert.equal(assertStagingBundleUrl("/assets/index-abc.js", base).origin, "https://staging.example");
  for (const value of ["https://evil.example/assets/index-x.js", "//evil.example/assets/index-x.js", "/assets/index-x.js?x=1", "/api/x", "https://user@staging.example/assets/index-x.js"]) assert.throws(() => assertStagingBundleUrl(value, base));
});
const discovery = { suites: [{ title: "sample.e2e.ts", suites: [{ title: "suite", specs: [{ file: "sample.e2e.ts", title: "case", tests: [{ projectName: "" }] }] }] }] };
const expected = [{ file: "sample.e2e.ts", project: "", title: "sample.e2e.ts > suite > case" }];
const summary = { runId: "run-a", status: "passed", tests: [{ ...expected[0], status: "passed", retry: 0 }] };
test("discovery preserves exact file and full title", () => {
  assert.deepEqual(expectedLifecycleTests(discovery), expected);
  assert.throws(() => expectedLifecycleTests({ suites: [] }));
  assert.throws(() => expectedLifecycleTests({ ...discovery, errors: [{}] }));
  assert.throws(() => expectedLifecycleTests({ suites: [...discovery.suites, ...discovery.suites] }));
});
test("only exact nonempty complete zero-retry evidence passes", () => {
  assertCompleteLifecycleSummary(summary, expected, "run-a");
  for (const changed of [{ ...summary, tests: [] }, { ...summary, tests: [...summary.tests, ...summary.tests] }, { ...summary, runId: "other" }, { ...summary, status: "failed" }, ...["skipped", "failed", "timedOut"].map(status => ({ ...summary, tests: [{ ...summary.tests[0], status }] })), { ...summary, tests: [{ ...summary.tests[0], retry: 1 }] }, { ...summary, tests: [{ ...summary.tests[0], file: "other" }] }]) assert.throws(() => assertCompleteLifecycleSummary(changed, expected, "run-a"));
});
test("SQL binding checks all continuation bodies even for a narrow reinstall", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-binding-"));
  try {
    fs.mkdirSync(path.join(root, "supabase"));
    const files = new Map(); const manifest = { expectedFunctionBodies: {} };
    for (const [name, file] of Object.entries(LIFECYCLE_FUNCTION_SOURCES)) {
      const body = `begin return '${name}'; end`;
      files.set(file, (files.get(file) ?? "") + `create or replace function public.${name}(payload jsonb) returns jsonb as $$\r\n${body}\r\n$$;\n`);
      manifest.expectedFunctionBodies[name] = { sha256: createHash("sha256").update(body).digest("hex") };
    }
    for (const [file, text] of files) fs.writeFileSync(path.join(root, file), text);
    assertLifecycleSqlBinding(root, manifest);
    manifest.expectedFunctionBodies.start_session.sha256 = "0".repeat(64);
    assert.throws(() => assertLifecycleSqlBinding(root, manifest), /start_session/);
    assert.throws(() => assertLifecycleSqlBinding(root, {}));
  } finally { fs.rmSync(root, { recursive: true }); }
});
test("identity includes source changes but excludes private environment and evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-source-"));
  try {
    for (const dir of ["src", "scripts", "supabase", "tests"]) fs.mkdirSync(path.join(root, dir));
    fs.writeFileSync(path.join(root, "src", "App.tsx"), "before");
    fs.writeFileSync(path.join(root, "package-lock.json"), "{}");
    const before = lifecycleSourceIdentity(root);
    fs.writeFileSync(path.join(root, ".env.staging"), "private");
    assert.deepEqual(lifecycleSourceIdentity(root), before);
    fs.writeFileSync(path.join(root, "src", "App.tsx"), "after");
    assert.notEqual(lifecycleSourceIdentity(root).sha256, before.sha256);
  } finally { fs.rmSync(root, { recursive: true }); }
});
