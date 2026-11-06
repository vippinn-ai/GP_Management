// Partial offline plan only. Does not produce a browser-admissible package.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalHash,patchArrayById} from './u1-data-reconciler.mjs';
import {draftIdentityPlan,prepareDraft,APPLICATION_COMMIT,HARNESS_BASE_COMMIT} from './u1-package-builder.mjs';
import {expectedStartEventMetadata,postgresJsonbText} from './u1-installed-contract.mjs';
import {prepareInstalledPhase} from './u1-phase-expectations.mjs';
import {timestampMicros} from './u1-generated-fields.mjs';
import {U1_LIMITS} from './u1-playwright-runner.mjs';
const SOURCE_PINS={
 '../src/dataGateway/rpcClient.ts':'9d9023404d4055c40d8981d20515b945b8401c7874cd0354e2c032746a21f8b5',
 'u1-data-reconciler.mjs':'597613bc1e3ff1095006b2658e7e7419c19eb95d71f618244c78f3418a931db5',
 'u1-package-builder.mjs':'27aafc3d94b32b1b1def2ddb6b9060778c31e8dda372570f0f74dc6e89aaf42f',
 'u1-installed-contract.mjs':'a91b00c96177f31911a35af21d6e42538b68a53b570efa48c129c764bc07f5e1',
 'u1-phase-expectations.mjs':'ce63629edd8e198d2e5fe084ec622e38cacdf15fb7819a39efb2f96aa632e0d5',
 'u1-generated-fields.mjs':'1252df55d32ceda81fed1b1b3c980bc2fd531ece60b2cad40a85beee1a33e800',
 'u1-playwright-runner.mjs':'64ffb34606c7703cd93d385938173ce3e5302b058dec29335ea8ba4e669a6e11'};
const check=(ok,message)=>{if(!ok)throw new Error(message);};
const keys=(v,expected)=>check(v&&Object.keys(v).sort().join(',')===[...expected].sort().join(','),'Unexpected input fields');
const clone=v=>structuredClone(v);
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
function read(file,hash){check(path.isAbsolute(file)&&fs.realpathSync(file)===path.resolve(file),'Canonical authority file required');const size=fs.statSync(file).size;check(size>0&&size<=32*1024*1024,'Authority size bound');const b=fs.readFileSync(file);check(/^[a-f0-9]{64}$/.test(hash)&&createHash('sha256').update(b).digest('hex')===hash,'Authority bytes changed');return JSON.parse(b.toString('utf8'));}
export function buildCommandPlan({draftFile,draftSha256,inputsFile,inputsSha256}){
 for(const [name,sha] of Object.entries(SOURCE_PINS))check(createHash('sha256').update(fs.readFileSync(new URL(name,import.meta.url))).digest('hex')===sha,'Helper source drift');
 const draft=read(draftFile,draftSha256),input=read(inputsFile,inputsSha256);
 keys(input,['schema','runId','applicationCommit','harnessCommit','preflightSha256','draftSha256','initialAppState','initialProtectedRows','stationAuthority','clock','timings','closeReason']);
 check(input.schema==='u1-command-inputs-v1'&&input.applicationCommit===APPLICATION_COMMIT&&input.harnessCommit===HARNESS_BASE_COMMIT&&input.draftSha256===draftSha256,'Input source mismatch');
 check(draft.schema==='u1-package-preparation-draft-v1'&&draft.admitted===false&&draft.status==='draft-not-admitted'&&draft.proofs===null,'Draft authority required');
 const manifest=draft.inputManifest;
 check(manifest.project==='tkbdyzxwwbhkpztgjjxh'&&manifest.organization==='org-primary'&&manifest.baseURL==='https://gp-management-staging-pages.breakperfectgaminglounge.workers.dev'&&canonicalHash(manifest.limits)===canonicalHash(U1_LIMITS),'Staging/limits drift');
 check(canonicalHash(manifest)===draft.inputManifestHash&&manifest.runId===input.runId&&manifest.applicationCommit===input.applicationCommit&&manifest.harnessCommit===input.harnessCommit&&manifest.preflight.sha256===input.preflightSha256,'Draft manifest mismatch');
 const rebuilt=prepareDraft({runId:input.runId,applicationCommit:input.applicationCommit,harnessCommit:input.harnessCommit,baseURL:manifest.baseURL,preflightFile:manifest.preflight.path,preflightSha256:manifest.preflight.sha256,now:Date.parse(manifest.preflight.capturedAt),actors:manifest.actors,stationIds:[manifest.pairs[0].stationIdA,manifest.pairs[0].stationIdB]});
 check(canonicalHash(rebuilt.inputManifest)===canonicalHash(manifest),'Draft differs from bound preflight');
 const identities=draftIdentityPlan(input.runId);
 check(canonicalHash(manifest.scope)===canonicalHash(identities.scope)&&canonicalHash(input.initialAppState)===manifest.initialAppStateHash&&canonicalHash(input.initialProtectedRows)===manifest.initialProtectedHash,'Initial state/scope mismatch');
 check(Number.isSafeInteger(input.initialAppState.version)&&input.initialAppState.version>=0&&input.initialAppState.version<=2147483547,'Version overflow');
 check(input.initialAppState.id==='primary'&&Object.hasOwn(input.initialAppState,'updated_by')&&(input.initialAppState.updated_by===null||typeof input.initialAppState.updated_by==='string')&&input.initialAppState.data&&Array.isArray(input.initialAppState.data.sessions)&&Array.isArray(input.initialAppState.data.auditLogs),'Complete initial app_state row required');timestampMicros(input.initialAppState.updated_at);
 keys(input.stationAuthority,['path','sha256']);const authority=read(input.stationAuthority.path,input.stationAuthority.sha256);
 keys(authority,['schema','runId','applicationCommit','harnessCommit','preflightSha256','stations']);
 check(authority.schema==='u1-approved-station-pricing-v1'&&['runId','applicationCommit','harnessCommit','preflightSha256'].every(k=>authority[k]===input[k]),'Station authority binding mismatch');
 check(Array.isArray(authority.stations)&&authority.stations.length===2,'Exactly two approved stations required');
 for(const s of authority.stations){keys(s,['id','organization_id','name','active','mode','ltpEnabled','pricingSnapshot']);check(s.ltpEnabled===false&&typeof s.id==='string'&&s.id.length<=128&&s.organization_id==='org-primary'&&s.active===true&&s.mode==='timed'&&typeof s.name==='string'&&s.name.trim()&&s.name.length<=128&&Array.isArray(s.pricingSnapshot)&&s.pricingSnapshot.length>0&&s.pricingSnapshot.length<=32,'Plain timed station required');
  postgresJsonbText(s);check(new Set(s.pricingSnapshot.map(r=>r.id)).size===s.pricingSnapshot.length,'Duplicate pricing ID');for(const r of s.pricingSnapshot){keys(r,['id','stationId','label','startMinute','endMinute','hourlyRate']);check(r.stationId===s.id&&typeof r.id==='string'&&r.id.trim()&&r.id.length<=128&&typeof r.label==='string'&&r.label.length<=128&&[r.startMinute,r.endMinute,r.hourlyRate].every(Number.isSafeInteger)&&r.startMinute>=0&&r.endMinute>r.startMinute&&r.endMinute<=1440&&r.hourlyRate>=0,'Invalid approved pricing row');}
  check(s.pricingSnapshot.every((r,i)=>i===0||r.startMinute>=s.pricingSnapshot[i-1].startMinute),'Approved pricing order mismatch');
 }
 check(new Set(authority.stations.map(s=>s.id)).size===2,'Duplicate station');
 check(new Set(authority.stations.map(s=>s.name)).size===2,'Distinct station names required');const priceIds=authority.stations.flatMap(s=>s.pricingSnapshot.map(r=>r.id));check(new Set(priceIds).size===priceIds.length,'Globally unique pricing IDs required');
 const actors=manifest.actors;check(actors&&Object.keys(actors).sort().join(',')==='A,B','Exact actors required');
 for(const a of Object.values(actors)){keys(a,['id','role','active','organization']);check(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(a.id)&&a.active===true&&a.organization==='org-primary'&&['admin','manager','receptionist'].includes(a.role),'Actor binding invalid');}check(actors.A.id!==actors.B.id,'Distinct actors required');
 keys(input.clock,['earliest','latest']);const low=timestampMicros(input.clock.earliest),high=timestampMicros(input.clock.latest),capture=timestampMicros(manifest.preflight.capturedAt);
 check(high>=low&&high-low<=900000000n&&capture>=low&&capture<=high,'Explicit bounded command clock required');
 check(Array.isArray(input.timings)&&input.timings.length===50,'Exactly 50 timing tuples required');
 check(typeof input.closeReason==='string'&&input.closeReason===input.closeReason.trim()&&input.closeReason.length>0&&input.closeReason.length<=256,'Explicit bounded trimmed close reason required');postgresJsonbText(input.closeReason);
 let state=clone(input.initialAppState);const phases=[];const sessions=[];
 for(let pairIndex=0;pairIndex<50;pairIndex++){
  const pair=identities.pairs[pairIndex],bound=manifest.pairs[pairIndex],time=input.timings[pairIndex];keys(time,['index','startA','startB','saveB','endA','endB']);check(time.index===pairIndex,'Timing order mismatch');
  check(Object.entries(pair).every(([k,v])=>bound[k]===v),'Pair identity substitution');
  const clocks=['startA','startB','saveB','endA','endB'].map(k=>timestampMicros(time[k]));check(clocks.every(t=>t>=low&&t>=capture&&t<=high)&&clocks[0]<=clocks[2]&&clocks[1]<=clocks[2]&&clocks[2]<=clocks[3]&&clocks[3]<=clocks[4],'Invalid command chronology');
  for(let offset=0;offset<5;offset++){
   const identity=identities.phases[pairIndex*5+offset],slot=identity.actorSlot,actor=actors[slot].id;
   const station=authority.stations.find(s=>s.id===(slot==='A'?bound.stationIdA:bound.stationIdB));check(station,'Missing bound station');
   const at=time[['startA','startB','saveB','endA','endB'][offset]],name=offset===0?pair.customerA:offset===1?pair.customerBBefore:pair.customerBAfter;
   const action=offset<2?'session_started':offset===2?'session_details_updated':'session_rejected';
   const audit={id:identity.auditId,action,entityType:'session',entityId:identity.entityId,userId:actor,createdAt:at,message:offset>=3?`Rejected ${station.name}. Reason: ${input.closeReason}`:`U1 ${identity.role}`};
   let payload,session;
   if(offset<2){session={id:identity.entityId,stationId:station.id,stationNameSnapshot:station.name,mode:'timed',startedAt:at,status:'active',customerId:identity.customerId,customerName:name,customerPhone:null,playMode:'group',ltpEligible:false,pricingSnapshot:clone(station.pricingSnapshot),items:[],comboApplications:[],pauseLogIds:[],continuedFromSessionIds:[],closedBillId:null};payload={session,customer:{id:identity.customerId,name,phone:null,visitAt:at},stockMovements:[],auditLogs:[audit]};}
   else {session=clone(sessions.find(s=>s.id===identity.entityId).raw_data);if(offset===2){session={...session,customerName:name,customerPhone:null,startedAt:at};payload={sessionId:identity.entityId,customerName:name,customerPhone:null,startedAt:at,customer:{id:identity.customerId,name,phone:null,visitAt:at},auditLog:audit};}
    else{session={...session,status:'closed',endedAt:at,closeDisposition:'rejected',closeReason:input.closeReason,closedBillId:null,continuedFromSessionIds:[]};payload={session,auditLog:audit};}}
   const command={organization_id:'org-primary',mutation_id:identity.mutationId,mutation_kind:offset<2?'startSession':offset===2?'saveLiveSessionDetails':'rejectSession',label:`U1 ${identity.role}`,entity_type:'session',entity_id:identity.entityId,user_id:actor,client_created_at:at,base_app_state_version:state.version,payload};postgresJsonbText(command);
   const checkedIntent=prepareInstalledPhase({sessions,analytics_dirty_dates:input.initialProtectedRows.analytics_dirty_dates},identity.operation,command);
   const {before:ignoredBefore,...dateIntent}=checkedIntent;
   const installedIntent={...dateIntent,before:null,scope:'date-and-start-metadata-only-not-sequential-analytics'};
   if(offset<2)expectedStartEventMetadata(command,'event-pending');
   const row={id:identity.entityId,organization_id:'org-primary',status:session.status,started_at:session.startedAt,closed_bill_id:null,raw_data:clone(session)};
   const si=sessions.findIndex(s=>s.id===row.id);if(si<0)sessions.push(row);else sessions[si]=row;
   const beforeHash=canonicalHash(state),patches=offset<3?{}:{sessions:[clone(session)],auditLogs:[clone(audit)]};
   if(offset>=3){state={...state,version:state.version+1,updated_by:actor,updated_at:{$generated:'serverTime',phase:identity.id},data:{...state.data,sessions:patchArrayById(state.data.sessions??[],patches.sessions),auditLogs:patchArrayById(state.data.auditLogs??[],patches.auditLogs)}};}
   phases.push({...identity,actorId:actor,command,commandHash:canonicalHash(command),installedIntent,compatibility:{hashKind:'symbolic-compatibility-template',beforeTemplateHash:beforeHash,afterTemplateHash:canonicalHash(state),expectedVersion:state.version,patches,updatedAt:clone(state.updated_at)},normalizedGeneratedSlots:{eventId:{$generated:'eventId',phase:identity.id},auditTime:{$generated:'serverTime',phase:identity.id}},fullProtectedRows:null});
  }
 }
 const result={schema:'u1-command-plan-draft-v1',status:'partial-not-admitted',finalAdmission:false,inputBindings:{draftFile,draftSha256,inputsFile,inputsSha256,stationAuthority:clone(input.stationAuthority)},runId:input.runId,pairs:clone(manifest.pairs),phases,finalExpectedCompatibility:state,compatibilityCommits:100,fullProtectedFold:null,missing:['full normalized session/customer/audit/operational_event/Activity column and default templates','Activity profile label and source-trigger projections','sequential analytics full expected row templates','runtime generated timestamp windows and all protected slot bindings','UI parity expectations','independent full package receipts and live admission']};
 result.sourcePins=SOURCE_PINS;result.missing.push('scoped runtime materialization of compatibility timestamp references','outer one-shot launcher','full RPC envelopes are not compatible with frozen prepareSessionReject exact-key utility','fresh live preflight: structural prepareDraft replay uses capturedAt as now, not current freshness validation');
 check(Buffer.byteLength(JSON.stringify(result))<=64*1024*1024,'Serialized draft exceeds 64MiB ceiling');
 result.planHash=canonicalHash(result);return freeze(result);
}
