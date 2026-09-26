import fs from "node:fs";
import path from "node:path";
import { packageIdentity, sha256 } from "./lifecycle-install-contract.mjs";
import { loadLifecycleDatabaseLineage } from "./lifecycle-database-lineage.mjs";

const root = process.cwd();
const expectedHashArgs = { installManifest: "install-manifest-sha256", installVerification: "install-verification-sha256", installPostflight: "install-postflight-sha256", installResult: "install-result-sha256", aclManifest: "acl-manifest-sha256", aclPostflight: "acl-postflight-sha256", aclVerification: "acl-verification-sha256" };
const required = ["expected-commit", "historical-source-commit", "historical-root", "install-directory", "acl-directory", "out", ...Object.values(expectedHashArgs)];
const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const match = arg.match(/^--([^=]+)=(.+)$/);
  if (!match || !required.includes(match[1])) throw new Error("Unknown lineage argument.");
  return [match[1], match[2]];
}));
if (Object.keys(args).length !== required.length || process.argv.length !== required.length + 2) throw new Error(`Require exactly ${required.join(", ")}.`);
const ref = (directory, name) => {
  const file = path.resolve(root, directory, name);
  return { path: file, sha256: sha256(fs.readFileSync(file)) };
};
const d = {
  kind: "lifecycle-acl-supplement-v1", codeIdentity: packageIdentity(root, args["expected-commit"]),
  historicalSourceCommit: args["historical-source-commit"], historicalRoot: path.resolve(root, args["historical-root"]),
  installManifest: ref(args["install-directory"], "manifest.json"),
  installVerification: ref(args["install-directory"], "postflight-verification.json"),
  installPostflight: ref(args["install-directory"], "postflight.json"),
  installResult: ref(args["install-directory"], "install-result.json"),
  aclManifest: ref(args["acl-directory"], "manifest.json"),
  aclPostflight: ref(args["acl-directory"], "postflight-result.json"),
  aclVerification: ref(args["acl-directory"], "verification-after.json")
};
const outputPath = path.resolve(root, args.out);
for (const [key, arg] of Object.entries(expectedHashArgs)) {
  if (!/^[a-f0-9]{64}$/.test(args[arg]) || d[key].sha256 !== args[arg]) throw new Error(`Approved evidence hash mismatch: ${key}.`);
}
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const text = JSON.stringify(d, null, 2) + "\n";
fs.writeFileSync(outputPath, text, { flag: "wx" });
// Invalid inputs leave an immutable rejected candidate, never a verified receipt.
const verified = loadLifecycleDatabaseLineage({ root, descriptorPath: outputPath, descriptorSha256: sha256(text),
  installManifestPath: d.installManifest.path, installManifestSha256: d.installManifest.sha256,
  verificationPath: d.installVerification.path, verificationSha256: d.installVerification.sha256 });
const receipt = { status: "passed", descriptor: { path: outputPath, sha256: verified.sha256 }, codeIdentity: d.codeIdentity,
  historicalSourceCommit: d.historicalSourceCommit, appState: verified.postflight.app_state };
fs.writeFileSync(`${outputPath}.verification.json`, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(receipt, null, 2));
