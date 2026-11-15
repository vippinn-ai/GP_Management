import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PROTECTED_GROUPS,buildProtectedReadParts,renderProtectedReadParts,renderProtectedReadExecution,renderProtectedReadRuntime,reassembleProtectedRead,reassembleProtectedRuntime} from './u1-protected-reader.mjs';
const scope={sessionIds:['session-a'],customerIds:[],auditIds:[],mutationIds:[],customerNames:[]};
function original(value){const identity={schema:'u1-protected-fragment-v1',kind:'protected',snapshot:'1:2:',backend:42,transactionAt:'2026-11-16T00:00:00Z'};return [{...identity,part:0,payload:{appState:value,floor:{openSessions:0}}},...PROTECTED_GROUPS.map((g,i)=>({...identity,part:i+1,payload:{protectedRows:{...Object.fromEntries(g.map(t=>[t,[]])),_unowned:Object.fromEntries(g.map(t=>[t,{count:0,md5:'0'.repeat(32)}]))}}}))].map(JSON.stringify).join('\n')+'\n';}
function frame(raw){const lines=raw.trimEnd().split('\n'),text=lines[0],v=JSON.parse(text);let total=0;for(const c of text)total++;const half=Math.ceil(total/2);let offset=0,n=0;for(const c of text){if(n++===half)break;offset+=c.length;}return [text.slice(0,offset),text.slice(offset)].map((p,i)=>JSON.stringify({schema:'u1-state-piece-v1',kind:'protected',part:0,piece:i,fromChar:i?half+1:1,chars:i?total-half:half,totalChars:total,totalBytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex'),snapshot:v.snapshot,backend:v.backend,transactionAt:v.transactionAt})+'\t'+p).concat(lines.slice(1));}
const bytes=lines=>Buffer.from(lines.join('\n')+'\n');
test('protected runtime changes only state SELECT; canonical authority/preflight transport stays four parts',()=>{
 const plan=buildProtectedReadParts(scope),canonical=renderProtectedReadParts(plan),execution=renderProtectedReadExecution(plan),runtime=renderProtectedReadRuntime(scope);
 const before='\\warn U1_READ_PHASE_V1 part0_before\n',after='\\warn U1_READ_PHASE_V1 part0_after\n',a=execution.indexOf(before)+before.length,b=execution.indexOf(after),c=runtime.indexOf(after);
 assert.equal(runtime.slice(0,a),execution.slice(0,a));assert.equal(runtime.slice(c),execution.slice(b));assert.equal((runtime.slice(a,c).match(/WITH state_text AS MATERIALIZED/g)||[]).length,2);assert.ok(!canonical.includes('state_text'));assert.equal((runtime.match(/^\\warn /gm)||[]).length,10);assert.equal((runtime.match(/^\\g$/gm)||[]).length,1);
 for(const kind of ['authority','preflight']){assert.throws(()=>renderProtectedReadRuntime({...scope,kind}));const alternate=renderProtectedReadParts({...plan,kind});assert.equal((alternate.match(/SELECT jsonb_build_object/g)||[]).length,4);assert.ok(!alternate.includes('u1-state-piece-v1'));}
});
test('five records reconstruct exact canonical full33 output including Unicode midpoint, escapes, nested/null/empty',()=>{
 for(const value of [null,{},[],{x:'a'},{x:'ab'},{x:'😀'.repeat(1000)},{x:'😀'.repeat(1001)},{x:'é漢字',q:'"\\\t\r\n'},{nested:[null,[],{},'']}]){const raw=original(value),parts=frame(raw);assert.equal(parts.length,5);assert.deepEqual(reassembleProtectedRuntime(bytes(parts)),reassembleProtectedRead(Buffer.from(raw)));assert.throws(()=>reassembleProtectedRuntime(Buffer.from(raw)));assert.throws(()=>reassembleProtectedRead(bytes(parts)));}
});
test('reject incomplete, reordered, duplicate, mixed identity, tampered coverage/digest/UTF8/limits and extra records',()=>{
 const lines=frame(original({x:'😀'.repeat(1001)}));for(const v of [lines.slice(1),[lines[1],lines[0],...lines.slice(2)],[lines[0],lines[0],...lines.slice(2)],[...lines,'{}']])assert.throws(()=>reassembleProtectedRuntime(bytes(v)));
 for(const edit of [h=>h.kind='authority',h=>h.kind='preflight',h=>h.piece=2,h=>h.fromChar++,h=>h.chars++,h=>h.totalChars++,h=>h.totalBytes++,h=>h.sha256='0'.repeat(64),h=>h.backend++,h=>h.snapshot='3:4:',h=>h.transactionAt='2026-01-01T00:00:00Z',h=>h.extra=true]){const copy=[...lines],at=copy[1].indexOf('\t'),h=JSON.parse(copy[1].slice(0,at));edit(h);copy[1]=JSON.stringify(h)+copy[1].slice(at);assert.throws(()=>reassembleProtectedRuntime(bytes(copy)));}
 for(const c of ['\t','\r','\n']){const copy=[...lines];copy[0]+=c;assert.throws(()=>reassembleProtectedRuntime(bytes(copy)));}
 const mixed=[...lines],r=JSON.parse(mixed[2]);r.backend++;mixed[2]=JSON.stringify(r);assert.throws(()=>reassembleProtectedRuntime(bytes(mixed)));
 assert.throws(()=>reassembleProtectedRuntime(Buffer.from([255,10])));assert.throws(()=>reassembleProtectedRuntime(bytes(lines).subarray(0,-1)));assert.throws(()=>reassembleProtectedRuntime(Buffer.alloc(32*1024*1024+1)));
});
test('approximately5MiB self-contained state preserves full canonical bytes without quoted-string expansion',()=>{
 const raw=original({id:'primary',version:756,data:{large:'x'.repeat(5*1024*1024),unicode:'😀漢字é'}}),parts=frame(raw),wire=bytes(parts);
 assert.ok(wire.length-Buffer.byteLength(raw)<2048);assert.deepEqual(reassembleProtectedRuntime(wire),reassembleProtectedRead(Buffer.from(raw)));
 const lengths=parts.slice(0,2).map(p=>Buffer.byteLength(p.slice(p.indexOf('\t')+1)));assert.ok(lengths.every(n=>n>2*1024*1024));
});
