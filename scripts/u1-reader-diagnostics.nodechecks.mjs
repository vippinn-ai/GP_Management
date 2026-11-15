import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { createProtectedReader, readFailureDiagnostic, PROTECTED_GROUPS, READ_PHASE_MARKERS, createReadPhaseObserver, buildProtectedReadParts, renderProtectedReadParts, renderProtectedReadExecution } from './u1-protected-reader.mjs';

const secret = 'synthetic-private-diagnostic-never-persist';
const metric = { code: 'U1_READ_SQL_TIMEOUT', readOrdinal: 1, elapsedMs: 100,
  stdoutBytes: 8, stderrBytes: 10, stdoutLines: 1, exitCode: 3 };
test('diagnostics retain only allowlisted codes and finite numeric fields', () => {
  assert.deepEqual(readFailureDiagnostic({ readDiagnostic: metric }), metric);
  for (const change of [{code:secret},{stderr:secret},{stdoutBytes:NaN},{elapsedMs:-1},
    {readOrdinal:1.5},{stdoutLines:Infinity},{exitCode:secret},{exitCode:256}])
    assert.equal(readFailureDiagnostic({readDiagnostic:{...metric,...change}}),null);
  assert.equal(readFailureDiagnostic(new Error(secret)),null);
  assert.equal(readFailureDiagnostic({get readDiagnostic(){throw Error(secret);}}),null);
  let count=0; const value={...metric};Object.defineProperty(value,'stdoutBytes',{enumerable:true,get(){return count++===0?8:secret;}});
  assert.equal(readFailureDiagnostic({readDiagnostic:value}).stdoutBytes,8);
});
const client={spawnMs:0,stdinMs:1,firstStdoutMs:null,firstStderrMs:2,closeMs:100};
const marker=id=>'U1_READ_PHASE_V1 '+id+'\n';
test('execution batches only four startup statements; canonical SQL and four-part scope unchanged',()=>{
 const plan=buildProtectedReadParts({sessionIds:['session-a'],customerIds:[],auditIds:['audit-a'],mutationIds:['mutation-a'],customerNames:[]});
 const canonical=renderProtectedReadParts(plan),execution=renderProtectedReadExecution(plan);
 const startup=canonical.slice(0,canonical.indexOf('DO $u1$ BEGIN\n'));
 const wire=startup.replaceAll(';','\\;')+'\\g\n';
 assert.ok(execution.startsWith(wire));assert.equal((wire.match(/\\;/g)||[]).length,4);
 const stripped=execution.replace(/^\\warn U1_READ_PHASE_V1 (?:guard|part[0-3])_(?:before|after)\n/gm,'');
 assert.equal(startup+stripped.slice(wire.length),canonical);
 assert.equal((execution.match(/^\\g$/gm)||[]).length,1);
 assert.throws(()=>renderProtectedReadExecution({...plan,header:plan.header.replace("lock_timeout='1s'","lock_timeout='2s'")}),/Fixed startup/);
 assert.equal((execution.match(/^\\warn /gm)||[]).length,10);assert.ok(!canonical.includes('\\warn'));
});
test('phase metadata retains only ordered client-observed prefix and rejects malformed diagnostics',()=>{
 const o=createReadPhaseObserver();let at=2;
 for(const b of Buffer.from('withheld unicode £\n'+READ_PHASE_MARKERS.slice(0,5).map(marker).join('')))o.consume(Buffer.from([b]),at++);
 const prefix=o.finish({...client,closeMs:at});assert.equal(prefix.valid,true);assert.equal(prefix.complete,false);assert.equal(prefix.markers.at(-1).stage,'part1_before');
 assert.deepEqual(readFailureDiagnostic({readDiagnostic:{...metric,phases:prefix}}).phases,prefix);
 assert.ok(!JSON.stringify(prefix).includes('unicode'));
 for(const changes of [{extra:secret},{markers:[{stage:secret,elapsedMs:2}]},{complete:true},{spawnMs:-1},{markers:[{stage:'guard_before',elapsedMs:NaN}]}])assert.equal(readFailureDiagnostic({readDiagnostic:{...metric,phases:{...prefix,...changes}}}),null);
 for(const bytes of [Buffer.from(marker('guard_after')),Buffer.from(marker('guard_before')+marker('guard_before')),Buffer.from(marker('unknown')),Buffer.from('x '+marker('guard_before')),Buffer.from([255,10]),Buffer.alloc(32769),Buffer.from('U1_READ_PHASE_V1 guard_before')]){const p=createReadPhaseObserver();p.consume(bytes,2);assert.deepEqual(p.finish(client).markers,[]);assert.equal(p.finish(client).valid,false);}
 const full=createReadPhaseObserver();full.consume(Buffer.from(READ_PHASE_MARKERS.map(marker).join('')),2);assert.equal(full.finish(client).complete,true);
});

const envelope = () => {
  const common={schema:'u1-protected-fragment-v1',kind:'protected',snapshot:'1:2:',backend:123,transactionAt:'2026-11-14T19:00:00Z'};
  const lines=[ {...common,part:0,payload:{appState:{id:'primary'},floor:{}}},
    ...PROTECTED_GROUPS.map((group,i)=>({...common,part:i+1,payload:{protectedRows:{
      ...Object.fromEntries(group.map(t=>[t,[]])),_unowned:Object.fromEntries(group.map(t=>[t,{count:0,md5:'0'.repeat(32)}]))}}}))
  ].map(x=>JSON.stringify(x));
  const text=lines[0],half=Math.ceil(text.length/2);
  return [text.slice(0,half),text.slice(half)].map((p,i)=>JSON.stringify({schema:'u1-state-piece-v1',kind:'protected',part:0,piece:i,fromChar:i?half+1:1,chars:p.length,totalChars:text.length,totalBytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex'),snapshot:common.snapshot,backend:common.backend,transactionAt:common.transactionAt})+'\t'+p).concat(lines.slice(1)).join('\n')+'\n';
};
test('actual reader reports bounded failure categories without raw diagnostics or changed SQL limits',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'u1-read-diagnostic-'));
  const executable=path.join(dir,'fake-tool'),cert=path.join(dir,'fake-ca');
  fs.writeFileSync(executable,'never executed');fs.writeFileSync(cert,'local test only');
  const original=cp.spawn,originalTimer=globalThis.setTimeout,originalClear=globalThis.clearTimeout;
  try{
    for(const mode of ['success','sql-timeout','exit','stdin','process','format','output','stderr-output','combined-output','timeout']){
      let calls=0,timeoutCallback,kills=0,sql='';
      globalThis.setTimeout=(fn,ms)=>{assert.equal(ms,15000);timeoutCallback=fn;return 1;};globalThis.clearTimeout=()=>{};
      cp.spawn=(_file,args,options)=>{
        calls++;assert.equal(_file,executable);assert.equal(options.env.PGHOST,'db.tkbdyzxwwbhkpztgjjxh.supabase.co');
        assert.equal(options.env.PGSSLMODE,'verify-full');assert.equal(options.shell,false);
        const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
        child.kill=()=>{kills++;};
        child.stdin.end=text=>{sql=text;queueMicrotask(()=>{
          if(mode==='timeout'){timeoutCallback();child.emit('close',null);return;}
          if(mode==='process'){child.emit('error',Error(secret));child.emit('close',null);return;}
          if(mode==='stdin'){child.stdin.emit('error',Error(secret));child.emit('close',1);return;}
          if(mode==='output'){child.stdout.emit('data',Buffer.alloc(32*1024*1024+1));child.emit('close',null);return;}
          if(mode==='stderr-output'){child.stderr.emit('data',Buffer.alloc(32*1024*1024+1));child.emit('close',null);return;}
          if(mode==='combined-output'){child.stdout.emit('data',Buffer.alloc(32*1024*1024));child.stderr.emit('data',Buffer.from('x'));child.emit('close',null);return;}
          if(mode==='sql-timeout'){
            child.stdout.emit('data',Buffer.from('one\n'));
            for(const b of Buffer.from(READ_PHASE_MARKERS.slice(0,5).map(marker).join('')))child.stderr.emit('data',Buffer.from([b]));
            child.stderr.emit('data',Buffer.from(secret+' canceling statement due to state'));
            child.stderr.emit('data',Buffer.from('ment timeout '+secret));child.emit('close',3);return;
          }
          if(mode==='exit'){child.stderr.emit('data',Buffer.from(secret));child.emit('close',1);return;}
          child.stdout.emit('data',Buffer.from(mode==='format'?secret:envelope()));child.emit('close',0);
        });};return child;
      };syncBuiltinESMExports();
      const read=createProtectedReader({executable,executableSha256:createHash('sha256').update('never executed').digest('hex'),
        scope:{sessionIds:[],customerIds:[],auditIds:[],mutationIds:[],customerNames:[]},password:secret,user:'postgres',sslRootCert:cert});
      if(mode==='success')assert.equal((await read()).appState.id,'primary');
      else{
        const expected={ 'sql-timeout':'U1_READ_SQL_TIMEOUT',exit:'U1_READ_EXIT',stdin:'U1_READ_STDIN',
          process:'U1_READ_PROCESS',format:'U1_READ_FORMAT',output:'U1_READ_OUTPUT_LIMIT','stderr-output':'U1_READ_OUTPUT_LIMIT','combined-output':'U1_READ_OUTPUT_LIMIT',timeout:'U1_READ_TIMEOUT'}[mode];
        for(let ordinal=1;ordinal<=2;ordinal++)await assert.rejects(read(),error=>{
          const d=readFailureDiagnostic(error);assert.ok(d);assert.equal(d.code,expected);assert.equal(d.readOrdinal,ordinal);
          assert.ok(!JSON.stringify(error).includes(secret));assert.ok(!error.message.includes(secret));
          if(mode==='sql-timeout'){assert.equal(d.stdoutLines,1);assert.equal(d.phases.markers.at(-1).stage,'part1_before');assert.equal(d.phases.complete,false);}return true;
        });
      }
      assert.equal(calls,mode==='success'?1:2); // Explicit independent calls only; the reader never retries.
      assert.equal(kills,['output','stderr-output','combined-output','timeout'].includes(mode)?2:0);
      assert.ok(sql.includes("statement_timeout='5s'"));assert.ok(sql.includes("lock_timeout='1s'"));
    }
  }finally{cp.spawn=original;globalThis.setTimeout=originalTimer;globalThis.clearTimeout=originalClear;syncBuiltinESMExports();fs.rmSync(dir,{recursive:true,force:true});}
});
