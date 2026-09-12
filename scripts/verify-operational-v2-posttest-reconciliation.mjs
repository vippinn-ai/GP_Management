import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

function argument(name) {
  const marker = `--${name}=`;
  const value = process.argv.slice(2).find((entry) => entry.startsWith(marker))?.slice(marker.length).trim();
  if (!value) throw new Error(`Missing required ${marker}<value> argument.`);
  return path.resolve(process.cwd(), value);
}
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function readBound(file, expectedSha, label) {
  const text = fs.readFileSync(file, "utf8");
  if (expectedSha && sha256(text) !== expectedSha) throw new Error(`${label} SHA-256 does not match.`);
  return { text, value: JSON.parse(text), sha256: sha256(text) };
}
function evidence(value) {
  return value.evidence ?? value?.[0]?.evidence ?? value;
}

const manifestPath = argument("manifest");
const resultPath = argument("result");
const browserManifestPath = argument("browser-evidence-manifest");
const browserManifestSha = process.argv.find((entry) => entry.startsWith("--browser-evidence-manifest-sha256="))?.split("=")[1]?.toLowerCase();
if (!/^[0-9a-f]{64}$/.test(browserManifestSha || "")) throw new Error("Browser evidence manifest SHA-256 is required.");
const manifest = readBound(manifestPath, undefined, "Post-test manifest");
const result = readBound(resultPath, undefined, "Post-test result");
const browser = readBound(browserManifestPath, browserManifestSha, "Browser evidence manifest");
const observed = evidence(result.value);

if (manifest.value.target?.projectRef !== "tkbdyzxwwbhkpztgjjxh" || observed.project_ref !== "tkbdyzxwwbhkpztgjjxh") {
  throw new Error("Post-test reconciliation is not staging.");
}
if (observed.run_id !== manifest.value.runId || browser.value.runId !== manifest.value.runId || browser.value.exitCode !== 0) {
  throw new Error("Post-test result and successful browser evidence are not for the same run.");
}
for (const value of Object.values(observed.global_floor ?? {})) {
  if (Number(value) !== 0) throw new Error("Staging global operational floor is not clean after tests.");
}
for (const value of Object.values(observed.qa_live_residuals ?? {})) {
  if (Number(value) !== 0) throw new Error("A generated QA session/tab/reservation remains live after tests.");
}
if (!isDeepStrictEqual(observed.app_state, manifest.value.expectedAppState)) {
  throw new Error("Compatibility app_state changed during the normalized operational suite.");
}
if (!isDeepStrictEqual(observed.functions, manifest.value.expectedFunctionDefinitionMd5)) {
  throw new Error("Installed operational function definitions drifted during tests.");
}
const sameTargetRace = observed.same_target_race_integrity ?? {};
if (Number(sameTargetRace.committed_close_mutations) !== 3
  || Number(sameTargetRace.all_close_mutations) !== 3
  || Number(sameTargetRace.close_audits) !== 3
  || Number(sameTargetRace.close_events) !== 3
  || Number(sameTargetRace.actor_mismatches) !== 0) {
  throw new Error("Same-target races did not retain exactly one committed, actor-attributed winner per case, or a loser left residue.");
}
const verification = {
  runId: manifest.value.runId,
  verifiedAt: new Date().toISOString(),
  projectRef: observed.project_ref,
  status: "passed",
  appStateUnchanged: true,
  globalFloorClean: true,
  qaLiveResidualsClean: true,
  terminalEvidenceCounts: observed.qa_terminal_evidence,
  sameTargetRaceIntegrity: sameTargetRace,
  lineage: {
    manifestSha256: manifest.sha256,
    resultSha256: result.sha256,
    browserEvidenceManifestSha256: browser.sha256
  }
};
const outputPath = path.join(path.dirname(manifestPath), "staging-posttest-verification.json");
fs.writeFileSync(outputPath, JSON.stringify(verification, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
process.stdout.write(JSON.stringify({ outputPath, sha256: sha256(fs.readFileSync(outputPath)), verification }, null, 2) + "\n");
