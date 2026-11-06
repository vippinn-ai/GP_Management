import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {SUPERVISED_LIMITS,SUPERVISED_SOURCES,verifySupervisedSourceHashes,verifySupervisedEvidence} from './u1-supervised-evidence.mjs';
import {U1BrowserDatabaseAdapter} from './u1-browser-database-adapter.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const sourceRoot=path.resolve(import.meta.dirname,'..');
const sourceHashes=()=>Object.fromEntries(SUPERVISED_SOURCES.map(name=>[name,sha(fs.readFileSync(path.join(sourceRoot,name)))]));

test('fixed supervised caps and exact current source inventory are package bound',()=>{
 assert.deepEqual(SUPERVISED_LIMITS,{recordBytes:32*1024*1024,indexBytes:1024*1024,workingBytes:128*1024*1024,totalRecordBytes:1024*1024*1024,maxRecords:1354,successRecords:1353,deadlineMs:1200000});
 assert.equal(new Set(SUPERVISED_SOURCES).size,SUPERVISED_SOURCES.length);assert.ok(SUPERVISED_SOURCES.includes('scripts/u1-supervised-evidence.nodechecks.mjs'));
 const pkg={supervisedLimits:structuredClone(SUPERVISED_LIMITS),supervisedSourceHashes:sourceHashes()};assert.doesNotThrow(()=>verifySupervisedSourceHashes(pkg));
 for(const mutate of [p=>p.supervisedLimits.maxRecords=1355,p=>p.supervisedLimits.deadlineMs++,p=>p.supervisedSourceHashes[SUPERVISED_SOURCES[0]]='0'.repeat(64),p=>delete p.supervisedSourceHashes[SUPERVISED_SOURCES[0]],p=>p.supervisedSourceHashes.extra='0'.repeat(64)]){const changed=structuredClone(pkg);mutate(changed);assert.throws(()=>verifySupervisedSourceHashes(changed));}
});

function withIndex(fn){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'u1-supervised-index-')));try{const write=value=>{const file=path.join(dir,'supervised-index.json'),bytes=Buffer.from(JSON.stringify(value));fs.writeFileSync(file,bytes,{flag:'wx'});return{file,sha256:sha(bytes)}};fn({dir,write});}finally{fs.rmSync(dir,{recursive:true,force:true});}}
const baseIndex=(count,status='completed-unverified')=>({schema:'u1-supervised-index-v1',evidenceMode:'u1-supervised-numbered-v1',authority:{},sourceHashes:{},limits:SUPERVISED_LIMITS,runId:'u1-supervised-offline',project:'tkbdyzxwwbhkpztgjjxh',organization:'org-primary',attempt:1,retry:0,status,samples:[],records:Array.from({length:count},(_,ordinal)=>({file:`${String(ordinal).padStart(5,'0')}-terminal.json`,sha256:'0'.repeat(64),ordinal,phase:'terminal',bytes:1})),terminalRecord:{},verifiedPhases:250,compatibilityCommits:100,initialAppStateHash:'0'.repeat(64),initialProtectedHash:'0'.repeat(64),finalAppStateHash:'0'.repeat(64),finalProtectedHash:'0'.repeat(64)});

test('success cardinality is exactly 1353; 1354 failed retention and 1355 never pass',()=>{
 withIndex(({write})=>{let saved=write(baseIndex(1354,'failed'));assert.throws(()=>verifySupervisedEvidence(saved.file,saved.sha256),/Failed or incomplete campaign/);});
 withIndex(({write})=>{let saved=write(baseIndex(1355));assert.throws(()=>verifySupervisedEvidence(saved.file,saved.sha256),/Incomplete record count/);});
 withIndex(({write})=>{let saved=write(baseIndex(1352));assert.throws(()=>verifySupervisedEvidence(saved.file,saved.sha256),/Incomplete record count/);});
});

test('index path, hash, schema, byte and unknown-field boundaries reject before records',()=>{
 withIndex(({dir,write})=>{const saved=write({...baseIndex(1353),extra:true});assert.throws(()=>verifySupervisedEvidence(saved.file,saved.sha256),/Unexpected evidence fields/);assert.throws(()=>verifySupervisedEvidence(saved.file,'0'.repeat(64)),/Index hash mismatch/);assert.throws(()=>verifySupervisedEvidence(path.join(dir,'other.json'),saved.sha256),/Fixed supervised index/);});
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'u1-supervised-large-')));try{const file=path.join(dir,'supervised-index.json');fs.writeFileSync(file,Buffer.of(1));fs.truncateSync(file,SUPERVISED_LIMITS.indexBytes+1);assert.throws(()=>verifySupervisedEvidence(file,'0'.repeat(64)),/oversized evidence/);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('co-rehashed missing, extra, reordered and duplicate references plus hardlink aliases reject',()=>{
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'u1-supervised-refs-')));
 try{
  const original=baseIndex(SUPERVISED_LIMITS.successRecords);
  for(const ref of original.records)fs.writeFileSync(path.join(dir,ref.file),'x',{flag:'wx'});
  const write=value=>{const file=path.join(dir,'supervised-index.json'),bytes=Buffer.from(JSON.stringify(value));fs.writeFileSync(file,bytes);return{file,sha256:sha(bytes)}};
  for(const mutate of [
   value=>value.records.pop(),
   value=>value.records.push({...value.records.at(-1),ordinal:value.records.length,file:`${String(value.records.length).padStart(5,'0')}-terminal.json`}),
   value=>[value.records[0],value.records[1]]=[value.records[1],value.records[0]],
   value=>value.records[1]=structuredClone(value.records[0]),
  ]){const changed=structuredClone(original);mutate(changed);const saved=write(changed);assert.throws(()=>verifySupervisedEvidence(saved.file,saved.sha256));}
  const saved=write(original),alias=path.join(dir,'index-alias.json');fs.linkSync(saved.file,alias);assert.throws(()=>verifySupervisedEvidence(saved.file,saved.sha256),/aliased/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('writer caps poison the adapter and prohibit every later POST',async()=>{
 const make=()=>{const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'u1-supervised-writer-'))),post={count:0};const adapter=Object.create(U1BrowserDatabaseAdapter.prototype);Object.assign(adapter,{evidenceMode:'u1-supervised-numbered-v1',errors:[],pkg:{authority:{},supervisedSourceHashes:{},manifest:{runId:'offline'}},initialState:null,current:null,expectedProtected:null,latestRows:null,bindings:{},generatedIds:new Set(),recordIndex:[],pending:null,finalSnapshot:null,coordinatorState:null,sequence:0,numberedBytes:0,directory,pages:{A:{request:{post:async()=>{post.count++;}}}}});return{adapter,directory,post};};
 const cases=[
  adapter=>adapter.assertSupervisedWorking({payload:'x'.repeat(SUPERVISED_LIMITS.workingBytes)}),
  adapter=>adapter.record({phase:'oversized',payload:'x'.repeat(SUPERVISED_LIMITS.recordBytes)}),
  adapter=>{adapter.numberedBytes=SUPERVISED_LIMITS.totalRecordBytes;return adapter.record({phase:'total'});},
  adapter=>{adapter.sequence=SUPERVISED_LIMITS.maxRecords;return adapter.record({phase:'count'});},
  adapter=>{adapter.recordIndex=Array.from({length:12000},(_,ordinal)=>({file:`${ordinal}.json`,sha256:'0'.repeat(64),ordinal,phase:'evidence',bytes:1}));return adapter.record({phase:'index'});},
 ];
 for(const trigger of cases){const {adapter,directory,post}=make();try{await assert.rejects(async()=>trigger(adapter));assert.ok(adapter.errors.length>0);await assert.rejects(()=>adapter.executePhase(0),/Browser errors prohibit further mutations|Supervised working state rejected/);assert.equal(post.count,0);}finally{fs.rmSync(directory,{recursive:true,force:true});}}
});
