import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const root = process.cwd();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function argument(name) {
  const marker = `--${name}=`;
  const value = process.argv.slice(2).find((entry) => entry.startsWith(marker))?.slice(marker.length).trim();
  if (!value) throw new Error(`Missing required ${marker}<value> argument.`);
  return value;
}
const proofManifestPath = path.resolve(root, argument("proof-manifest"));
const expectedProofManifestSha = argument("proof-manifest-sha256").toLowerCase();
const proofManifestText = fs.readFileSync(proofManifestPath, "utf8");
if (sha256(proofManifestText) !== expectedProofManifestSha) throw new Error("Proof manifest SHA-256 does not match.");
const proofManifest = JSON.parse(proofManifestText);
const identityNonce = proofManifest.target?.identityNonce;
if (
  !/^normops-\d{8}-\d{4}-db-proof-[a-z0-9-]+$/.test(proofManifest.runId ?? "")
  || proofManifest.target?.projectRef !== "tkbdyzxwwbhkpztgjjxh"
  || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identityNonce ?? "")
  || proofManifest.rollbackOnly !== true
  || !/^[0-9a-f]{64}$/.test(proofManifest.installManifest?.sha256 ?? "")
  || !/^[0-9a-f]{64}$/.test(proofManifest.postflightVerification?.sha256 ?? "")
) throw new Error("Proof manifest is not a rollback-only staging proof.");
for (const [label, record] of [["install manifest", proofManifest.installManifest], ["postflight verification", proofManifest.postflightVerification]]) {
  const lineagePath = path.resolve(root, record.path);
  if (sha256(fs.readFileSync(lineagePath)) !== record.sha256) throw new Error(`Proof ${label} lineage changed.`);
}
const sourcePath = path.join(root, "supabase", "operational-v2-proof-postrollback-readonly.sql");
const source = fs.readFileSync(sourcePath, "utf8");
const generated = source
  .replaceAll("__PROOF_RUN_ID__", proofManifest.runId)
  .replaceAll("__IDENTITY_NONCE__", identityNonce);
if (generated.includes("__PROOF_RUN_ID__") || generated.includes("__IDENTITY_NONCE__") || !generated.includes("repeatable read read only") || !generated.trimEnd().endsWith("rollback;")) {
  throw new Error("Proof post-rollback source lost its read-only contract.");
}
const outputDirectory = path.dirname(proofManifestPath);
const outputPath = path.join(outputDirectory, "proof-postrollback-readonly.sql");
const manifestPath = path.join(outputDirectory, "proof-postrollback-manifest.json");
fs.writeFileSync(outputPath, generated, { encoding: "utf8", flag: "wx" });
const manifest = {
  proofRunId: proofManifest.runId,
  target: proofManifest.target,
  readOnly: true,
  proofManifest: { path: path.relative(root, proofManifestPath), sha256: expectedProofManifestSha },
  installVerification: proofManifest.postflightVerification,
  source: { path: path.relative(root, sourcePath), sha256: sha256(source) },
  artifact: { path: path.relative(root, outputPath), bytes: Buffer.byteLength(generated), sha256: sha256(generated) }
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
process.stdout.write(JSON.stringify({ outputPath, manifestPath, manifest, sha256: sha256(fs.readFileSync(manifestPath)) }, null, 2) + "\n");
