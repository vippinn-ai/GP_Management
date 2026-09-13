import fs from "node:fs";
import path from "node:path";
import { parseJsonBytes, sha256, unwrapEvidence } from "./operational-performance-scale-fixture-lib.mjs";

const root=process.cwd();
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
  return {absolutePath,path:path.relative(root,absolutePath),sha256:actual,value:parseJsonBytes(bytes)};
}
const mode=argument("mode");
if(!["proof","apply","cleanup"].includes(mode)) throw new Error("Mode must be proof, apply, or cleanup.");
const manifestFile=readBound("manifest","Scale fixture manifest");
const resultFile=readBound("result","Scale fixture SQL result");
const snapshotFile=readBound("snapshot","Scale fixture read-only snapshot");
const manifest=manifestFile.value;
const result=unwrapEvidence(resultFile.value);
const snapshot=unwrapEvidence(snapshotFile.value);
if(manifest.target?.projectRef!=="tkbdyzxwwbhkpztgjjxh"||manifest.productionAllowed!==false||manifest.automaticRetryAllowed!==false) throw new Error("Manifest is not a staging-only zero-retry package.");
if(result.status!=="passed"||result.run_id!==manifest.runId||result.package_binding_sha256!==manifest.packageBindingSha256||result.production_write_allowed!==false) throw new Error("SQL result does not match the immutable scale fixture package.");
if(snapshot.expected_project_ref!=="tkbdyzxwwbhkpztgjjxh"||snapshot.identity_nonce!==manifest.target.identityNonce||snapshot.organization_id!=="org-primary"||snapshot.transaction_read_only!==true) throw new Error("Read-only snapshot is not the approved staging environment.");
const canonicalize=(value)=>Array.isArray(value)?value.map(canonicalize):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map((key)=>[key,canonicalize(value[key])])):value;
const same=(left,right)=>JSON.stringify(canonicalize(left))===JSON.stringify(canonicalize(right));
function validScaleRpcIdentity(identity){
  const acl=identity?.acl;
  return identity?.owner==="postgres"
    && identity?.security_definer===true
    && identity?.volatility==="s"
    && same(identity?.search_path,["search_path=public"])
    && /^[0-9a-f]{32}$/.test(identity?.body_md5??"")
    && /^[0-9a-f]{32}$/.test(identity?.definition_md5??"")
    && identity?.authenticated_execute===true
    && identity?.anon_execute===false
    && identity?.public_execute===false
    && Array.isArray(acl)
    && acl.length===2
    && ["authenticated","postgres"].every((grantee)=>acl.some((entry)=>entry.grantee===grantee&&entry.privilege==="EXECUTE"&&entry.grantable===false))
    && acl.every((entry)=>["authenticated","postgres"].includes(entry.grantee)&&entry.privilege==="EXECUTE"&&entry.grantable===false);
}
function verifyReference(entry,label){
  if(!entry?.path||!/^[0-9a-f]{64}$/i.test(entry.sha256??"")) throw new Error(`${label} reference is invalid.`);
  const bytes=fs.readFileSync(path.resolve(root,entry.path));
  if(sha256(bytes)!==entry.sha256.toLowerCase()) throw new Error(`${label} SHA-256 does not match the manifest.`);
}
for(const [name,entry] of Object.entries(manifest.bindingInput??{})){
  if(entry?.path) verifyReference(entry,`Binding input ${name}`);
}
for(const [name,entry] of Object.entries(manifest.bindingInput?.sourceBindings??{})) verifyReference(entry,`Source binding ${name}`);
const artifactName=mode==="proof"?"rollback-only-proof.sql":mode==="apply"?"apply.sql":"cleanup.sql";
verifyReference(manifest.artifacts?.[artifactName],`Selected ${mode} SQL artifact`);
for(const name of ["open_sessions","open_customer_tabs","recoverable_hopped_sessions","processing_financial_mutations","processing_operational_mutations"]){
  if(snapshot[name]!==0) throw new Error(`Snapshot has a dirty ${name} floor.`);
}
const snapshotIdentity={organization_id:snapshot.organization_id,app_state:snapshot.app_state,public_counts:snapshot.public_counts,public_fingerprints:snapshot.public_fingerprints,auxiliary_counts:snapshot.auxiliary_counts,auxiliary_fingerprints:snapshot.auxiliary_fingerprints,shape_counts:snapshot.shape_counts,scale_fixture_rpc:snapshot.scale_fixture_rpc??null};
const preflightBytes=fs.readFileSync(path.resolve(root,manifest.bindingInput.preflight.path));
if(sha256(preflightBytes)!==manifest.bindingInput.preflight.sha256) throw new Error("Preflight SHA-256 no longer matches the manifest.");
const preflight=unwrapEvidence(parseJsonBytes(preflightBytes));
const expectedOriginal={organization_id:preflight.organization_id,app_state:preflight.app_state,public_counts:preflight.public_counts,public_fingerprints:preflight.public_fingerprints,auxiliary_counts:preflight.auxiliary_counts,auxiliary_fingerprints:preflight.auxiliary_fingerprints,shape_counts:preflight.shape_counts,scale_fixture_rpc:preflight.scale_fixture_rpc??null};
if(mode==="apply"){
  if(snapshot.scale_fixture_absent!==false||snapshot.scale_fixture_key_absent!==false||snapshot.scale_fixture_rpc_absent!==false) throw new Error("Applied fixture is not visible in the staging identity snapshot.");
  if(!validScaleRpcIdentity(snapshot.scale_fixture_rpc)) throw new Error("Applied fixture identity RPC metadata or ACL differs from the approved contract.");
  if(!same(snapshot.public_counts,manifest.plan.targetCounts)) throw new Error("Applied fixture target counts differ from the manifest.");
  if(!same(snapshot.shape_counts,manifest.plan.shape?.targetCounts)) throw new Error("Applied fixture workload-shape counts differ from the manifest.");
  for(const [key,minimum] of Object.entries(manifest.plan.appState?.targetCounts??{})) if(!Number.isInteger(snapshot.app_state_collection_counts?.[key])||snapshot.app_state_collection_counts[key]<minimum) throw new Error(`Applied app_state collection ${key} is below its production-shaped minimum.`);
  if(snapshot.app_state.bytes<manifest.appState.targetMinimumBytes||snapshot.app_state.version!==manifest.appState.before.version+1||snapshot.app_state.md5===manifest.appState.before.md5) throw new Error("Applied fixture app_state overlay is invalid.");
  if(!same(result.identity,snapshotIdentity)) throw new Error("Apply result and read-only snapshot identities differ.");
}else{
  if(mode==="proof"&&result.rollback_only!==true) throw new Error("Proof result is not rollback-only.");
  if(mode==="cleanup"&&result.cleanup_complete!==true) throw new Error("Cleanup result is not complete.");
  if(snapshot.scale_fixture_absent!==true||snapshot.scale_fixture_key_absent!==true||snapshot.scale_fixture_rpc_absent!==true) throw new Error("Scale fixture schema, app_state key, or RPC remains.");
  if(!same(snapshotIdentity,expectedOriginal)) throw new Error("Post-rollback identity does not exactly match the preflight.");
  if(!same(result.identity,expectedOriginal)) throw new Error("SQL result did not restore the exact preflight identity.");
}
const verification={
  schemaVersion:1,status:"passed",mode,runId:manifest.runId,projectRef:manifest.target.projectRef,
  manifest:{path:manifestFile.path,sha256:manifestFile.sha256},
  result:{path:resultFile.path,sha256:resultFile.sha256},
  snapshot:{path:snapshotFile.path,sha256:snapshotFile.sha256},
  appStateBefore:manifest.appState.before,appStateAfter:snapshot.app_state,
  exactOriginalRestored:mode==="apply"?false:true,
  scaleApplied:mode==="apply",productionWritePerformed:false,verifiedAt:new Date().toISOString()
};
const outputPath=path.join(path.dirname(manifestFile.absolutePath),`verification-${mode}.json`);
fs.writeFileSync(outputPath,JSON.stringify(verification,null,2)+"\n",{encoding:"utf8",flag:"wx"});
process.stdout.write(JSON.stringify({outputPath,sha256:sha256(fs.readFileSync(outputPath)),verification},null,2)+"\n");
