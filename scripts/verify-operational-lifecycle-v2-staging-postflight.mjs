import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

function argument(name) {
  const marker = `--${name}=`;
  const value = process.argv.slice(2).find((entry) => entry.startsWith(marker))?.slice(marker.length).trim();
  if (!value) throw new Error(`Missing required ${marker}<value> argument.`);
  return path.resolve(process.cwd(), value);
}

function evidence(file) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return parsed.evidence ?? parsed;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const preflightPath = argument("preflight");
const postflightPath = argument("postflight");
const manifestPath = argument("manifest");
const preflightText = fs.readFileSync(preflightPath, "utf8");
const postflightText = fs.readFileSync(postflightPath, "utf8");
const manifestText = fs.readFileSync(manifestPath, "utf8");
const preflight = evidence(preflightPath);
const postflight = evidence(postflightPath);
const manifest = JSON.parse(manifestText);

if (manifest.preflight.sha256 !== sha256(preflightText)) throw new Error("Manifest is not bound to this preflight.");
if (preflight.expected_project_ref !== manifest.target.projectRef || postflight.expected_project_ref !== manifest.target.projectRef) throw new Error("Project identity changed.");
if (preflight.organization_id !== manifest.target.organizationId || postflight.organization_id !== manifest.target.organizationId) throw new Error("Organization identity changed.");
for (const field of ["version", "bytes", "md5", "updated_at", "updated_by"]) {
  if (JSON.stringify(preflight.app_state?.[field]) !== JSON.stringify(postflight.app_state?.[field])) {
    throw new Error(`Compatibility app_state ${field} changed during installation.`);
  }
}
if (postflight.processing_financial_mutations !== 0 || postflight.processing_operational_mutations !== 0) throw new Error("Postflight found an incomplete mutation.");
if (postflight.operational_mutations_rls !== true) throw new Error("Operational mutation RLS is disabled.");
const installed = new Set((postflight.functions ?? []).map((entry) => entry.name));
for (const name of ["hop_session_v2", "reject_session_v2", "reject_customer_tab_v2", "start_session", "open_customer_tab", "link_customer_tab_continuation"]) {
  if (!installed.has(name)) throw new Error(`Postflight omitted ${name}.`);
}

const verification = {
  verifiedAt: new Date().toISOString(),
  runId: manifest.runId,
  projectRef: manifest.target.projectRef,
  organizationId: manifest.target.organizationId,
  preflightSha256: sha256(preflightText),
  postflightSha256: sha256(postflightText),
  manifestSha256: sha256(manifestText),
  appStateUnchanged: true,
  incompleteMutations: 0,
  installedFunctions: [...installed].sort()
};
const outPath = path.join(path.dirname(manifestPath), "postflight-verification.json");
fs.writeFileSync(outPath, JSON.stringify(verification, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
process.stdout.write(JSON.stringify({ outPath, sha256: sha256(fs.readFileSync(outPath)), verification }, null, 2) + "\n");
