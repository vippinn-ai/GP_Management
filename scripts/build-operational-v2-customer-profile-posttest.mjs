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

const runId = argument("run-id");
if (!/^normops-\d{8}-\d{4}-customer-[a-z0-9-]+$/i.test(runId)) {
  throw new Error("Use --run-id=normops-YYYYMMDD-HHMM-customer-<suffix>.");
}

const verificationPath = path.resolve(root, argument("postflight-verification"));
const expectedVerificationSha = argument("postflight-verification-sha256").toLowerCase();
if (!/^[0-9a-f]{64}$/.test(expectedVerificationSha)) throw new Error("Postflight verification SHA-256 is invalid.");
const verificationText = fs.readFileSync(verificationPath, "utf8");
if (sha256(verificationText) !== expectedVerificationSha) throw new Error("Postflight verification SHA-256 does not match.");
const verification = JSON.parse(verificationText);
if (
  verification.projectRef !== "tkbdyzxwwbhkpztgjjxh"
  || verification.appStateUnchanged !== true
  || verification.incompleteMutations !== 0
  || !Number.isInteger(verification.appState?.version)
  || !/^[0-9a-f]{32}$/.test(verification.appState?.md5 ?? "")
  || !verification.installedFunctionDefinitionMd5
) throw new Error("Customer-profile baseline is not the verified unchanged staging install.");

const sourcePath = path.join(root, "supabase", "operational-v2-customer-profile-posttest-readonly.sql");
const source = fs.readFileSync(sourcePath, "utf8");
if (!source.includes("repeatable read read only") || !source.trimEnd().endsWith("rollback;")) {
  throw new Error("Customer-profile post-test source lost its read-only contract.");
}
const generated = source.replaceAll("__RUN_ID__", runId);
if (generated.includes("__RUN_ID__")) throw new Error("Customer-profile post-test contains an unresolved run marker.");

const directory = path.join(root, "test-artifacts", "operational-lifecycle-v2", runId);
fs.mkdirSync(directory, { recursive: true });
const sqlPath = path.join(directory, "customer-profile-posttest-readonly.sql");
const manifestPath = path.join(directory, "customer-profile-posttest-manifest.json");
fs.writeFileSync(sqlPath, generated, { encoding: "utf8", flag: "wx" });
const manifest = {
  runId,
  target: { environment: "staging", projectRef: "tkbdyzxwwbhkpztgjjxh", organizationId: "org-primary" },
  installVerification: { path: path.relative(root, verificationPath), sha256: expectedVerificationSha },
  expectedAppStateBefore: verification.appState,
  expectedFunctions: verification.installedFunctionDefinitionMd5,
  source: { path: path.relative(root, sourcePath), sha256: sha256(source) },
  artifact: { path: path.relative(root, sqlPath), bytes: Buffer.byteLength(generated), sha256: sha256(generated) }
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
process.stdout.write(JSON.stringify({ sqlPath, manifestPath, sha256: sha256(fs.readFileSync(manifestPath)), manifest }, null, 2) + "\n");
