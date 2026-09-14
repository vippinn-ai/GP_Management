import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const EXPECTED_PROJECT_REF = "tkbdyzxwwbhkpztgjjxh";
const EXPECTED_SYSTEM_IDENTIFIER = "7623125441096521075";
const PAYLOAD_LIMIT_BYTES = 160_992;

function argument(name) {
  const marker = `--${name}=`;
  const value = process.argv.slice(2).find((entry) => entry.startsWith(marker))?.slice(marker.length).trim();
  if (!value) throw new Error(`Missing required ${marker}<value> argument.`);
  return path.resolve(process.cwd(), value);
}

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const md5 = (value) => crypto.createHash("md5").update(value).digest("hex");
const normalizeBody = (body) => body.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();

function readEvidence(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return parsed.evidence ?? parsed;
}

function verifyArtifact(root, record, label) {
  if (!record?.path || !/^[a-f0-9]{64}$/i.test(record.sha256 ?? "")) {
    throw new Error(`${label} binding is incomplete.`);
  }
  const artifactPath = path.resolve(root, record.path);
  const bytes = fs.readFileSync(artifactPath);
  if (sha256(bytes) !== record.sha256.toLowerCase()) throw new Error(`${label} SHA-256 changed.`);
  return artifactPath;
}

function extractReviewedBody(source) {
  const match = source.match(/\bas\s+\$\$([\s\S]*?)\$\$;/i);
  if (!match) throw new Error("Unable to extract the reviewed bootstrap function body.");
  return normalizeBody(match[1]);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

const root = process.cwd();
const preflightPath = argument("preflight");
const postflightPath = argument("postflight");
const manifestPath = argument("manifest");
const preflightText = fs.readFileSync(preflightPath, "utf8");
const postflightText = fs.readFileSync(postflightPath, "utf8");
const manifestText = fs.readFileSync(manifestPath, "utf8");
const preflight = readEvidence(preflightPath);
const postflight = readEvidence(postflightPath);
const manifest = JSON.parse(manifestText);
const manifestSha256 = sha256(manifestText);

if (manifest.environment !== "staging" || manifest.projectRef !== EXPECTED_PROJECT_REF
  || manifest.systemIdentifier !== EXPECTED_SYSTEM_IDENTIFIER) {
  throw new Error("Bootstrap manifest is not for the approved staging environment.");
}
if (!/^normops-\d{8}-\d{4}-[a-z0-9-]+$/i.test(manifest.runId ?? "")
  || !/^[a-f0-9]{40}$/i.test(manifest.sourceCommit ?? "")) {
  throw new Error("Bootstrap manifest identity is incomplete.");
}
if (manifest.preflight?.sha256 !== sha256(preflightText)) throw new Error("Manifest is not bound to this bootstrap preflight.");

if (!manifest.reviewedSql?.path || !/^[a-f0-9]{64}$/i.test(manifest.reviewedSql.sha256 ?? "")
  || !/^[a-f0-9]{32}$/i.test(manifest.reviewedSql.bodyMd5 ?? "")) {
  throw new Error("Reviewed bootstrap SQL binding is incomplete.");
}
const reviewedSqlPath = path.resolve(root, manifest.reviewedSql.path);
verifyArtifact(root, manifest.install, "Bootstrap install artifact");
verifyArtifact(root, manifest.postflight, "Bootstrap postflight SQL artifact");
verifyArtifact(root, manifest.rollback, "Bootstrap rollback artifact");
const reviewedSql = fs.readFileSync(reviewedSqlPath, "utf8").trim();
if (sha256(reviewedSql) !== manifest.reviewedSql.sha256) throw new Error("Reviewed bootstrap SQL SHA-256 changed.");
if (md5(extractReviewedBody(reviewedSql)) !== manifest.reviewedSql.bodyMd5) {
  throw new Error("Reviewed bootstrap body no longer matches the manifest.");
}

if (preflight.expected_project_ref !== EXPECTED_PROJECT_REF
  || preflight.system_identifier !== EXPECTED_SYSTEM_IDENTIFIER
  || preflight.environment_identity?.environment !== "staging"
  || preflight.environment_identity?.project_ref !== EXPECTED_PROJECT_REF
  || preflight.organization_id !== "org-primary") {
  throw new Error("Bootstrap preflight identity is inconsistent with the manifest.");
}
if (preflight.open_sessions !== 0 || preflight.open_customer_tabs !== 0
  || preflight.processing_financial_mutations !== 0 || preflight.processing_operational_mutations !== 0) {
  throw new Error("Bootstrap preflight did not have a clean operational floor.");
}

if (postflight.project_ref !== EXPECTED_PROJECT_REF || postflight.system_identifier !== EXPECTED_SYSTEM_IDENTIFIER) {
  throw new Error("Bootstrap postflight is not from the approved staging environment.");
}
if (postflight.payload?.status !== "active" || postflight.payload?.organization_id !== "org-primary"
  || postflight.payload?.contract_version !== 1 || !Number.isInteger(postflight.payload?.bytes)
  || postflight.payload.bytes <= 0 || postflight.payload.bytes > PAYLOAD_LIMIT_BYTES) {
  throw new Error("Bootstrap postflight payload contract or byte budget failed.");
}
if (postflight.function?.body_md5 !== manifest.reviewedSql.bodyMd5
  || postflight.function?.owner !== (preflight.target_function?.owner_name ?? preflight.installer_role)
  || postflight.function?.security_definer !== true || postflight.function?.volatility !== "s"
  || !sameJson(postflight.function?.config, ["search_path=pg_catalog", "statement_timeout=5s"])
  || postflight.function?.authenticated_execute !== true || postflight.function?.anon_execute !== false
  || postflight.function?.public_execute !== false || postflight.function?.service_role_execute !== false) {
  throw new Error("Installed bootstrap function identity or security differs from the manifest-bound expectation.");
}
const expectedAcl = [preflight.target_function?.owner_name ?? preflight.installer_role, "authenticated"].sort();
const actualAcl = (postflight.function?.acl_detail ?? []).map((grant) => {
  if (grant.privilege_type !== "EXECUTE" || grant.is_grantable !== false
    || grant.grantor !== (preflight.target_function?.owner_name ?? preflight.installer_role)) {
    throw new Error("Installed bootstrap ACL contains an unexpected privilege, grant option, or grantor.");
  }
  return grant.grantee;
}).sort();
if (!sameJson(actualAcl, expectedAcl)) throw new Error("Installed bootstrap ACL is not the exact two-principal contract.");

for (const field of ["version", "bytes", "md5", "updated_at", "updated_by"]) {
  if (!sameJson(preflight.app_state?.[field], postflight.app_state?.[field])) {
    throw new Error(`Compatibility app_state ${field} changed during bootstrap installation.`);
  }
}
if (postflight.payload.app_state_version !== postflight.app_state.version) {
  throw new Error("Bootstrap payload app_state version does not match the postflight identity.");
}
if (postflight.realtime_security?.rls_enabled !== true || postflight.realtime_security?.published !== true
  || !sameJson(postflight.realtime_security?.policies, preflight.realtime_security?.policies)
  || !sameJson(postflight.realtime_security?.authenticated_role_memberships, preflight.realtime_security?.authenticated_role_memberships)) {
  throw new Error("Realtime security evidence changed between bootstrap preflight and postflight.");
}
const expectedHelper = preflight.realtime_security?.access_helper;
const actualHelper = postflight.realtime_security?.access_helper;
for (const field of ["definition_md5", "body_md5", "owner_name", "security_definer", "volatility", "config", "acl_detail"]) {
  if (!sameJson(expectedHelper?.[field], actualHelper?.[field])) {
    throw new Error(`Realtime access helper ${field} changed during bootstrap installation.`);
  }
}

const verification = {
  verifiedAt: new Date().toISOString(),
  runId: manifest.runId,
  projectRef: manifest.projectRef,
  systemIdentifier: manifest.systemIdentifier,
  sourceCommit: manifest.sourceCommit,
  manifestSha256,
  preflightSha256: sha256(preflightText),
  postflightSha256: sha256(postflightText),
  appStateUnchanged: true,
  appState: postflight.app_state,
  incompleteMutations: 0,
  cleanPreflightFloor: true,
  installedFunctionBodyMd5: postflight.function.body_md5,
  payload: {
    bytes: postflight.payload.bytes,
    limitBytes: PAYLOAD_LIMIT_BYTES,
    marginBytes: PAYLOAD_LIMIT_BYTES - postflight.payload.bytes,
    collectionCounts: postflight.payload.collection_counts
  }
};
const outPath = path.join(path.dirname(manifestPath), "bootstrap-postflight-verification.json");
fs.writeFileSync(outPath, `${JSON.stringify(verification, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
const verificationSha256 = sha256(fs.readFileSync(outPath));
process.stdout.write(`${JSON.stringify({ outPath, sha256: verificationSha256, verification }, null, 2)}\n`);
