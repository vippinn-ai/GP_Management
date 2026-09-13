import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  buildFixturePackage,
  extractAppStateCollectionCountsFromCopy,
  extractProductionShapeCountsFromCopy,
  parseJsonBytes,
  sha256,
  unwrapEvidence,
  validatePreflight,
  validateProductionBaseline,
  validateRunId
} from "./operational-performance-scale-fixture-lib.mjs";

const root=process.cwd();
const safeDirectory=root.replaceAll("\\","/");
const worktreeStatus=execFileSync("git",["-c",`safe.directory=${safeDirectory}`,"status","--porcelain","--untracked-files=all"],{cwd:root,encoding:"utf8"}).trim();
if(worktreeStatus) throw new Error("Scale fixture packages must be generated from a clean committed worktree.");
function argument(name){
  const marker=`--${name}=`;
  const value=process.argv.slice(2).find((entry)=>entry.startsWith(marker))?.slice(marker.length).trim();
  if(!value) throw new Error(`Missing required ${marker}<value> argument.`);
  return value;
}
function readBound(name,label){
  const absolutePath=path.resolve(root,argument(name));
  const expected=argument(`${name}-sha256`).toLowerCase();
  const bytes=fs.readFileSync(absolutePath);
  const actual=sha256(bytes);
  if(actual!==expected) throw new Error(`${label} SHA-256 does not match.`);
  return {absolutePath,relativePath:path.relative(root,absolutePath),sha256:actual,value:parseJsonBytes(bytes)};
}

const runId=validateRunId(argument("run-id"));
const preflightFile=readBound("preflight","Scale fixture preflight");
const productionFile=readBound("production-baseline","Production scale baseline");
const restoreFile=readBound("restore-manifest","Production backup manifest");
const restoreDrillFile=readBound("restore-drill","Disposable restore drill");
const installFile=readBound("db-manifest","Operational v2 database manifest");
const postflightFile=readBound("db-postflight","Operational v2 database postflight");
const preflight=validatePreflight(unwrapEvidence(preflightFile.value));
const production=validateProductionBaseline(productionFile.value);
const canonicalize=(value)=>Array.isArray(value)?value.map(canonicalize):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map((key)=>[key,canonicalize(value[key])])):value;
const same=(left,right)=>JSON.stringify(canonicalize(left))===JSON.stringify(canonicalize(right));

if(
  restoreFile.value.schemaVersion!==1
  || restoreFile.value.projectRef!=="rrdwbxvuwrbxefarxnse"
  || restoreFile.value.baselineEvidence?.sha256!==productionFile.sha256
  || restoreFile.value.validation?.allFilesPresent!==true
  || restoreFile.value.validation?.allFilesNonEmpty!==true
  || restoreFile.value.validation?.hashesRecorded!==true
) throw new Error("Production backup manifest is not valid or is not bound to the selected baseline.");
for(const entry of restoreFile.value.files??[]){
  const filePath=path.join(path.dirname(restoreFile.absolutePath),entry.name);
  const bytes=fs.readFileSync(filePath);
  if(bytes.length!==entry.bytes||sha256(bytes)!==entry.sha256) throw new Error(`Production backup file ${entry.name} failed integrity validation.`);
}
const productionDataEntry=(restoreFile.value.files??[]).find((entry)=>entry.name==="public-auth-storage-data.sql");
if(!productionDataEntry) throw new Error("Production backup manifest lacks the data artifact.");
const productionDataBytes=fs.readFileSync(path.join(path.dirname(restoreFile.absolutePath),productionDataEntry.name));
const productionAppStateCollectionCounts=extractAppStateCollectionCountsFromCopy(productionDataBytes);
const productionShapeCounts=extractProductionShapeCountsFromCopy(productionDataBytes,productionFile.value.capturedAt);
if(productionShapeCounts.pending_bills!==Number(production.databaseBaseline.financialTotals?.pending_bill_count)) throw new Error("Production backup pending-bill shape differs from the bound baseline.");
if(
  restoreDrillFile.value.status!=="passed"
  || restoreDrillFile.value.sourceProjectRef!=="rrdwbxvuwrbxefarxnse"
  || restoreDrillFile.value.targetProjectRef===restoreDrillFile.value.sourceProjectRef
  || restoreDrillFile.value.sourceManifest?.sha256!==restoreFile.sha256
  || restoreDrillFile.value.sourceManifest?.baselineSha256!==productionFile.sha256
  || Object.values(restoreDrillFile.value.checks??{}).some((value)=>value!==true&&value!==false)
  || ["targetGuardPassed","backupHashesPassed","managedRolesPassed","publicCountsPassed","financialTotalsPassed","managedSchemaCountsPassed","timestampsPassed","appStateIdentityPassed","appStateBytesNonZero","emptyFloorPassed"].some((name)=>restoreDrillFile.value.checks?.[name]!==true)
) throw new Error("Disposable restore drill is not valid or not bound to the selected backup.");
if(
  installFile.value.target?.projectRef!=="tkbdyzxwwbhkpztgjjxh"
  || installFile.value.environmentIdentity?.identity_nonce!=="f9bc0aed-b6c4-410f-ba2a-572522d03869"
  || postflightFile.value.projectRef!=="tkbdyzxwwbhkpztgjjxh"
  || postflightFile.value.runId!==installFile.value.runId
  || postflightFile.value.manifestSha256!==installFile.sha256
  || postflightFile.value.appStateUnchanged!==true
  || postflightFile.value.incompleteMutations!==0
  || !same(postflightFile.value.appState,preflight.app_state)
) throw new Error("Operational v2 install/postflight lineage does not match the fresh staging preflight.");

const sourcePaths=[
  "scripts/build-operational-performance-scale-fixture.mjs",
  "scripts/operational-performance-scale-fixture-lib.mjs",
  "scripts/verify-operational-performance-scale-fixture.mjs",
  "scripts/operational-performance-scale-fixture-lib.test.mjs",
  "src/qa/operationalLifecycleV2PlaywrightContract.test.ts",
  "supabase/operational-performance-dataset-readonly.sql"
];
const sourceBindings=Object.fromEntries(sourcePaths.map((relativePath)=>{
  const bytes=fs.readFileSync(path.join(root,relativePath));
  return [relativePath,{path:relativePath,bytes:bytes.length,sha256:sha256(bytes)}];
}));
const candidateCommit=execFileSync("git",["-c",`safe.directory=${safeDirectory}`,"rev-parse","HEAD"],{cwd:root,encoding:"utf8"}).trim();
if(!/^[0-9a-f]{40}$/.test(candidateCommit)) throw new Error("Unable to bind the scale fixture to the candidate commit.");

const bindingInput={
  schemaVersion:1,runId,
  preflight:{path:preflightFile.relativePath,sha256:preflightFile.sha256},
  productionBaseline:{path:productionFile.relativePath,sha256:productionFile.sha256},
  restoreManifest:{path:restoreFile.relativePath,sha256:restoreFile.sha256},
  restoreDrill:{path:restoreDrillFile.relativePath,sha256:restoreDrillFile.sha256},
  databaseManifest:{path:installFile.relativePath,sha256:installFile.sha256},
  databasePostflight:{path:postflightFile.relativePath,sha256:postflightFile.sha256},
  candidateCommit,
  sourceBindings,
  productionAppStateCollectionCounts,
  productionShapeCounts
};
const packageBindingSha256=sha256(JSON.stringify(bindingInput));
const generated=buildFixturePackage({runId,snapshot:preflight,production,productionAppStateCounts:productionAppStateCollectionCounts,productionShapeCounts,packageBindingSha256});
const outputDirectory=path.join(root,"test-artifacts","operational-performance-scale",runId);
fs.mkdirSync(outputDirectory,{recursive:true});
const artifacts={};
for(const [name,contents] of Object.entries({"apply.sql":generated.seed,"cleanup.sql":generated.cleanup,"rollback-only-proof.sql":generated.proof})){
  const outputPath=path.join(outputDirectory,name);
  fs.writeFileSync(outputPath,contents,{encoding:"utf8",flag:"wx"});
  artifacts[name]={path:path.relative(root,outputPath),bytes:fs.statSync(outputPath).size,sha256:sha256(fs.readFileSync(outputPath))};
}
const manifest={
  schemaVersion:1,operation:"staging-operational-performance-scale-fixture",runId,
  target:{environment:"staging",projectRef:"tkbdyzxwwbhkpztgjjxh",systemIdentifier:"7623125441096521075",identityNonce:"f9bc0aed-b6c4-410f-ba2a-572522d03869",organizationId:"org-primary"},
  packageBindingSha256,bindingInput,plan:generated.plan,
  appState:{before:preflight.app_state,targetMinimumBytes:production.databaseBaseline.appState.bytes,targetCollectionCounts:productionAppStateCollectionCounts,key:"qaPerformanceScaleFixture",identityLocation:"qa_performance_scale.fixture_registry",fullDataCopied:false,backupExported:false},
  workloadShape:{production:productionShapeCounts,stagingBefore:preflight.shape_counts,stagingTarget:generated.plan.shape.targetCounts},
  fixture:{piiFree:true,representativeAppData:true,appDataRepresentationFraction:generated.plan.appState.representationFraction,fullNormalizedProductionCounts:true,currentWindowConservative:true,terminal:true,financiallyIsolated:true,inventoryQuantityNeutral:true,identityRpc:"get_operational_performance_scale_identity"},
  artifacts,createdAt:new Date().toISOString(),productionAllowed:false,automaticRetryAllowed:false
};
const manifestPath=path.join(outputDirectory,"manifest.json");
fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+"\n",{encoding:"utf8",flag:"wx"});
process.stdout.write(JSON.stringify({outputDirectory,manifestPath,manifestSha256:sha256(fs.readFileSync(manifestPath)),manifest},null,2)+"\n");
