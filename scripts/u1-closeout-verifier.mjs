// Read-only local evidence verification, never cleanup/deployment execution.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalHash} from './u1-data-reconciler.mjs';
import {validateLaunchAuthority,AUTHORITY_TARGET} from './u1-launch-authority.mjs';
import {loadBrowserPackage} from './u1-browser-database-adapter.mjs';
import {verifyEvidenceFiles} from './reconcile-u1-evidence.mjs';
import {U1_IDENTITY,U1_LIMITS} from './u1-playwright-runner.mjs';
import {PROTECTED_TABLES} from './u1-protected-reader.mjs';
import {analyticsBusinessDate} from './u1-installed-contract.mjs';
const check=(v,m)=>{if(!v)throw new Error(m);};
const exact=(v,ks)=>check(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...ks].sort().join(','),'Unexpected closeout fields');
const sha=b=>createHash('sha256').update(b).digest('hex');
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const stamp=s=>{check(typeof s==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s)&&new Date(s).toISOString()===s,'Invalid closeout time');return Date.parse(s);};
const same=(a,b,m)=>check(canonicalHash(a)===canonicalHash(b),m);
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
export const CLOSEOUT_FLOORS=Object.freeze(['openSessions','openTabs','unbilledHops','incompleteOperationalMutations','incompleteFinancialMutations']);
export const CLOSEOUT_RESIDUES=Object.freeze(['activeOwnedSessions','activeOwnedTabs','unbilledOwnedHops','ambiguousSubmissions','pendingQueues','unexpectedMutations']);
function reader(root){
 check(typeof root==='string'&&path.isAbsolute(root)&&!root.startsWith('\\\\')&&fs.realpathSync(root)===path.resolve(root)&&!fs.lstatSync(root).isSymbolicLink(),'Canonical private root required');
 const seen=new Map();let total=0;
 const read=ref=>{exact(ref,['file','sha256']);check(typeof ref.file==='string'&&ref.file.toLowerCase()!=='credentials.json'&&/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(ref.file)&&hash(ref.sha256),'Invalid closeout reference');const file=path.join(root,ref.file),s=fs.lstatSync(file);check(s.isFile()&&!s.isSymbolicLink()&&fs.realpathSync(file)===file&&s.size>0&&s.size<=64*1024*1024,'Invalid or oversized evidence');total+=s.size;check(total<=256*1024*1024,'Closeout read budget');const b=fs.readFileSync(file);check(b.length===s.size&&sha(b)===ref.sha256,'Closeout evidence drift');if(seen.has(file))check(seen.get(file)===ref.sha256,'Conflicting evidence reference');seen.set(file,ref.sha256);return b;};
 return {read,json:ref=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(read(ref))),recheck(){for(const [file,d]of seen){const s=fs.lstatSync(file);check(s.isFile()&&!s.isSymbolicLink()&&fs.realpathSync(file)===file&&s.size<=64*1024*1024&&sha(fs.readFileSync(file))===d,'Evidence changed during closeout');}}};
}
export function verifyRunCloseout(options){
 exact(options,['artifactRoot','core','approvals','closeout','now']);check(Number.isSafeInteger(options.now),'Explicit closeout time required');
 const root=path.resolve(options.artifactRoot),r=reader(options.artifactRoot),c=r.json(options.closeout);
 exact(c,['schema','runId','coreHash','attempt','terminal','postflight','roleRetirement','providerRestoration','httpRestoration','failureApprovals']);check(c.schema==='u1-run-closeout-v1'&&hash(c.coreHash),'Wrong closeout schema');
 const refs=[options.closeout,options.core,...Object.values(options.approvals),...['attempt','terminal','postflight','roleRetirement','providerRestoration','httpRestoration'].map(k=>c[k])];check(new Set(refs.map(x=>x?.file)).size===refs.length,'Closeout roles must not alias');
 const attempt=r.json(c.attempt);exact(attempt,['schema','runId','coreHash','packageSha256','authorityValidatedAt','startedAt','attempt','retry']);
 check(attempt.schema==='u1-launch-attempt-v1'&&attempt.attempt===1&&attempt.retry===0,'Wrong single-attempt record');
 const admissionAt=stamp(attempt.authorityValidatedAt),startedAt=stamp(attempt.startedAt);check(startedAt>=admissionAt&&startedAt-admissionAt<=1000,'Admission must immediately precede attempt');
 const authority=validateLaunchAuthority({artifactRoot:root,core:options.core,approvals:options.approvals,now:admissionAt}),core=r.json(options.core);
 check(c.runId===authority.runId&&c.coreHash===authority.coreHash&&attempt.runId===c.runId&&attempt.coreHash===c.coreHash&&attempt.packageSha256===core.package.sha256,'Closeout core/attempt mismatch');
 const packagePath=path.join(root,core.package.file);r.read(core.package);const pkg=loadBrowserPackage(packagePath,core.package.sha256);
 check(pkg.manifest.runId===c.runId,'Package run mismatch');exact(pkg.closeoutPolicy,['schema','credentialFiles']);check(pkg.closeoutPolicy.schema==='u1-closeout-policy-v1','Missing approved closeout policy');same(pkg.closeoutPolicy.credentialFiles,['credentials.json'],'Unsupported credential inventory');
 const actorIds=['A','B'].map(k=>pkg.actors[k].id).sort();
 check(actorIds[0]!==actorIds[1]&&actorIds.every(id=>typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)),'Distinct canonical actor UUIDs required');
 const terminal=r.json(c.terminal);exact(terminal,['schema','runId','coreHash','attemptSha256','finishedAt','acceptance','child','browser','reconciliation']);
 check(terminal.schema==='u1-launch-terminal-v1'&&terminal.runId===c.runId&&terminal.coreHash===c.coreHash&&terminal.attemptSha256===c.attempt.sha256&&['passed','failed','inconclusive'].includes(terminal.acceptance),'Terminal binding mismatch');
 const ended=stamp(terminal.finishedAt);check(ended>=startedAt&&ended<=options.now,'Terminal chronology mismatch');
 exact(terminal.child,['exitObserved','exitCode']);check(typeof terminal.child.exitObserved==='boolean'&&(terminal.child.exitCode===null||Number.isInteger(terminal.child.exitCode)),'Invalid child exit');
 exact(terminal.browser,['status','identity','passed','failed','skipped','retries']);check(['passed','failed','not-run'].includes(terminal.browser.status)&&['passed','failed','skipped','retries'].every(k=>Number.isSafeInteger(terminal.browser[k])&&terminal.browser[k]>=0),'Invalid browser summary');same(terminal.browser.identity,U1_IDENTITY,'Wrong browser identity');check(terminal.browser.retries===0,'Retries forbidden');
 same([terminal.browser.passed,terminal.browser.failed,terminal.browser.skipped],terminal.browser.status==='passed'?[1,0,0]:terminal.browser.status==='failed'?[0,1,0]:[0,0,0],'Single-case browser summary mismatch');
 const common=['schema','runId','coreHash','attemptSha256','terminalSha256','capturedAt'];
 function receipt(ref,schema,fields){const v=r.json(ref);exact(v,[...common,...fields]);check(v.schema===schema&&v.runId===c.runId&&v.coreHash===c.coreHash&&v.attemptSha256===c.attempt.sha256&&v.terminalSha256===c.terminal.sha256,'Receipt binding mismatch');const t=stamp(v.capturedAt);check(t>=ended&&t<=options.now,'Receipt chronology mismatch');return v;}
 const p=receipt(c.postflight,'u1-postflight-v1',['outcome','floors','residues','initialAppStateHash','initialProtectedHash','expected','observed','historyPreserved','evidenceChainTailSha256','evidenceChainTail']);
 check(['reconciled-success','reconciled-failure','safety-unverified'].includes(p.outcome),'Unknown postflight outcome');exact(p.floors,CLOSEOUT_FLOORS);exact(p.residues,CLOSEOUT_RESIDUES);
 check([...Object.values(p.floors),...Object.values(p.residues)].every(x=>Number.isSafeInteger(x)&&x>=0)&&typeof p.historyPreserved==='boolean'&&hash(p.evidenceChainTailSha256),'Malformed floor/residue evidence');
 check(p.initialAppStateHash===pkg.manifest.initialAppStateHash&&p.initialProtectedHash===pkg.initialProtectedHash,'Initial state binding mismatch');
 check(p.expected.file!==p.observed.file,'Expected and observed captures must be distinct');
 const tail=r.json(p.evidenceChainTail);check(p.evidenceChainTail.sha256===p.evidenceChainTailSha256,'Evidence tail digest mismatch');
 if(terminal.acceptance!=='passed'){exact(tail,['schema','runId','coreHash','attemptSha256','terminalSha256','lastRecord']);check(tail.schema==='u1-failure-safety-tail-v1'&&tail.runId===c.runId&&tail.coreHash===c.coreHash&&tail.attemptSha256===c.attempt.sha256&&tail.terminalSha256===c.terminal.sha256,'Failure tail identity mismatch');const last=r.json(tail.lastRecord);check(['terminal','submission-failure','postflight'].includes(last.phase),'Missing actual failure-tail record');}
 const expected=r.json(p.expected),observed=r.json(p.observed);for(const v of [expected,observed])exact(v,['appState','protectedRows']);
 const pre=r.json(core.preflight);check(pre.appState&&Number.isSafeInteger(pre.appState.version),'Initial version required');
 check(pre.schema==='u1-package-preflight-v1'&&pre.runId===c.runId&&pre.project===AUTHORITY_TARGET.project&&pre.organization===AUTHORITY_TARGET.organization,'Preflight identity mismatch');
 check(canonicalHash(pre.appState)===pkg.manifest.initialAppStateHash&&canonicalHash(pre.protectedRows)===pkg.initialProtectedHash,'Actual preflight differs from package');
 const owned=new Set(pkg.pairs.flatMap(pair=>[pair.aId,pair.bId]));for(const phase of pkg.phases){for(const id of [phase.generated?.customerId,phase.auditId])if(id)owned.add(id);}
 const touchedDates=new Set(pkg.phases.flatMap(phase=>[phase.command.payload.session?.startedAt,phase.command.payload.startedAt]).filter(Boolean).map(analyticsBusinessDate));
 for(const state of [pre,expected,observed]){exact(state.protectedRows,[...PROTECTED_TABLES,'_unowned']);exact(state.protectedRows._unowned,PROTECTED_TABLES);for(const table of PROTECTED_TABLES)check(Array.isArray(state.protectedRows[table]),'Missing protected table projection');}
 same(pre.protectedRows._unowned,observed.protectedRows._unowned,'Unowned fingerprints changed');
 for(const table of PROTECTED_TABLES){const rows=observed.protectedRows[table];for(const before of pre.protectedRows[table]){if(table==='analytics_dirty_dates'&&before.organization_id==='org-primary'&&touchedDates.has(before.business_date))continue;if(owned.has(before.id))continue;const found=rows.filter(row=>table==='analytics_dirty_dates'?row.organization_id===before.organization_id&&row.business_date===before.business_date:row.id===before.id);check(found.length===1,'Preexisting unrelated row missing or duplicated');same(before,found[0],'Preexisting unrelated row changed');}}
 const appBefore=pre.appState,appAfter=observed.appState;check(appAfter&&typeof appAfter==='object'&&appAfter.data&&typeof appAfter.data==='object','App state projection required');
 const stableTop=v=>Object.fromEntries(Object.entries(v).filter(([k])=>!['version','updated_at','updated_by','data'].includes(k)));same(stableTop(appBefore),stableTop(appAfter),'Unrelated app state metadata changed');
 const stableData=v=>Object.fromEntries(Object.entries(v).filter(([k])=>!['sessions','auditLogs'].includes(k)));same(stableData(appBefore.data),stableData(appAfter.data),'Unrelated app state collections changed');
 for(const name of ['sessions','auditLogs']){const before=appBefore.data[name]??[],after=appAfter.data[name]??[];check(Array.isArray(before)&&Array.isArray(after),'App state collections must be arrays');same(before.filter(row=>!owned.has(row.id)),after.filter(row=>!owned.has(row.id)),'Unrelated app state rows changed');}
 let safety=terminal.child.exitObserved&&Object.values(p.floors).every(x=>x===0)&&Object.values(p.residues).every(x=>x===0)&&p.historyPreserved&&sameBoolean(expected,observed)&&Number.isSafeInteger(observed.appState?.version)&&observed.appState.version>=pre.appState.version;
 const roles=receipt(c.roleRetirement,'u1-role-retirement-v1',['actors','credentialFiles']);check(Array.isArray(roles.actors)&&roles.actors.length===2,'Exact retired actors required');roles.actors.forEach(a=>{exact(a,['id','active']);check(typeof a.active==='boolean','Invalid actor activity');});same(roles.actors.map(a=>a.id).sort(),actorIds,'Wrong retired actors');same(roles.credentialFiles,pkg.closeoutPolicy.credentialFiles,'Credential inventory mismatch');
 const credentialsAbsent=()=>{try{fs.lstatSync(path.join(root,'credentials.json'));return false;}catch(e){if(e.code==='ENOENT')return true;throw e;}};
 safety&&=roles.actors.every(a=>a.active===false)&&credentialsAbsent();
 const baseline=r.json(core.baseline);
 const provider=receipt(c.providerRestoration,'u1-provider-restoration-v1',['target','project','organization','worker','versionId','trafficPercent','configSha256','flagsSha256']);
 for(const [k,v]of Object.entries(AUTHORITY_TARGET))check(provider[k]===v,'Only staging restoration permitted');
 safety&&=provider.versionId===baseline.versionId&&provider.trafficPercent===100&&provider.configSha256===baseline.config.sha256&&provider.flagsSha256===baseline.flags.sha256;
 const http=receipt(c.httpRestoration,'u1-http-restoration-v1',['target','index','assets']);check(http.target===AUTHORITY_TARGET.target,'Wrong HTTP restoration target');
 function item(v){exact(v,['path','status','redirects','body']);check(typeof v.path==='string'&&Array.isArray(v.redirects)&&Number.isInteger(v.status),'Invalid HTTP capture');r.read(v.body);return v.status===200&&v.redirects.length===0;}
 check(Array.isArray(http.assets)&&http.assets.length<=256,'Bounded HTTP assets required');let httpOk=item(http.index);for(const a of http.assets)httpOk=item(a)&&httpOk;
 const expectedAssets=baseline.assets.map(a=>({path:a.path,sha256:a.body.sha256}));const actualAssets=http.assets.map(a=>({path:a.path,sha256:a.body.sha256}));
 safety&&=httpOk&&http.index.path==='/'&&http.index.body.sha256===baseline.index.body.sha256&&sameBoolean(actualAssets,expectedAssets);
 let accepted=false;
 if(terminal.acceptance==='passed'){
  check(terminal.child.exitObserved&&terminal.child.exitCode===0&&terminal.browser.status==='passed'&&terminal.browser.passed===1&&terminal.browser.failed===0&&terminal.browser.skipped===0,'Passed terminal contradicts child/browser');
  exact(terminal.reconciliation,['expected','observed','report']);const e=r.json(terminal.reconciliation.expected),o=r.json(terminal.reconciliation.observed),saved=r.json(terminal.reconciliation.report);
  check(e.generatedFieldPolicy==='u1-correlated-v1'&&e.authority?.packageFile===packagePath&&e.authority.packageSha256===core.package.sha256,'Correlated package-bound evidence required');
  same(e.authority,o.authority,'Evidence authority mismatch');
  const report=verifyEvidenceFiles(path.join(root,terminal.reconciliation.expected.file),terminal.reconciliation.expected.sha256,path.join(root,terminal.reconciliation.observed.file),{historical:false});
  same(p.evidenceChainTail,o.terminalRecord,'Postflight tail differs from reconciled ledger');
  check(report.status==='passed','Full run reconciliation failed');same(report,saved,'Saved report differs from recomputation');same(o.final,expected.appState,'Postflight app state differs from final run');same(o.finalProtectedRows,expected.protectedRows,'Postflight protected state differs from final run');
  accepted=p.outcome==='reconciled-success';
 }else check(terminal.reconciliation===null,'Failed run must not present success-only reconciliation');
 let failureApproved=false;
 if(terminal.acceptance==='passed')check(c.failureApprovals===null,'Successful run must use machine reconciliation');
 else if(c.failureApprovals!==null){
  exact(c.failureApprovals,['reviewer','tester']);
  const names=new Set(refs.map(x=>x.file));for(const ref of Object.values(c.failureApprovals)){check(!names.has(ref?.file),'Failure approval roles must not alias');names.add(ref.file);}
  for(const role of ['reviewer','tester']){const initial=r.json(options.approvals[role]),a=r.json(c.failureApprovals[role]);exact(a,['schema','role','reviewedBy','scope','decision','runId','coreHash','attemptSha256','terminalSha256','postflightSha256','expectedSha256','observedSha256','evidenceChainTailSha256','approvedAt']);check(a.schema==='u1-failure-postflight-approval-v1'&&a.role===role&&a.reviewedBy===initial.reviewedBy&&a.scope==='u1-failure-safety-postflight'&&a.decision==='approved'&&a.runId===c.runId&&a.coreHash===c.coreHash&&a.attemptSha256===c.attempt.sha256&&a.terminalSha256===c.terminal.sha256&&a.postflightSha256===c.postflight.sha256&&a.expectedSha256===p.expected.sha256&&a.observedSha256===p.observed.sha256&&a.evidenceChainTailSha256===p.evidenceChainTailSha256,'Failure postflight approval mismatch');const t=stamp(a.approvedAt);check(t>=stamp(p.capturedAt)&&t<=options.now,'Failure approval chronology mismatch');}
  failureApproved=true;
 }
 safety&&=p.outcome!=='safety-unverified';r.recheck();safety&&=credentialsAbsent();
 const status=accepted&&safety?'run-passed-closeout-verified':terminal.acceptance!=='passed'&&p.outcome==='reconciled-failure'&&safety&&failureApproved?'run-failed-safety-reconciled':'run-failed-safety-unresolved';
 return freeze({schema:'u1-closeout-verdict-v1',status,runId:c.runId,coreHash:c.coreHash,attemptSha256:c.attempt.sha256,terminalSha256:c.terminal.sha256,closeoutSha256:options.closeout.sha256,productionAuthorized:false,liveCaptureAuthenticityVerified:false,failureHistoryMachineVerified:false,failureReconciliationBasis:failureApproved?'dual-independent-postflight-review':'none',limits:U1_LIMITS});
}
function sameBoolean(a,b){return canonicalHash(a)===canonicalHash(b);}
