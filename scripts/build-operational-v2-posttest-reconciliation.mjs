import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

function argument(name) {
  const marker = `--${name}=`;
  const value = process.argv.slice(2).find((entry) => entry.startsWith(marker))?.slice(marker.length).trim();
  if (!value) throw new Error(`Missing required ${marker}<value> argument.`);
  return value;
}
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const root = process.cwd();
const runId = argument("run-id");
if (!/^normops-\d{8}-\d{4}-[a-z0-9-]+$/i.test(runId)) throw new Error("Invalid operational run ID.");
const verificationPath = path.resolve(root, argument("postflight-verification"));
const expectedVerificationSha = argument("postflight-verification-sha256").toLowerCase();
const verificationText = fs.readFileSync(verificationPath, "utf8");
if (sha256(verificationText) !== expectedVerificationSha) throw new Error("Postflight verification SHA-256 does not match.");
const verification = JSON.parse(verificationText);
if (verification.projectRef !== "tkbdyzxwwbhkpztgjjxh" || verification.appStateUnchanged !== true || verification.incompleteMutations !== 0) {
  throw new Error("Post-test reconciliation baseline is not the verified staging install.");
}
const sourcePath = path.join(root, "supabase", "operational-v2-staging-posttest-readonly.sql");
const source = fs.readFileSync(sourcePath, "utf8");
const generated = source.replaceAll("__RUN_ID__", runId);
if (generated.includes("__RUN_ID__") || !generated.includes("repeatable read read only") || !generated.trimEnd().endsWith("rollback;")) {
  throw new Error("Post-test reconciliation source lost its read-only contract.");
}
const outputDirectory = path.join(root, "test-artifacts", "operational-lifecycle-v2", runId);
const outputPath = path.join(outputDirectory, "staging-posttest-readonly.sql");
const manifestPath = path.join(outputDirectory, "staging-posttest-manifest.json");
fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(outputPath, generated, { encoding: "utf8", flag: "wx" });
const manifest = {
  runId,
  target: { environment: "staging", projectRef: "tkbdyzxwwbhkpztgjjxh", organizationId: "org-primary" },
  readOnly: true,
  installVerification: { path: path.relative(root, verificationPath), sha256: expectedVerificationSha },
  expectedAppState: verification.appState,
  expectedFunctionDefinitionMd5: verification.installedFunctionDefinitionMd5,
  source: { path: path.relative(root, sourcePath), sha256: sha256(source) },
  artifact: { path: path.relative(root, outputPath), bytes: Buffer.byteLength(generated), sha256: sha256(generated) }
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
process.stdout.write(JSON.stringify({ outputPath, manifestPath, manifest }, null, 2) + "\n");
