import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyReleaseBProductionBaseline } from "./release-b-production-baseline-verifier.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sources = [
  {
    path: "supabase/phase11-operational-maintenance-rpcs.sql",
    sha256: "bf056dd0a05f9388fae52c1e666ef35aa4a7a226a67694c0f4337120bb8aa752"
  },
  {
    path: "supabase/phase10-financial-v2-rpcs.sql",
    sha256: "9e54f1afeeb47a45ded330536ab4237486407aba86a84a24dde3c3fc7f41a780"
  }
];
const outputPath = path.join(
  projectRoot,
  "test-artifacts",
  "production-sql",
  "release-b-production-install.sql"
);
const evidencePath = path.join(
  projectRoot,
  "test-artifacts",
  "evidence",
  "release-b-production-install-build.json"
);
const expectedProjectRef = "rrdwbxvuwrbxefarxnse";
const expectedBaselineSqlSha256 = "650d67292814417f168dcc33f61c6d930d5493d3c6096f80341be940a22ef2c8";
const maximumBaselineAgeMs = 15 * 60 * 1000;

function getArgument(name) {
  const prefix = `${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function runGit(args) {
  const result = spawnSync(
    "git",
    ["-c", `safe.directory=${projectRoot.replaceAll("\\", "/")}`, ...args],
    { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || "Git inspection failed.");
  return result.stdout.trim();
}

const baselineEvidenceArgument = getArgument("--baseline-evidence");
if (!baselineEvidenceArgument) {
  throw new Error("A fresh --baseline-evidence path is required to bind the production install.");
}
const baselineEvidencePath = path.resolve(projectRoot, baselineEvidenceArgument);
const allowedEvidenceRoot = path.join(projectRoot, "test-artifacts", "evidence") + path.sep;
if (!baselineEvidencePath.startsWith(allowedEvidenceRoot)) {
  throw new Error("Production baseline evidence must stay under test-artifacts/evidence.");
}
const verifiedBaseline = await verifyReleaseBProductionBaseline({
  baselineEvidencePath,
  projectRoot,
  maximumAgeMs: maximumBaselineAgeMs
});
const baselineRaw = verifiedBaseline.normalizedRaw;
const baseline = verifiedBaseline.baseline;
const baselineCapturedAt = Date.parse(baseline.capturedAt);
const baselineAgeMs = Date.now() - baselineCapturedAt;
const baselineAppStateVersion = Number(baseline.databaseBaseline?.appState?.version);
const baselineAppStateHash = baseline.databaseBaseline?.appState?.dataHashSha256;
const baselineChecks = {
  normalizedCaptureContract:
    baseline.schemaVersion === 2 &&
    baseline.status === "passed" &&
    baseline.provenance?.captureMethod === "supabase-sql-editor-copy-as-json",
  exactBaselineSql:
    baseline.provenance?.baselineSql?.path === "supabase/release-b-production-baseline-readonly.sql" &&
    baseline.provenance?.baselineSql?.sha256 === expectedBaselineSqlSha256,
  rawExportBound:
    typeof baseline.provenance?.rawExport?.path === "string" &&
    /^[0-9a-f]{64}$/.test(baseline.provenance?.rawExport?.sha256 ?? "") &&
    /^[0-9a-f]{64}$/.test(baseline.provenance?.rawExport?.fileSha256 ?? ""),
  dashboardCaptureIdentity:
    baseline.provenance?.dashboardUrl?.includes(`/dashboard/project/${expectedProjectRef}/sql`) &&
    baseline.provenance?.dashboardTitle?.toLowerCase().includes("breakperfect-production"),
  exactProductionEnvironment:
    baseline.environment === "production" && baseline.projectRef === expectedProjectRef,
  readOnlyEvidence:
    baseline.productionWritePerformed === false &&
    baseline.databaseBaseline?.transactionReadOnly === true,
  emptyFloor:
    baseline.databaseDiscovery?.openActiveSessions === 0 &&
    baseline.databaseDiscovery?.openCustomerTabs === 0,
  validAppStateIdentity:
    Number.isSafeInteger(baselineAppStateVersion) &&
    /^[0-9a-f]{64}$/.test(baselineAppStateHash ?? ""),
  baselineFresh:
    Number.isFinite(baselineCapturedAt) && baselineAgeMs >= -2 * 60 * 1000 && baselineAgeMs <= maximumBaselineAgeMs,
  downstreamRawLineageReverified: Object.values(verifiedBaseline.checks).every(Boolean)
};
const baselineFailures = Object.entries(baselineChecks).filter(([, passed]) => !passed).map(([name]) => name);
if (baselineFailures.length > 0) {
  throw new Error(`Production baseline preflight failed: ${baselineFailures.join(", ")}.`);
}
const baselineSha256 = createHash("sha256").update(Buffer.from(baselineRaw, "utf8")).digest("hex");

const loaded = await Promise.all(sources.map(async (source) => {
  const content = await readFile(path.join(projectRoot, source.path), "utf8");
  const actualSha256 = createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
  return { ...source, actualSha256, content };
}));
const sourceChecks = {
  sourceHashesMatch: loaded.every((source) => source.actualSha256 === source.sha256),
  sourcesHaveNoTransactionControl: loaded.every((source) => !/^\s*(begin|commit|rollback)\s*;/im.test(source.content)),
  sourcesDoNotAccessAppState: loaded.every((source) => {
    const executable = source.content.replace(/^\s*--.*$/gm, "");
    return !/\b(?:from|join|update|into|lock\s+table)\s+(?:public\.)?app_state\b/i.test(executable);
  }),
  phase11CreatesMaintenanceFunctions: ["edit_pause_log", "delete_pause_log", "record_session_audit"]
    .every((name) => loaded[0].content.includes(`function public.${name}(payload jsonb)`)),
  phase10CreatesFinancialFunctions: ["commit_checkout_bill_v2", "commit_financial_adjustment_v2", "get_financial_mutation_result"]
    .every((name) => loaded[1].content.includes(`function public.${name}(payload jsonb)`))
};
const sourceFailures = Object.entries(sourceChecks).filter(([, passed]) => !passed).map(([name]) => name);
if (sourceFailures.length > 0) {
  throw new Error(`Production install source preflight failed: ${sourceFailures.join(", ")}.`);
}

const header = [
  "-- GENERATED: Release B production additive install.",
  "-- Exact project: rrdwbxvuwrbxefarxnse.",
  "-- Do not edit this artifact; rebuild it from the SHA-bound source files.",
  ...loaded.map((source) => `-- ${source.path} sha256=${source.sha256}`),
  `-- baseline evidence sha256=${baselineSha256}`,
  "",
  "begin;",
  "set local statement_timeout = '120s';",
  "set local lock_timeout = '5s';",
  "set local search_path = public, extensions;",
  "",
  "do $release_b_production_guard$",
  "declare",
  "  v_app_state_version bigint;",
  "  v_app_state_hash text;",
  "  v_required_existing_function_count integer;",
  "begin",
  "  if current_database() <> 'postgres' then",
  "    raise exception using errcode = 'P0001', message = 'Release B target guard failed: unexpected database.';",
  "  end if;",
  "  if not exists (select 1 from public.organizations where id = 'org-primary') then",
  "    raise exception using errcode = 'P0001', message = 'Release B target guard failed: org-primary is absent.';",
  "  end if;",
  "  if (select count(*) from public.sessions where organization_id = 'org-primary' and status in ('active', 'paused')) <> 0",
  "     or (select count(*) from public.customer_tabs where organization_id = 'org-primary' and status = 'open') <> 0 then",
  "    raise exception using errcode = 'P0001', message = 'Release B target guard failed: production floor is not empty.';",
  "  end if;",
  "  select version, encode(digest(data::text, 'sha256'), 'hex')",
  "    into v_app_state_version, v_app_state_hash",
  "  from public.app_state where id = 'primary';",
  `  if v_app_state_version is distinct from ${baselineAppStateVersion} or v_app_state_hash is distinct from '${baselineAppStateHash}' then`,
  "    raise exception using errcode = 'P0001', message = 'Release B target guard failed: production baseline identity changed.';",
  "  end if;",
  "  select count(*) into v_required_existing_function_count",
  "  from unnest(array[",
  "    'public.start_session(jsonb)', 'public.pause_session(jsonb)', 'public.resume_session(jsonb)',",
  "    'public.add_session_item(jsonb)', 'public.remove_session_item(jsonb)', 'public.hop_session(jsonb)',",
  "    'public.reject_session(jsonb)', 'public.repeat_session_combo(jsonb)', 'public.open_customer_tab(jsonb)',",
  "    'public.link_customer_tab_continuation(jsonb)', 'public.apply_customer_tab_combo(jsonb)',",
  "    'public.add_customer_tab_item(jsonb)', 'public.update_customer_tab_item_quantity(jsonb)',",
  "    'public.remove_customer_tab_item(jsonb)', 'public.reject_customer_tab(jsonb)',",
  "    'public.save_live_session_details(jsonb)', 'public.save_live_customer_tab_details(jsonb)',",
  "    'public.commit_checkout_bill(jsonb)', 'public.commit_financial_adjustment(jsonb)',",
  "    'public.commit_admin_data_change(jsonb)',",
  "    'public.load_analytics_summary(text,date,date,date,date)',",
  "    'public.load_inventory_report_summary(text,date,date,text,integer)'",
  "  ]) candidate(signature) where to_regprocedure(signature) is not null;",
  "  if v_required_existing_function_count <> 22 then",
  "    raise exception using errcode = 'P0001', message = 'Release B target guard failed: existing RPC baseline differs.';",
  "  end if;",
  "  if to_regclass('public.financial_mutations') is not null",
  "     or to_regprocedure('public.edit_pause_log(jsonb)') is not null",
  "     or to_regprocedure('public.delete_pause_log(jsonb)') is not null",
  "     or to_regprocedure('public.record_session_audit(jsonb)') is not null",
  "     or to_regprocedure('public.commit_checkout_bill_v2(jsonb)') is not null",
  "     or to_regprocedure('public.commit_financial_adjustment_v2(jsonb)') is not null",
  "     or to_regprocedure('public.get_financial_mutation_result(jsonb)') is not null then",
  "    raise exception using errcode = 'P0001', message = 'Release B target guard failed: additive objects already exist; reconcile instead of retrying.';",
  "  end if;",
  "end;",
  "$release_b_production_guard$;",
  ""
].join("\n");
const footer = "\n\ncommit;\n";
const output = `${header}${loaded.map((source) => source.content.trim()).join("\n\n")}${footer}`;
const outputSha256 = createHash("sha256").update(Buffer.from(output, "utf8")).digest("hex");

await mkdir(path.dirname(outputPath), { recursive: true });
await mkdir(path.dirname(evidencePath), { recursive: true });
await writeFile(outputPath, output, "utf8");
const result = {
  schemaVersion: 1,
  purpose: "atomic additive Release B production SQL install",
  builtAt: new Date().toISOString(),
  projectRef: expectedProjectRef,
  productionAccessed: false,
  productionWritePerformed: false,
  sourceCommit: runGit(["rev-parse", "HEAD"]),
  sourceTreeClean: runGit(["status", "--short"]) === "",
  baselineEvidence: {
    path: path.relative(projectRoot, baselineEvidencePath).replaceAll("\\", "/"),
    sha256: baselineSha256,
    capturedAt: baseline.capturedAt,
    ageSecondsAtBuild: Math.round(baselineAgeMs / 1000),
    appStateVersion: baselineAppStateVersion,
    appStateDataHashSha256: baselineAppStateHash,
    baselineSqlSha256: baseline.provenance.baselineSql.sha256,
    rawExportPath: baseline.provenance.rawExport.path,
    rawExportSha256: baseline.provenance.rawExport.sha256,
    rawExportFileSha256: baseline.provenance.rawExport.fileSha256,
    dashboardUrl: baseline.provenance.dashboardUrl,
    checks: baselineChecks
  },
  sources: loaded.map(({ path: sourcePath, sha256, actualSha256 }) => ({
    path: sourcePath,
    expectedSha256: sha256,
    actualSha256,
    matches: sha256 === actualSha256
  })),
  output: {
    path: path.relative(projectRoot, outputPath).replaceAll("\\", "/"),
    bytes: Buffer.byteLength(output, "utf8"),
    sha256: outputSha256
  },
  checks: {
    ...sourceChecks,
    singleOuterTransaction: output.startsWith("-- GENERATED:") && output.endsWith("commit;\n"),
    productionBaselineGuardPresent:
      output.includes("Release B target guard failed: production baseline identity changed.") &&
      output.includes(`v_app_state_version is distinct from ${baselineAppStateVersion}`) &&
      output.includes(`v_app_state_hash is distinct from '${baselineAppStateHash}'`),
    failClosedTimeoutsPresent:
      output.includes("set local statement_timeout = '120s';") &&
      output.includes("set local lock_timeout = '5s';")
  },
  status: "passed"
};
await writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));
