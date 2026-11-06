// Compact offline authority. No receipts, credentials, network or admission.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {buildCommandPlan} from './u1-command-plan.mjs';
import {buildResultExpectations,protectedTemplateAt} from './u1-result-expectations.mjs';
import {canonicalHash} from './u1-data-reconciler.mjs';
const check=(v,m)=>{if(!v)throw new Error(m);};
const clone=v=>structuredClone(v);
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const providers=new WeakMap();
const pins={'u1-command-plan.mjs':'67b3229f7af6a9e3606ba8e79efc8bc48dfd87377c8bcc27d9a11cbf27b48f5e','u1-result-expectations.mjs':'374f29df5f18906125a1fdd7cbf1abbc7b0b6605f95e4f2a6019324e89f2917c'};
function plain(value){if(value&&typeof value==='object'){check(Array.isArray(value)||Object.getPrototypeOf(value)===Object.prototype,'Plain inputs only');for(const key of Reflect.ownKeys(value)){check(typeof key==='string','Symbol input forbidden');const d=Object.getOwnPropertyDescriptor(value,key);check('value'in d,'Getter input forbidden');plain(d.value);}}}
function internal(provider){check(providers.has(provider),'Builder-owned expectation provider required');return providers.get(provider);}
export function prepareRuntimeExpectations(options){
 plain(options);for(const[name,hash]of Object.entries(pins))check(createHash('sha256').update(fs.readFileSync(new URL(name,import.meta.url))).digest('hex')===hash,'Frozen expectation source drift');
 const oracle=buildResultExpectations(options),plan=buildCommandPlan(options.commandInputs);
 const draftBytes=fs.readFileSync(options.commandInputs.draftFile);check(createHash('sha256').update(draftBytes).digest('hex')===options.commandInputs.draftSha256,'Draft changed during preparation');const draft=JSON.parse(draftBytes);
 const phases=plan.phases.map((p,index)=>({id:p.id,pairIndex:p.pairIndex,role:p.role,operation:p.operation,actorSlot:p.actorSlot,actorId:p.actorId,entityId:p.entityId,mutationId:p.mutationId,auditId:p.auditId,command:clone(p.command),generated:{id:p.id,operation:p.operation,entityId:p.entityId,actorId:p.actorId,mutationId:p.mutationId,auditId:p.auditId,...(p.operation==='reject_session'?{}:{customerId:p.customerId,customerWrite:p.operation==='start_session'?'insert':'update'})},plan:{operation:p.operation,outcome:'committed',actor:p.actorId,patches:clone(p.compatibility.patches)},uiParity:clone(oracle.phases[index].uiParity),deltaHash:oracle.phases[index].deltaHash}));
 const manifest=clone(draft.inputManifest);manifest.pairs=clone(oracle.pairs);manifest.intents=phases.filter(p=>p.role==='save-b').map(p=>({rpc:'save_live_session_details',payload:clone(p.command),entityId:p.entityId,actorId:p.actorId,mutationId:p.mutationId,auditId:p.auditId}));
 const descriptor={schema:'u1-runtime-expectations-v1',oracleHash:oracle.hash,planHash:plan.planHash,sourcePins:{...pins,installed:oracle.sourcePins,definitions:oracle.definitionPins},manifest,actors:clone(draft.inputManifest.actors),pairs:clone(oracle.pairs),phases,initialProtectedHash:draft.inputManifest.initialProtectedHash};
 check(Buffer.byteLength(JSON.stringify(descriptor))<=64*1024*1024,'Compact descriptor byte ceiling');
 const expectationHash=canonicalHash(descriptor),provider=Object.freeze({schema:'u1-runtime-provider-v1',expectationHash});providers.set(provider,{descriptor:freeze(descriptor),oracle,inputs:freeze(clone(options)),package:null});return provider;
}
// Preparation fields intentionally omit proofs/assets/schema/admission. A separate
// reviewed packager must collect real receipts and use the unchanged loader gates.
export function runtimePackageFields(provider){const {descriptor:d,inputs}=internal(provider);return freeze({expectationPolicy:d.schema,expectationInputs:clone(inputs),manifest:{...clone(d.manifest),expectationHash:provider.expectationHash},actors:clone(d.actors),pairs:clone(d.pairs),phases:d.phases.map(({uiParity,...p})=>clone(p)),initialProtectedHash:d.initialProtectedHash});}
export function bindRuntimePackage(provider,pkg){
 const state=internal(provider),expected=runtimePackageFields(provider);plain(pkg);
 check(state.package===null||state.package===pkg,'Provider already bound to another admitted object');
 for(const k of ['expectationPolicy','expectationInputs','manifest','actors','pairs','phases','initialProtectedHash'])check(canonicalHash(pkg[k])===canonicalHash(expected[k]),`Runtime package ${k} mismatch`);
 state.package=pkg;return true;
}
export function runtimePhase(provider,index){const s=internal(provider);check(s.package!==null&&Number.isInteger(index)&&index>=0&&index<250,'Invalid or unbound runtime phase');return freeze({...clone(s.descriptor.phases[index]),protectedRows:protectedTemplateAt(s.oracle,index)});}
export function runtimeFinalTemplate(provider){const s=internal(provider);check(s.package!==null,'Unbound runtime provider');return freeze(protectedTemplateAt(s.oracle,249));}
export function runtimePairs(provider){const s=internal(provider);check(s.package!==null,'Unbound runtime provider');return s.descriptor.pairs;}
// Existing adapter deliberately retains full per-phase audit snapshots. This
// avoids eager package expansion, not a bound on total runtime/evidence memory.
