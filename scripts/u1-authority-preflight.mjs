// Read-only SQL preparation and offline validation; no execution or file writes.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {buildCombinedPreflight,decodePreflightCapture,PREFLIGHT_CAPTURE_LIMITS} from './u1-preflight-collector.mjs';
import {buildCommandPlan} from './u1-command-plan.mjs';
import {canonicalHash} from './u1-data-reconciler.mjs';
const check=(v,m)=>{if(!v)throw new Error(m);};
const sha=b=>createHash('sha256').update(b).digest('hex');
const keys=(v,k)=>check(v&&Object.keys(v).sort().join(',')===[...k].sort().join(','),'Unexpected authority fields');
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const pins={'u1-preflight-collector.mjs':'b702ae10c07298c60a18cafd41e108c441e11bfcb307101341f0b4cd942981df','u1-command-plan.mjs':'e4c6dd8164b1f3e3967b254443317f64c09b007f81a7f7ce991eaa0eae12f56c'};
const q=s=>`'${s}'`; // Only identifiers already admitted by the frozen collector.
const validated=new WeakMap();
// Exact scalar fallback semantics of the pinned application mapper. Only a
// small allowlisted raw-data projection is captured, never complete raw_data.
const stringValue=(v,f)=>typeof v==='string'&&v.trim()?v:f;
const numberValue=(v,f)=>{for(const x of [v,f]){if(typeof x==='number'&&Number.isFinite(x))return x;if(typeof x==='string'&&x.trim()&&Number.isFinite(Number(x)))return Number(x);}return 0;};
const booleanValue=(v,f)=>typeof v==='boolean'?v:typeof v==='string'&&v.toLowerCase()==='true'?true:typeof v==='string'&&v.toLowerCase()==='false'?false:f;
export function buildAuthorityPreflight(request){
 keys(request,['runId','applicationCommit','harnessCommit','actorIds','stationIds']);
 for(const [file,digest]of Object.entries(pins))check(sha(fs.readFileSync(new URL(file,import.meta.url)))===digest,'Authority preparation source drift');
 check(sha(fs.readFileSync(new URL('../src/dataGateway/normalizedReads.ts',import.meta.url)))==='b6898c81a5f4f85e6055c5ff24063586923ff1d14da79233c7d7a50ba7eae520','Application mapper source drift');
 const base=buildCombinedPreflight(request),marker='SELECT (',end=' AS evidence;\nROLLBACK;';
 const index=base.sql.indexOf(marker);check(index>0&&base.sql.endsWith(end),'Frozen SQL envelope drift');
 const expression=base.sql.slice(index+'SELECT '.length,-end.length);
 const actor=s=>`(select jsonb_build_object('id',p.id,'name',p.name,'username',p.username,'profileRole',p.role,'membershipRole',m.role,'resolvedRole',coalesce(m.role,p.role),'profileActive',p.active,'membershipActive',m.active,'organization',m.organization_id) from public.profiles p join public.organization_members m on m.user_id=p.id and m.organization_id='org-primary' where p.id=${q(request.actorIds[s])}::uuid)`;
 const stations=`(select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'organization_id',s.organization_id,'name',s.name,'active',s.active,'mode',s.mode,'ltpEnabled',s.ltp_enabled,'overrides',jsonb_build_object('mode',s.raw_data->'mode','active',s.raw_data->'active','ltpEnabled',s.raw_data->'ltpEnabled')) order by s.id),'[]'::jsonb) from public.stations s where s.organization_id='org-primary' and s.id in (${request.stationIds.map(q).join(',')}))`;
 // All organization rules are needed: raw stationId can move a rule into a
 // selected station. 257 is an overflow sentinel; decoder permits at most 256.
 const pricing=`(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'stationId',r.station_id,'label',r.label,'startMinute',r.start_minute,'endMinute',r.end_minute,'hourlyRate',r.hourly_rate,'overrides',jsonb_build_object('stationId',r.raw_data->'stationId','startMinute',r.raw_data->'startMinute','endMinute',r.raw_data->'endMinute','hourlyRate',r.raw_data->'hourlyRate')) order by r.station_id,r.start_minute),'[]'::jsonb) from (select id,station_id,label,start_minute,end_minute,hourly_rate,raw_data from public.pricing_rules where organization_id='org-primary' order by station_id,start_minute limit 257) r)`;
 const sql=base.sql.slice(0,index)+`SELECT jsonb_build_object('schema','u1-authority-preflight-v1','preflight',${expression},'actorDisplays',jsonb_build_object('A',${actor('A')},'B',${actor('B')}),'stationPricing',${stations},'pricingRules',${pricing})${end}`;
 return freeze({schema:'u1-authority-sql-v1',request:structuredClone(request),sql,sha256:sha(sql),base,limits:PREFLIGHT_CAPTURE_LIMITS,executorImplemented:false});
}
// Allows exclusive persistence by the caller before full validation. This is
// extraction only, never a successful preflight or a trusted authority.
export function extractAuthorityPreflight(bytes){
 check(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=PREFLIGHT_CAPTURE_LIMITS.maxBytes,'Authority capture byte bound');
 const e=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 keys(e,['schema','preflight','actorDisplays','stationPricing','pricingRules']);check(e.schema==='u1-authority-preflight-v1','Wrong authority capture schema');
 return Buffer.from(JSON.stringify(e.preflight)+'\n');
}
export function decodeAuthorityCapture(bytes,{generated,expectedSqlSha256,elapsedMs,preparation}){
 const preflightBytes=extractAuthorityPreflight(bytes),e=JSON.parse(bytes.toString('utf8'));
 const rebuilt=buildAuthorityPreflight(generated?.request);
 check(expectedSqlSha256===rebuilt.sha256&&canonicalHash(generated)===canonicalHash(rebuilt),'Authority SQL binding drift');
 check(preparation?.preflightSha256===sha(preflightBytes),'Derived preflight bytes mismatch');
 const decoded=decodePreflightCapture(preflightBytes,{generated:rebuilt.base,expectedSqlSha256:rebuilt.base.sha256,elapsedMs,preparation});
 keys(e.actorDisplays,['A','B']);
 const ascii=(v,max)=>typeof v==='string'&&v.length<=max&&/^[\x20-\x7e]*$/.test(v);
 for(const slot of ['A','B']){const a=e.actorDisplays[slot],b=decoded.evidence.actors[slot];
  keys(a,['id','name','username','profileRole','membershipRole','resolvedRole','profileActive','membershipActive','organization']);
  check(a.id===b.id&&a.profileRole===b.role&&a.membershipRole===b.role&&a.resolvedRole===b.role&&a.profileActive===true&&a.membershipActive===true&&a.organization==='org-primary'&&ascii(a.name,128)&&ascii(a.username,128),'Actor display authority mismatch');
 }
 check(Array.isArray(e.pricingRules)&&e.pricingRules.length<=256,'Organization pricing capture overflow');
 const rules=e.pricingRules.map(r=>{keys(r,['id','stationId','label','startMinute','endMinute','hourlyRate','overrides']);keys(r.overrides,['stationId','startMinute','endMinute','hourlyRate']);const o=r.overrides;return {id:r.id,stationId:stringValue(o.stationId,r.stationId??''),label:r.label,startMinute:numberValue(o.startMinute,r.startMinute),endMinute:numberValue(o.endMinute,r.endMinute),hourlyRate:numberValue(o.hourlyRate,r.hourlyRate)};});
 const sourceTuples=new Set();for(let i=0;i<rules.length;i++){if(!rebuilt.request.stationIds.includes(rules[i].stationId))continue;const tuple=JSON.stringify([e.pricingRules[i].stationId,e.pricingRules[i].startMinute]);check(!sourceTuples.has(tuple),'Ambiguous application pricing order');sourceTuples.add(tuple);}
 check(Array.isArray(e.stationPricing)&&e.stationPricing.length===2,'Exactly two station authorities required');
 const stations=e.stationPricing.map(s=>{keys(s,['id','organization_id','name','active','mode','ltpEnabled','overrides']);keys(s.overrides,['mode','active','ltpEnabled']);const {overrides:o,...v}=s;return {...v,mode:stringValue(o.mode,s.mode),active:booleanValue(o.active,s.active),ltpEnabled:booleanValue(o.ltpEnabled,s.ltpEnabled),pricingSnapshot:rules.filter(r=>r.stationId===s.id)};});
 const stationIds=new Set(),priceIds=new Set(),names=new Set();
 for(const s of stations){keys(s,['id','organization_id','name','active','mode','ltpEnabled','pricingSnapshot']);
  check(rebuilt.request.stationIds.includes(s.id)&&!stationIds.has(s.id)&&s.organization_id==='org-primary'&&s.active===true&&s.mode==='timed'&&s.ltpEnabled===false&&ascii(s.name,128)&&s.name.trim()&&!names.has(s.name),'Invalid station authority');stationIds.add(s.id);names.add(s.name);
  check(Array.isArray(s.pricingSnapshot)&&s.pricingSnapshot.length>0&&s.pricingSnapshot.length<=32,'Bounded explicit pricing required');let previousEnd=-1;
  for(const r of s.pricingSnapshot){keys(r,['id','stationId','label','startMinute','endMinute','hourlyRate']);
   check(ascii(r.id,128)&&r.id.trim()&&!priceIds.has(r.id)&&r.stationId===s.id&&ascii(r.label,128)&&[r.startMinute,r.endMinute,r.hourlyRate].every(Number.isSafeInteger)&&r.startMinute>=0&&r.startMinute>=previousEnd&&r.endMinute>r.startMinute&&r.endMinute<=1440&&r.hourlyRate>=0,'Unsupported or ambiguous pricing authority');priceIds.add(r.id);previousEnd=r.endMinute;
  }
 }
 const common={runId:rebuilt.request.runId,applicationCommit:rebuilt.request.applicationCommit,harnessCommit:rebuilt.request.harnessCommit,preflightSha256:sha(preflightBytes)};
 const result=freeze({status:'prepared-not-admitted',captureSha256:sha(bytes),sqlSha256:rebuilt.sha256,preflightSha256:common.preflightSha256,draft:decoded.draft,stationAuthority:{schema:'u1-approved-station-pricing-v1',...common,stations}});
 const actors=Object.fromEntries(Object.entries(e.actorDisplays).map(([slot,{profileActive,membershipActive,organization,...a}])=>[slot,a]));
 validated.set(result,{common,actors});return result;
}
// Plan hash is derived, not accepted from the caller. No successful run receipt
// or fresh capture is synthesized here; captures still require independent review.
export function bindActorAuthority(result,commandInputs){
 check(validated.has(result),'Validated capture instance required');
 const plan=buildCommandPlan(commandInputs),v=validated.get(result);
 const inputBytes=fs.readFileSync(commandInputs.inputsFile);check(sha(inputBytes)===commandInputs.inputsSha256,'Command input drift');const input=JSON.parse(inputBytes);
 check(plan.runId===v.common.runId&&input.preflightSha256===v.common.preflightSha256,'Plan targets another capture');
 const stationBytes=fs.readFileSync(input.stationAuthority.path);check(sha(stationBytes)===input.stationAuthority.sha256&&canonicalHash(JSON.parse(stationBytes))===canonicalHash(result.stationAuthority),'Plan pricing differs from captured authority');
 return freeze({schema:'u1-actor-display-authority-v1',...v.common,planHash:plan.planHash,actors:structuredClone(v.actors)});
}
