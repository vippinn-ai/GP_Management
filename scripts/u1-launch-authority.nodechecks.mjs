import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {validateLaunchAuthority,AUTHORITY_SOURCES,AUTHORITY_TARGET} from './u1-launch-authority.mjs';
import {U1_IDENTITY,U1_LIMITS} from './u1-playwright-runner.mjs';
import {LAUNCH_LIMITS} from './u1-guarded-launcher.mjs';
import {canonicalHash} from './u1-data-reconciler.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const NOW=Date.parse('2026-11-05T06:10:00.000Z');

function fixture(fn){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'u1-launch-authority-')));let serial=0;
 try{
  const save=(stem,value)=>{const file=`${String(++serial).padStart(3,'0')}-${stem}`,bytes=Buffer.isBuffer(value)?value:Buffer.from(typeof value==='string'?value:JSON.stringify(value));fs.writeFileSync(path.join(root,file),bytes,{flag:'wx'});return {file,sha256:sha(bytes)};};
  const blobs={};for(const name of ['package','preflight','config','baseline-config','spec','flags','protected','restore'])blobs[name]=save(`${name}.json`,{name});
  const index=save('index.html','<html><script src="/assets/app.js"></script></html>'),js=save('app.js','export const app=true;'),css=save('app.css','body{}');
  const sourceRefs=Object.fromEntries(AUTHORITY_SOURCES.map((name,i)=>[name,save(`source.${i}.txt`,name)]));
  const toolRefs=Object.fromEntries(['node','git','playwright','psql','taskkill','tls'].map(name=>[name,save(`tool.${name}.txt`,name)]));
  const runId='u1-launch-offline',deploymentId='00000000-0000-4000-8000-000000000101',versionId='00000000-0000-4000-8000-000000000102',sourceCommit='0'.repeat(40);
  const providerValue={schema:'u1-baseline-provider-v1',runId,...AUTHORITY_TARGET,deploymentId,versionId,trafficPercent:100,sourceCommit,indexSha256:index.sha256,configSha256:blobs['baseline-config'].sha256,flagsSha256:blobs.flags.sha256},provider=save('provider.json',providerValue);
  const assetList=[{path:'/assets/app.css',sha256:css.sha256},{path:'/assets/app.js',sha256:js.sha256}],inventory=save('assets.json',{schema:'u1-baseline-assets-v1',runId,versionId,indexSha256:index.sha256,assets:assetList});
  const baselineValue={schema:'u1-baseline-descriptor-v1',runId,...AUTHORITY_TARGET,capturedAt:'2026-11-05T06:00:00.000Z',sourceCommit,deploymentId,versionId,trafficPercent:100,flags:blobs.flags,config:blobs['baseline-config'],index:{path:'/',status:200,redirects:[],body:index},assets:[{path:'/assets/app.css',status:200,redirects:[],body:css},{path:'/assets/app.js',status:200,redirects:[],body:js}],evidence:{provider,config:save('baseline-config-evidence.json',{config:true}),assets:inventory,protectedParity:blobs.protected,restoreProof:blobs.restore}},baseline=save('baseline.json',baselineValue);
  const coreValue={schema:'u1-launch-core-v1',runId,...AUTHORITY_TARGET,applicationCommit:'70ee5ab00bd758c3de2b86e4f68ae76e69c82f1e',harnessCommit:'1'.repeat(40),createdAt:'2026-11-05T06:05:00.000Z',limits:U1_LIMITS,processLimits:LAUNCH_LIMITS,discovery:U1_IDENTITY,sources:sourceRefs,tools:toolRefs,package:blobs.package,preflight:blobs.preflight,baseline,config:blobs.config,spec:blobs.spec};
  const materialize=(core=coreValue,approvalPatch={})=>{const coreRef=save('core.json',core),coreHash=canonicalHash(core),reviewer={schema:'u1-launch-approval-v1',role:'reviewer',reviewedBy:'reviewer-one',scope:'u1-launch-core',decision:'approved',runId,coreHash,approvedAt:'2026-11-05T06:06:00.000Z'},tester={...reviewer,role:'tester',reviewedBy:'tester-two',approvedAt:'2026-11-05T06:07:00.000Z'},approvals={reviewer:save('reviewer.json',{...reviewer,...approvalPatch.reviewer}),tester:save('tester.json',{...tester,...approvalPatch.tester})};return {artifactRoot:root,core:coreRef,approvals,now:NOW};};
  fn({root,save,coreValue,baselineValue,providerValue,materialize,blobs,index,js,css});
 }finally{assert.ok(root.startsWith(fs.realpathSync(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});}
}

test('exact offline snapshots validate without manufacturing live authority',()=>fixture(({materialize})=>{
 const result=validateLaunchAuthority(materialize());assert.equal(result.status,'offline-contract-validated');for(const flag of ['liveAdmission','signerAuthenticityVerified','liveSourceAndToolsVerified','completeAssetDiscoveryVerified','preflightSemanticsVerified','packageSemanticsVerified'])assert.equal(result[flag],false,flag);assert.deepEqual(result.limits,U1_LIMITS);assert.equal(Object.isFrozen(result),true);
}));

test('approval, core, target, limits and freshness tampering fail even when rehashed',()=>fixture(({coreValue,materialize})=>{
 for(const mutate of [
  c=>c.runId='other-run',c=>c.applicationCommit='2'.repeat(40),c=>c.harnessCommit='bad',c=>c.target='https://breakperfect-production.pages.dev',c=>c.project='wrong',c=>c.organization='wrong',c=>c.worker='wrong',c=>c.limits={...c.limits,pairs:49},c=>c.processLimits={...c.processLimits,processMs:1},c=>c.discovery={...c.discovery,title:'other'},c=>c.createdAt='2026-11-05T05:40:00.000Z',c=>c.createdAt='2026-11-05T06:20:00.000Z',c=>c.extra=true,
  c=>delete c.sources[AUTHORITY_SOURCES[0]],c=>c.sources.extra={...c.sources[AUTHORITY_SOURCES[0]]},c=>c.sources[AUTHORITY_SOURCES[1]]=c.sources[AUTHORITY_SOURCES[0]],c=>delete c.tools.psql,c=>c.tools.git=c.tools.node
 ]){const c=structuredClone(coreValue);mutate(c);assert.throws(()=>validateLaunchAuthority(materialize(c)));}
 for(const patch of [{reviewer:{decision:'rejected'}},{reviewer:{scope:'other'}},{reviewer:{runId:'other'}},{reviewer:{coreHash:'0'.repeat(64)}},{reviewer:{approvedAt:'2026-11-05T06:04:00.000Z'}},{tester:{reviewedBy:'reviewer-one'}},{tester:{role:'reviewer'}},{tester:{extra:true}}])assert.throws(()=>validateLaunchAuthority(materialize(coreValue,patch)));
}));

test('baseline/provider/assets and canonical evidence references fail closed',()=>fixture(({root,save,coreValue,baselineValue,materialize})=>{
 const withBaseline=mutate=>{const b=structuredClone(baselineValue);mutate(b);const ref=save('changed-baseline.json',b),c={...structuredClone(coreValue),baseline:ref};assert.throws(()=>validateLaunchAuthority(materialize(c)));};
 for(const mutate of [
  b=>b.trafficPercent=99,b=>b.versionId='bad',b=>b.target='https://prod.invalid',b=>b.capturedAt='2026-11-05T05:40:00.000Z',b=>b.capturedAt='2026-11-05T06:06:00.000Z',b=>b.index.status=304,b=>b.index.redirects=['/login'],b=>b.index.path='/index.html',b=>b.assets.reverse(),b=>b.assets.push(structuredClone(b.assets[0])),b=>b.assets[0].path='/assets/../secret.js',b=>b.evidence.extra=b.evidence.config,b=>b.extra=true
  ,b=>b.evidence.protectedParity=b.evidence.restoreProof,b=>b.config=coreValue.config
 ])withBaseline(mutate);
 withBaseline(b=>{const p=JSON.parse(fs.readFileSync(path.join(root,b.evidence.provider.file)));p.trafficPercent=99;b.evidence.provider=save('provider-drift.json',p);});
 withBaseline(b=>{const p=JSON.parse(fs.readFileSync(path.join(root,b.evidence.provider.file)));p.indexSha256='0'.repeat(64);b.evidence.provider=save('provider-index-drift.json',p);});
 withBaseline(b=>{const inv=JSON.parse(fs.readFileSync(path.join(root,b.evidence.assets.file)));inv.assets.pop();b.evidence.assets=save('asset-inventory-drift.json',inv);});
 const changed=structuredClone(coreValue);changed.package={file:'../escape.json',sha256:'0'.repeat(64)};assert.throws(()=>validateLaunchAuthority(materialize(changed)));
 const unknown=structuredClone(coreValue);unknown.package={...unknown.package,extra:true};assert.throws(()=>validateLaunchAuthority(materialize(unknown)));
 const reserved=structuredClone(coreValue);reserved.package={file:'CrEdEnTiAlS.JsOn',sha256:'0'.repeat(64)};assert.throws(()=>validateLaunchAuthority(materialize(reserved)),/Invalid flat evidence reference|reserved/i);
 const aliased=structuredClone(coreValue);aliased.preflight=aliased.package;assert.throws(()=>validateLaunchAuthority(materialize(aliased)),/alias/);
 const empty=save('empty.txt',Buffer.alloc(0)),emptyCore={...structuredClone(coreValue),package:empty};assert.throws(()=>validateLaunchAuthority(materialize(emptyCore)));
 const hugePath=path.join(root,'huge.bin');fs.writeFileSync(hugePath,Buffer.of(0));fs.truncateSync(hugePath,32*1024*1024+1);const hugeCore={...structuredClone(coreValue),package:{file:'huge.bin',sha256:'0'.repeat(64)}};assert.throws(()=>validateLaunchAuthority(materialize(hugeCore)));
 const altered=materialize();fs.appendFileSync(path.join(root,altered.core.file),' ');assert.throws(()=>validateLaunchAuthority(altered));
}));

test('noncanonical relative artifact roots are rejected',()=>fixture(({root,materialize})=>{
 assert.throws(()=>validateLaunchAuthority({...materialize(),artifactRoot:path.relative(process.cwd(),root)}),/Local artifact root/);
}));

test('symlinked evidence is rejected where Windows permits creating the fixture',t=>fixture(({root,materialize,coreValue})=>{
 const target=path.join(root,coreValue.package.file),link=path.join(root,'linked.json');
 try{fs.symlinkSync(target,link,'file');}catch(error){if(error.code==='EPERM'){t.skip('Windows symlink creation unavailable; source guard remains reviewed');return;}throw error;}assert.equal(fs.lstatSync(link).isSymbolicLink(),true);
 const changed={...structuredClone(coreValue),package:{file:'linked.json',sha256:coreValue.package.sha256}};assert.throws(()=>validateLaunchAuthority(materialize(changed)),/canonical regular file/);
}));
