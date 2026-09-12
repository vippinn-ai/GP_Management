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
const root = process.cwd();

function normalizeBody(body) {
  return body.replaceAll("\r\n", "\n").trim();
}

function functionBody(definition, name) {
  const match = definition.match(/\bAS\s+(\$[A-Za-z0-9_]*\$)([\s\S]*?)\1\s*;?\s*$/i);
  if (!match) throw new Error(`Unable to extract installed body for ${name}.`);
  return normalizeBody(match[2]);
}

function verifyFile(record, label) {
  const filePath = path.resolve(root, record.path);
  const bytes = fs.readFileSync(filePath);
  if (record.bytes !== undefined && record.bytes !== bytes.length) throw new Error(`${label} byte count changed.`);
  if (record.sha256 !== sha256(bytes)) throw new Error(`${label} SHA-256 changed.`);
  return filePath;
}

if (manifest.preflight.sha256 !== sha256(preflightText)) throw new Error("Manifest is not bound to this preflight.");
for (const [sourcePath, expectedSha] of Object.entries(manifest.sources ?? {})) {
  const bytes = fs.readFileSync(path.resolve(root, sourcePath));
  if (sha256(bytes) !== expectedSha) throw new Error(`Reviewed source changed after manifest creation: ${sourcePath}.`);
}
const installPath = verifyFile(manifest.artifacts.install, "Install artifact");
const rollbackPath = verifyFile(manifest.artifacts.rollback, "Rollback artifact");
if (preflight.expected_project_ref !== manifest.target.projectRef || postflight.expected_project_ref !== manifest.target.projectRef) throw new Error("Project identity changed.");
for (const observed of [preflight.environment_identity, postflight.environment_identity]) {
  if (JSON.stringify(observed) !== JSON.stringify(manifest.environmentIdentity)) throw new Error("Database-derived environment identity changed.");
}
if (preflight.organization_id !== manifest.target.organizationId || postflight.organization_id !== manifest.target.organizationId) throw new Error("Organization identity changed.");
for (const field of ["version", "bytes", "md5", "updated_at", "updated_by"]) {
  if (JSON.stringify(preflight.app_state?.[field]) !== JSON.stringify(postflight.app_state?.[field])) {
    throw new Error(`Compatibility app_state ${field} changed during installation.`);
  }
}
if (postflight.processing_financial_mutations !== 0 || postflight.processing_operational_mutations !== 0) throw new Error("Postflight found an incomplete mutation.");
if (postflight.operational_mutations_rls !== true) throw new Error("Operational mutation RLS is disabled.");
const installedEntries = new Map((postflight.functions ?? []).map((entry) => [entry.name, entry]));
const installed = new Set(installedEntries.keys());
for (const name of ["hop_session_v2", "reject_session_v2", "reject_customer_tab_v2", "start_session", "open_customer_tab", "link_customer_tab_continuation"]) {
  if (!installed.has(name)) throw new Error(`Postflight omitted ${name}.`);
  const entry = installedEntries.get(name);
  if (crypto.createHash("md5").update(entry.definition).digest("hex") !== entry.definition_md5) throw new Error(`${name} postflight definition hash is inconsistent.`);
  if (entry.security_definer !== true || !(entry.config ?? []).includes("search_path=public")) throw new Error(`${name} lost its security-definer search path guard.`);
  if (entry.anon_execute !== false || entry.authenticated_execute !== true) throw new Error(`${name} has incorrect execution grants.`);
  if (sha256(functionBody(entry.definition, name)) !== manifest.expectedFunctionBodies?.[name]?.sha256) throw new Error(`${name} installed body differs from the reviewed source.`);
}

const definitionGuards = [...installedEntries.entries()].map(([name, entry]) =>
  `  select md5(pg_get_functiondef(p.oid)) into actual_hash from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='${name}' and pg_get_function_identity_arguments(p.oid)='payload jsonb';\n  if actual_hash is distinct from '${entry.definition_md5}' then raise exception 'installed definition drift for ${name}'; end if;`
).join("\n");
const rollbackText = fs.readFileSync(rollbackPath, "utf8");
const verifiedRollback = rollbackText.replace("begin;", `begin;\n\ndo $$\ndeclare actual_hash text;\nbegin\n  if not exists(select 1 from public.deployment_environment_identity where environment='staging' and project_ref='${manifest.target.projectRef}' and identity_nonce='${manifest.environmentIdentity.identity_nonce}'::uuid) then raise exception 'database-derived staging identity drift'; end if;\n${definitionGuards}\nend $$;`);
const verifiedRollbackPath = path.join(path.dirname(manifestPath), "staging-rollback-verified.sql");
fs.writeFileSync(verifiedRollbackPath, verifiedRollback, { encoding: "utf8", flag: "wx" });

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
  ,verifiedRollback: { path: verifiedRollbackPath, sha256: sha256(verifiedRollback), bytes: Buffer.byteLength(verifiedRollback) }
};
const outPath = path.join(path.dirname(manifestPath), "postflight-verification.json");
fs.writeFileSync(outPath, JSON.stringify(verification, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
process.stdout.write(JSON.stringify({ outPath, sha256: sha256(fs.readFileSync(outPath)), verification }, null, 2) + "\n");
