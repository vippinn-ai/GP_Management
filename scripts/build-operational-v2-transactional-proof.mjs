import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const root = process.cwd();
function argument(name) {
  const marker = `--${name}=`;
  const value = process.argv.slice(2).find((entry) => entry.startsWith(marker))?.slice(marker.length).trim();
  if (!value) throw new Error(`Missing required ${marker}<value> argument.`);
  return value;
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function assertBalancedStatementParentheses(sql) {
  let balance = 0;
  let line = 1;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];
    if (character === "\n") {
      line += 1;
      inLineComment = false;
      continue;
    }
    if (inLineComment) continue;
    if (inBlockComment) {
      if (character === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (inSingleQuote) {
      if (character === "'" && next === "'") index += 1;
      else if (character === "'") inSingleQuote = false;
      continue;
    }
    if (inDoubleQuote) {
      if (character === '"' && next === '"') index += 1;
      else if (character === '"') inDoubleQuote = false;
      continue;
    }
    if (character === "-" && next === "-") {
      inLineComment = true;
      index += 1;
    } else if (character === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
    } else if (character === "'") inSingleQuote = true;
    else if (character === '"') inDoubleQuote = true;
    else if (character === "(") balance += 1;
    else if (character === ")") {
      balance -= 1;
      if (balance < 0) throw new Error(`Transactional proof has an unmatched closing parenthesis at line ${line}.`);
    } else if (character === ";" && balance !== 0) {
      throw new Error(`Transactional proof has ${balance} unclosed parentheses at statement end on line ${line}.`);
    }
  }
  if (balance !== 0) throw new Error(`Transactional proof ended with ${balance} unclosed parentheses.`);
}
const runId = argument("run-id");
if (!runId || !/^normops-\d{8}-\d{4}-db-proof-[a-z0-9-]+$/.test(runId)) {
  throw new Error("Use --run-id=normops-YYYYMMDD-HHMM-db-proof-<unique-suffix>.");
}
const installManifestPath = path.resolve(root, argument("db-manifest"));
const installManifestExpectedSha = argument("db-manifest-sha256").toLowerCase();
const verificationPath = path.resolve(root, argument("postflight-verification"));
const verificationExpectedSha = argument("postflight-verification-sha256").toLowerCase();
const installManifestText = fs.readFileSync(installManifestPath, "utf8");
const verificationText = fs.readFileSync(verificationPath, "utf8");
if (sha256(installManifestText) !== installManifestExpectedSha) throw new Error("Database install manifest SHA-256 does not match.");
if (sha256(verificationText) !== verificationExpectedSha) throw new Error("Database postflight verification SHA-256 does not match.");
const installManifest = JSON.parse(installManifestText);
const verification = JSON.parse(verificationText);
if (installManifest.target?.projectRef !== "tkbdyzxwwbhkpztgjjxh" || verification.projectRef !== "tkbdyzxwwbhkpztgjjxh") {
  throw new Error("Transactional proof inputs are not staging.");
}
if (verification.runId !== installManifest.runId || verification.manifestSha256 !== installManifestExpectedSha || verification.appStateUnchanged !== true || verification.incompleteMutations !== 0) {
  throw new Error("Transactional proof inputs are not the verified unchanged installation.");
}
if (!installManifest.preflight?.path || !/^[0-9a-f]{64}$/.test(installManifest.preflight?.sha256 ?? "")) {
  throw new Error("Install manifest does not bind an immutable staging preflight.");
}
const preflightPath = path.isAbsolute(installManifest.preflight.path)
  ? installManifest.preflight.path
  : path.resolve(root, installManifest.preflight.path);
const preflightText = fs.readFileSync(preflightPath, "utf8");
if (sha256(preflightText) !== installManifest.preflight.sha256) {
  throw new Error("Install manifest preflight SHA-256 does not match.");
}
const parsedPreflight = JSON.parse(preflightText);
const preflight = parsedPreflight.evidence ?? parsedPreflight;
const identityNonce = preflight.environment_identity?.identity_nonce;
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identityNonce ?? "")) {
  throw new Error("Immutable preflight omitted the staging identity nonce.");
}
if (
  installManifest.environmentIdentity?.environment !== "staging" ||
  installManifest.environmentIdentity?.project_ref !== "tkbdyzxwwbhkpztgjjxh" ||
  installManifest.environmentIdentity?.identity_nonce !== identityNonce
) {
  throw new Error("Install manifest and immutable preflight staging identities do not match.");
}

const requiredInstalledFunctions = [
  "hop_session_v2",
  "reject_session_v2",
  "reject_customer_tab_v2",
  "get_operational_performance_dataset_identity",
  "start_session",
  "open_customer_tab",
  "link_customer_tab_continuation"
];
const installedDefinitionMd5 = verification.installedFunctionDefinitionMd5 ?? {};
for (const name of requiredInstalledFunctions) {
  if (!/^[0-9a-f]{32}$/.test(installedDefinitionMd5[name] ?? "")) throw new Error(`Missing verified installed definition hash for ${name}.`);
}
const legacyFunctionNames = ["hop_session", "reject_session", "reject_customer_tab"];
const preflightFunctions = new Map((preflight.functions ?? []).map((entry) => [entry.name, entry]));
const legacyDefinitionMd5 = {};
for (const name of legacyFunctionNames) {
  const entry = preflightFunctions.get(name);
  if (!entry?.definition || !/^[0-9a-f]{32}$/.test(entry.definition_md5 ?? "")) {
    throw new Error(`Immutable preflight omitted legacy function ${name}.`);
  }
  if (createHash("md5").update(entry.definition).digest("hex") !== entry.definition_md5) {
    throw new Error(`Immutable preflight definition hash mismatch for ${name}.`);
  }
  legacyDefinitionMd5[name] = entry.definition_md5;
}
const guardedDefinitionMd5 = { ...installedDefinitionMd5, ...legacyDefinitionMd5 };
const guardedFunctions = [...requiredInstalledFunctions, ...legacyFunctionNames];
const sourcePath = path.join(root, "supabase", "operational-lifecycle-v2-transactional-proof.sql");
const source = fs.readFileSync(sourcePath, "utf8");
if (!source.includes("OPERATIONAL_LIFECYCLE_V2_TRANSACTIONAL_PROOF") || !source.trimEnd().endsWith("rollback;")) {
  throw new Error("Transactional proof lost its marker or terminal rollback.");
}
if (/\bcommit\s*;/i.test(source)) throw new Error("Transactional proof must never commit.");
const definitionGuards = `do $$
declare function_name text; expected_md5 text; actual_md5 text;
begin
  for function_name, expected_md5 in select * from (values
${guardedFunctions.map((name) => `    ('${name}', '${guardedDefinitionMd5[name]}')`).join(",\n")}
  ) expected(name, definition_md5) loop
    select md5(pg_get_functiondef(p.oid)) into actual_md5
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=function_name and pg_get_function_identity_arguments(p.oid)='payload jsonb';
    if actual_md5 is distinct from expected_md5 then raise exception 'installed function drift for %', function_name; end if;
  end loop;
end $$;`;
const generated = source
  .replaceAll("__RUN_ID__", runId)
  .replaceAll("__IDENTITY_NONCE__", identityNonce)
  .replace("__INSTALLED_FUNCTION_GUARDS__", () => definitionGuards);
if (generated.includes("__RUN_ID__") || generated.includes("__IDENTITY_NONCE__") || generated.includes("__INSTALLED_FUNCTION_GUARDS__")) {
  throw new Error("Transactional proof contains an unresolved marker.");
}
if (!generated.includes("do $$\ndeclare function_name") || !generated.includes("end $$;")) {
  throw new Error("Transactional proof function-definition guard lost its dollar delimiters.");
}
assertBalancedStatementParentheses(generated);
const outputDirectory = path.join(root, "test-artifacts", "sql");
fs.mkdirSync(outputDirectory, { recursive: true });
const outputPath = path.join(outputDirectory, `${runId}-operational-v2-transactional-proof.sql`);
const manifestPath = path.join(outputDirectory, `${runId}-operational-v2-transactional-proof-manifest.json`);
if (fs.existsSync(outputPath) || fs.existsSync(manifestPath)) throw new Error("This proof run ID already has immutable artifacts.");
fs.writeFileSync(outputPath, generated, { encoding: "utf8", flag: "wx" });
const manifest = {
  runId,
  target: { environment: "staging", projectRef: "tkbdyzxwwbhkpztgjjxh", organizationId: "org-primary", identityNonce },
  rollbackOnly: true,
  installManifest: { path: path.relative(root, installManifestPath), sha256: installManifestExpectedSha, runId: installManifest.runId },
  installPreflight: { path: path.relative(root, preflightPath), sha256: installManifest.preflight.sha256 },
  postflightVerification: { path: path.relative(root, verificationPath), sha256: verificationExpectedSha },
  installedFunctionDefinitionMd5: installedDefinitionMd5,
  legacyFunctionDefinitionMd5: legacyDefinitionMd5,
  source: { path: path.relative(root, sourcePath), sha256: sha256(source) },
  artifact: { path: path.relative(root, outputPath), bytes: Buffer.byteLength(generated), sha256: sha256(generated) },
  createdAt: new Date().toISOString()
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
process.stdout.write(JSON.stringify({ outputPath, manifestPath, manifest }, null, 2) + "\n");
