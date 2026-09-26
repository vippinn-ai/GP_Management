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
function readBound(name, label) {
  const filePath = path.resolve(root, argument(name));
  const expectedSha = argument(`${name}-sha256`).toLowerCase();
  const text = fs.readFileSync(filePath, "utf8");
  const actualSha = sha256(text);
  if (actualSha !== expectedSha) throw new Error(`${label} SHA-256 does not match.`);
  return { path: filePath, sha256: actualSha, value: JSON.parse(text) };
}
const unwrap = (value) => value.evidence ?? value?.[0]?.evidence ?? value;
const manifest = readBound("manifest", "Proof post-rollback manifest");
const result = readBound("result", "Proof post-rollback result");
const proofResult = readBound("proof-result", "Transactional proof result");
const observed = unwrap(result.value);
const proof = unwrap(proofResult.value);
const identityNonce = manifest.value.target?.identityNonce;
if (
  manifest.value.target?.projectRef !== "tkbdyzxwwbhkpztgjjxh"
  || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identityNonce ?? "")
  || observed.project_ref !== "tkbdyzxwwbhkpztgjjxh"
  || observed.identity_nonce !== identityNonce
  || observed.transaction_read_only !== true
  || observed.proof_run_id !== manifest.value.proofRunId
  || proof.run_id !== manifest.value.proofRunId
) throw new Error("Proof rollback evidence identity does not match staging.");
for (const [name, count] of Object.entries(observed.residuals ?? {})) {
  if (Number(count) !== 0) throw new Error(`Transactional proof rollback left ${name} rows.`);
}
const installVerificationPath = path.resolve(root, manifest.value.installVerification.path);
const installVerificationText = fs.readFileSync(installVerificationPath, "utf8");
if (sha256(installVerificationText) !== manifest.value.installVerification.sha256) throw new Error("Install verification lineage changed.");
const installVerification = JSON.parse(installVerificationText);
if (!isDeepStrictEqual(observed.app_state, installVerification.appState)) throw new Error("Transactional proof rollback did not restore app_state exactly.");
const verification = {
  proofRunId: manifest.value.proofRunId,
  projectRef: observed.project_ref,
  identityNonce: observed.identity_nonce,
  status: "passed",
  rollbackProven: true,
  residuals: observed.residuals,
  appStateRestored: true,
  verifiedAt: new Date().toISOString(),
  lineage: { manifestSha256: manifest.sha256, resultSha256: result.sha256, proofResultSha256: proofResult.sha256 }
};
const outputPath = path.join(path.dirname(manifest.path), "proof-postrollback-verification.json");
fs.writeFileSync(outputPath, JSON.stringify(verification, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
process.stdout.write(JSON.stringify({ outputPath, sha256: sha256(fs.readFileSync(outputPath)), verification }, null, 2) + "\n");
