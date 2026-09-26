import fs from "node:fs";
import path from "node:path";
import { packageIdentity, assertPackageIdentity, sha256 } from "./lifecycle-install-contract.mjs";
import { renderAclPackage } from "./lifecycle-acl-convergence.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const match = arg.match(/^--(run-id|expected-commit|preflight)=(.+)$/);
  if (!match) throw new Error(`Unknown argument: ${arg}`);
  return [match[1], match[2]];
}));
if (Object.keys(args).length !== 3 || process.argv.length !== 5) throw new Error("Require exactly --run-id, --expected-commit and --preflight.");
const root = process.cwd();
const codeIdentity = packageIdentity(root, args["expected-commit"]);
const preflightPath = path.resolve(root, args.preflight);
const preflightText = fs.readFileSync(preflightPath, "utf8");
const runId = args["run-id"];
const rendered = renderAclPackage({ root, preflightText, runId, codeIdentity });
assertPackageIdentity(root, args["expected-commit"], codeIdentity);
const parent = path.join(root, "test-artifacts", "operational-lifecycle-v2");
fs.mkdirSync(parent, { recursive: true });
const directory = path.join(parent, runId);
fs.mkdirSync(directory); // Existing or partially-written package is never reused.
const manifest = { operation: "staging-acl-convergence", runId, codeIdentity, preflight: { path: preflightPath, sha256: sha256(preflightText) }, artifacts: {} };
for (const name of ["forward", "rollback", "postflight"]) {
  const file = path.join(directory, `staging-acl-${name}.sql`);
  fs.writeFileSync(file, rendered[name], { flag: "wx" });
  manifest.artifacts[name] = { path: file, bytes: Buffer.byteLength(rendered[name]), sha256: sha256(rendered[name]) };
}
const manifestPath = path.join(directory, "manifest.json");
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ manifestPath, ...manifest }, null, 2));
