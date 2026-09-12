import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const root = process.cwd();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function argument(name) {
  const marker = `--${name}=`;
  const value = process.argv.slice(2).find((entry) => entry.startsWith(marker))?.slice(marker.length).trim();
  if (!value) throw new Error(`Missing required ${marker}<value> argument.`);
  return value;
}

function readBound(name) {
  const file = path.resolve(root, argument(name));
  const expected = argument(`${name}-sha256`).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error(`${name} SHA-256 is invalid.`);
  const text = fs.readFileSync(file, "utf8");
  if (sha256(text) !== expected) throw new Error(`${name} SHA-256 mismatch.`);
  return { file, sha256: expected, value: JSON.parse(text) };
}

const unwrap = (value) => value.evidence ?? value?.[0]?.evidence ?? value;
const manifest = readBound("manifest");
const result = readBound("result");
const browser = readBound("browser-manifest");
const observed = unwrap(result.value);

if (
  manifest.value.target?.projectRef !== "tkbdyzxwwbhkpztgjjxh"
  || observed.project_ref !== "tkbdyzxwwbhkpztgjjxh"
  || observed.run_id !== manifest.value.runId
  || browser.value.runId !== manifest.value.runId
  || browser.value.exitCode !== 0
  || observed.transaction_read_only !== true
) throw new Error("Customer-profile post-test identity mismatch.");
for (const value of Object.values(observed.global_floor ?? {})) {
  if (Number(value) !== 0) throw new Error("Customer-profile run did not restore the clean global floor.");
}
for (const [name, value] of Object.entries(observed.qa_live_residuals ?? {})) {
  if (Number(value) !== 0) throw new Error(`Customer-profile run left ${name} residue.`);
}
if (Number(observed.qa_terminal_evidence?.closed_sessions) < 1) {
  throw new Error("Customer-profile run lacks its terminal session evidence.");
}
if (!isDeepStrictEqual(observed.functions, manifest.value.expectedFunctions)) {
  throw new Error("Operational functions drifted during the customer-profile suite.");
}
if (
  !Number.isInteger(observed.app_state?.version)
  || observed.app_state.version <= manifest.value.expectedAppStateBefore.version
  || !/^[0-9a-f]{32}$/.test(observed.app_state?.md5 ?? "")
) throw new Error("Expected bounded admin compatibility writes were not observed.");

const verification = {
  runId: manifest.value.runId,
  status: "passed",
  projectRef: observed.project_ref,
  customerCleanupProven: true,
  globalFloorClean: true,
  expectedAdminCompatibilityChange: true,
  terminalEvidence: observed.qa_terminal_evidence,
  lineage: {
    manifestSha256: manifest.sha256,
    resultSha256: result.sha256,
    browserManifestSha256: browser.sha256
  }
};
const output = path.join(path.dirname(manifest.file), "customer-profile-posttest-verification.json");
fs.writeFileSync(output, JSON.stringify(verification, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
process.stdout.write(JSON.stringify({ output, sha256: sha256(fs.readFileSync(output)), verification }, null, 2) + "\n");
