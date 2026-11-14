import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { createProtectedReader, readFailureDiagnostic, PROTECTED_GROUPS } from './u1-protected-reader.mjs';

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

const envelope = () => {
  const common={schema:'u1-protected-fragment-v1',kind:'protected',snapshot:'1:2:',backend:123,transactionAt:'2026-11-14T19:00:00Z'};
  return [ {...common,part:0,payload:{appState:{id:'primary'},floor:{}}},
    ...PROTECTED_GROUPS.map((group,i)=>({...common,part:i+1,payload:{protectedRows:{
      ...Object.fromEntries(group.map(t=>[t,[]])),_unowned:Object.fromEntries(group.map(t=>[t,{count:0,md5:'0'.repeat(32)}]))}}}))
  ].map(x=>JSON.stringify(x)).join('\n')+'\n';
};
test('actual reader reports bounded failure categories without raw diagnostics or changed SQL limits',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'u1-read-diagnostic-'));
  const executable=path.join(dir,'fake-tool'),cert=path.join(dir,'fake-ca');
  fs.writeFileSync(executable,'never executed');fs.writeFileSync(cert,'local test only');
  const original=cp.spawn,originalTimer=globalThis.setTimeout,originalClear=globalThis.clearTimeout;
  try{
    for(const mode of ['success','sql-timeout','exit','stdin','process','format','output','timeout']){
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
          if(mode==='sql-timeout'){
            child.stdout.emit('data',Buffer.from('one\n'));
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
          process:'U1_READ_PROCESS',format:'U1_READ_FORMAT',output:'U1_READ_OUTPUT_LIMIT',timeout:'U1_READ_TIMEOUT'}[mode];
        for(let ordinal=1;ordinal<=2;ordinal++)await assert.rejects(read(),error=>{
          const d=readFailureDiagnostic(error);assert.ok(d);assert.equal(d.code,expected);assert.equal(d.readOrdinal,ordinal);
          assert.ok(!JSON.stringify(error).includes(secret));assert.ok(!error.message.includes(secret));
          if(mode==='sql-timeout')assert.equal(d.stdoutLines,1);return true;
        });
      }
      assert.equal(calls,mode==='success'?1:2); // Explicit independent calls only; the reader never retries.
      assert.equal(kills,['output','timeout'].includes(mode)?2:0);
      assert.ok(sql.includes("statement_timeout='5s'"));assert.ok(sql.includes("lock_timeout='1s'"));
    }
  }finally{cp.spawn=original;globalThis.setTimeout=originalTimer;globalThis.clearTimeout=originalClear;syncBuiltinESMExports();fs.rmSync(dir,{recursive:true,force:true});}
});
