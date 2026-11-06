// Offline evidence binding only. No execution, writes, credential discovery or
// signer authentication. A validated contract is NOT live admission.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {U1_IDENTITY,U1_LIMITS,verifyLimits,verifyDiscovery} from './u1-playwright-runner.mjs';
import {LAUNCH_LIMITS} from './u1-guarded-launcher.mjs';
import {canonicalHash} from './u1-data-reconciler.mjs';
const check=(v,m)=>{if(!v)throw new Error(m);};
const exact=(v,ks)=>check(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...ks].sort().join(','),'Unexpected contract fields');
const sha=b=>createHash('sha256').update(b).digest('hex');
const digest=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const commit=s=>typeof s==='string'&&/^[a-f0-9]{40}$/.test(s);
const uuid=s=>typeof s==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(s);
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
export const AUTHORITY_TARGET=Object.freeze({target:'https://gp-management-staging-pages.breakperfectgaminglounge.workers.dev',project:'tkbdyzxwwbhkpztgjjxh',organization:'org-primary',worker:'gp-management-staging-pages'});
// Explicit source inventory; helper additions require reviewed changes here.
export const AUTHORITY_SOURCES=Object.freeze(['package.json','package-lock.json','playwright.u1.config.ts','tests/e2e/u1/ui-read-speed-baseline-50-reload-pairs.e2e.ts',
 'scripts/u1-windows-containment.fixture.mjs',
 ...['u1-authority-preflight','u1-command-plan','u1-guarded-launcher','u1-launch-authority','u1-package-builder','u1-preflight-collector','u1-preflight-executor','u1-result-expectations','u1-runtime-expectations','u1-process-supervisor','u1-closeout-verifier','u1-windows-launcher'].flatMap(n=>[`scripts/${n}.mjs`,`scripts/${n}.nodechecks.mjs`]),
 ...['u1-browser-database-adapter','u1-data-reconciler','u1-generated-fields','u1-installed-contract','u1-phase-expectations','u1-playwright-runner','u1-protected-reader','reconcile-u1-evidence','u1-adapter.nodechecks','u1-correlated-evidence.nodechecks','u1-data-reconciler.nodechecks','u1-generated-fields.nodechecks','u1-playwright-runner.nodechecks','u1-installed-contract.nodechecks','u1-phase-expectations.nodechecks'].map(n=>`scripts/${n}.mjs`)].sort());
const MAX_FILE=32*1024*1024,MAX_TOTAL=128*1024*1024;
function reader(root){
 check(typeof root==='string'&&path.isAbsolute(root)&&!root.startsWith('\\\\'),'Local artifact root required');
 const absolute=path.resolve(root);check(fs.realpathSync(root)===absolute&&fs.lstatSync(root).isDirectory()&&!fs.lstatSync(root).isSymbolicLink(),'Canonical artifact root required');
 let total=0;const reads=new Map();
 function read(ref){
  exact(ref,['file','sha256']);check(typeof ref.file==='string'&&ref.file.toLowerCase()!=='credentials.json'&&/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(ref.file)&&digest(ref.sha256),'Invalid flat evidence reference');
  const file=path.join(absolute,ref.file),stat=fs.lstatSync(file);
  check(stat.isFile()&&!stat.isSymbolicLink()&&fs.realpathSync(file)===file,'Evidence must be a canonical regular file');
  check(stat.size>0&&stat.size<=MAX_FILE,'Evidence byte bound');
  total+=stat.size;check(total<=MAX_TOTAL,'Total evidence byte bound');
  const bytes=fs.readFileSync(file);check(bytes.length===stat.size&&sha(bytes)===ref.sha256,'Evidence bytes changed');
  if(reads.has(file))check(reads.get(file)===ref.sha256,'Conflicting evidence reference');reads.set(file,ref.sha256);return bytes;
 }
 return {read,json:ref=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(read(ref))),recheck:()=>{for(const [file,hash]of reads){const stat=fs.lstatSync(file);check(stat.isFile()&&!stat.isSymbolicLink()&&fs.realpathSync(file)===file&&stat.size<=MAX_FILE&&sha(fs.readFileSync(file))===hash,'Evidence changed during validation');}}};
}
const target=v=>{for(const [k,value]of Object.entries(AUTHORITY_TARGET))check(v[k]===value,'Only staging authority permitted');};
const timestamp=s=>{check(typeof s==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s)&&new Date(s).toISOString()===s,'Canonical timestamp required');return Date.parse(s);};
export function validateLaunchAuthority(options){
 exact(options,['artifactRoot','core','approvals','now']);check(Number.isSafeInteger(options.now),'Explicit validation time required');
 const r=reader(options.artifactRoot),core=r.json(options.core);
 exact(core,['schema','runId','target','project','organization','worker','applicationCommit','harnessCommit','createdAt','limits','processLimits','discovery','sources','tools','package','preflight','baseline','config','spec']);
 check(core.schema==='u1-launch-core-v1'&&/^[A-Za-z0-9_-]{6,80}$/.test(core.runId),'Wrong launch core');target(core);
 check(core.applicationCommit==='70ee5ab00bd758c3de2b86e4f68ae76e69c82f1e'&&commit(core.harnessCommit),'Source commit mismatch');
 const created=timestamp(core.createdAt);check(options.now>=created&&options.now-created<=900000,'Launch core stale or future');
 verifyLimits(core.limits);check(canonicalHash(core.processLimits)===canonicalHash(LAUNCH_LIMITS),'Process limits changed');verifyDiscovery([core.discovery]);
 exact(core.sources,AUTHORITY_SOURCES);for(const ref of Object.values(core.sources))r.read(ref);
 exact(core.tools,['node','git','playwright','psql','taskkill','tls']);for(const ref of Object.values(core.tools))r.read(ref);
 const roleFiles=[...Object.values(core.sources),...Object.values(core.tools),core.package,core.preflight,core.baseline,core.config,core.spec].map(ref=>ref?.file);
 check(new Set(roleFiles).size===roleFiles.length,'Source/tool/core evidence roles must not alias');
 // These are hash-bound snapshots/captures, not a clean-worktree/binary attestation.
 for(const ref of [core.package,core.preflight,core.config,core.spec])r.read(ref);
 const b=r.json(core.baseline);exact(b,['schema','runId','target','project','organization','worker','capturedAt','sourceCommit','deploymentId','versionId','trafficPercent','flags','config','index','assets','evidence']);
 check(b.schema==='u1-baseline-descriptor-v1'&&b.runId===core.runId,'Baseline identity mismatch');target(b);
 check(commit(b.sourceCommit)&&uuid(b.deploymentId)&&uuid(b.versionId)&&b.trafficPercent===100,'Incomplete baseline deployment');
 const captured=timestamp(b.capturedAt);check(captured<=created&&created-captured<=900000,'Baseline capture stale or future');
 r.read(b.flags);r.read(b.config);
 function http(item,index=false){exact(item,['path','status','redirects','body']);check(item.status===200&&Array.isArray(item.redirects)&&item.redirects.length===0,'HTTP capture failed or redirected');check(index?item.path==='/':/^\/assets\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(?:js|css)$/.test(item.path),'Invalid baseline asset path');r.read(item.body);}
 http(b.index,true);check(Array.isArray(b.assets)&&b.assets.length>0&&b.assets.length<=256,'Bounded complete asset map required');
 const paths=b.assets.map(a=>a.path);check(new Set(paths).size===paths.length&&canonicalHash(paths)===canonicalHash([...paths].sort()),'Asset paths must be sorted and unique');b.assets.forEach(a=>http(a));
 exact(b.evidence,['provider','config','assets','protectedParity','restoreProof']);for(const ref of Object.values(b.evidence))r.read(ref);
 const baselineFiles=[b.flags,b.config,b.index.body,...b.assets.map(a=>a.body),...Object.values(b.evidence)].map(ref=>ref.file);
 const allRoleFiles=[...roleFiles,...baselineFiles];check(new Set(allRoleFiles).size===allRoleFiles.length,'Baseline evidence roles must not alias');
 const provider=r.json(b.evidence.provider);exact(provider,['schema','runId','target','project','organization','worker','deploymentId','versionId','trafficPercent','sourceCommit','indexSha256','configSha256','flagsSha256']);
 check(provider.schema==='u1-baseline-provider-v1'&&provider.runId===core.runId,'Provider capture identity mismatch');target(provider);
 for(const k of ['deploymentId','versionId','trafficPercent','sourceCommit'])check(provider[k]===b[k],'Provider descriptor disagreement');
 check(provider.indexSha256===b.index.body.sha256&&provider.configSha256===b.config.sha256&&provider.flagsSha256===b.flags.sha256,'Provider asset/config disagreement');
 // A separately captured inventory binds every referenced asset (including chunks).
 const inventory=r.json(b.evidence.assets);exact(inventory,['schema','runId','versionId','indexSha256','assets']);
 check(inventory.schema==='u1-baseline-assets-v1'&&inventory.runId===core.runId&&inventory.versionId===b.versionId&&inventory.indexSha256===b.index.body.sha256,'Asset inventory identity mismatch');
 const expected=b.assets.map(a=>({path:a.path,sha256:a.body.sha256}));check(canonicalHash(inventory.assets)===canonicalHash(expected),'Incomplete asset inventory');
 exact(options.approvals,['reviewer','tester']);const reviewers=new Set();const coreHash=canonicalHash(core);
 for(const role of ['reviewer','tester']){const a=r.json(options.approvals[role]);exact(a,['schema','role','reviewedBy','scope','decision','runId','coreHash','approvedAt']);check(a.schema==='u1-launch-approval-v1'&&a.role===role&&a.scope==='u1-launch-core'&&a.decision==='approved'&&a.runId===core.runId&&a.coreHash===coreHash,'Outer approval binding mismatch');check(typeof a.reviewedBy==='string'&&/^[A-Za-z0-9_-]{3,80}$/.test(a.reviewedBy)&&!reviewers.has(a.reviewedBy),'Distinct reviewers required');reviewers.add(a.reviewedBy);const approved=timestamp(a.approvedAt);check(approved>=created&&approved<=options.now,'Approval chronology mismatch');}
 r.recheck();
 return freeze({status:'offline-contract-validated',liveAdmission:false,signerAuthenticityVerified:false,liveSourceAndToolsVerified:false,completeAssetDiscoveryVerified:false,preflightSemanticsVerified:false,packageSemanticsVerified:false,runId:core.runId,coreHash,baselineHash:core.baseline.sha256,limits:U1_LIMITS,identity:U1_IDENTITY});
}
