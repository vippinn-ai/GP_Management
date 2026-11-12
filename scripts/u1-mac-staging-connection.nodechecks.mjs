import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {parseDbpw,inspectConnectionInputs,run,CONNECTION_SQL,CONNECTION_LIMITS} from './u1-mac-staging-connection.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');

test('staging parser rejects production and legacy fallback and never echoes input',()=>{
 assert.equal(parseDbpw('Username: dummy\nDBPWSTAGING: dummy-only-password\n'),'dummy-only-password');
 assert.equal(parseDbpw('DBPWSTAGING=second-dummy'),'second-dummy');
 assert.equal(parseDbpw('DBPWPROD - production-dummy\nDBPWSTAGING - hyphen-dummy'),'hyphen-dummy');
 assert.equal(parseDbpw('DBPW - legacy-dummy\nDBPWSTAGING - staging-dummy'),'staging-dummy');
 for(const text of ['','DBPWPROD - secret','DBPW - secret','DBPWSTAGING:','DBPWSTAGING - ','DBPWSTAGING: one\nDBPWSTAGING: two','DBPWSTAGING - one\nDBPWSTAGING=two','DBPWSTAGING - dummy\u0000bad','DBPWSTAGING – unsupported-dash','DBPWSTAGING missing separator','{\\rtf1 DBPWSTAGING: secret}']){
  assert.throws(()=>parseDbpw(text),error=>!error.message.includes('secret'));
 }
});

test('fixed read-only SQL and limits remain staging-only',()=>{
 assert.match(CONNECTION_SQL,/BEGIN READ ONLY/);assert.match(CONNECTION_SQL,/ROLLBACK;/);
 assert.match(CONNECTION_SQL,/7623125441096521075/);assert.match(CONNECTION_SQL,/f9bc0aed-b6c4-410f-ba2a-572522d03869/);
 assert.match(CONNECTION_SQL,/statement_timeout='5s'/);assert.match(CONNECTION_SQL,/lock_timeout='1s'/);
 assert.doesNotMatch(CONNECTION_SQL,/rrdwbxvuwrbxefarxnse|\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER)\b/i);
 assert.deepEqual(CONNECTION_LIMITS,{processMs:15000,exitMs:3000,outputBytes:33554432});
});

test('native pinned admission and mocked one-shot lifecycle', {skip:process.platform!=='darwin'},async()=>{
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'u1-mac-connection-')));
 const original=cp.spawn,originalTimer=globalThis.setTimeout;
 try{
  const executable=path.join(dir,'psql'),sslRootCert=path.join(dir,'ca.pem');
  fs.writeFileSync(executable,Buffer.from('cffaedfe00000000','hex'),{mode:0o700});
  // Offline temporary self-signed CA fixture only; never used for a connection.
  cp.execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(dir,'key.pem'),'-out',sslRootCert,'-days','1','-subj','/CN=Offline U1 Test CA','-addext','basicConstraints=critical,CA:TRUE'],{stdio:'ignore'});
  const inputs={executable,sha256:hash(fs.readFileSync(executable)),sslRootCert,certSha256:hash(fs.readFileSync(sslRootCert))};
  assert.equal(inspectConnectionInputs(inputs).platform,'darwin');
  assert.throws(()=>inspectConnectionInputs({...inputs,sha256:'0'.repeat(64)}),/bytes changed/);
  assert.throws(()=>inspectConnectionInputs({...inputs,certSha256:'0'.repeat(64)}),/bytes changed/);
  assert.throws(()=>inspectConnectionInputs({...inputs,executable:path.join(dir,'absent')}));
  assert.throws(()=>inspectConnectionInputs({...inputs,host:'arbitrary'}),/Unexpected/);
  let calls=0,mode='success',sql,killSignals=[];
  cp.spawn=(file,args,options)=>{
   calls++;assert.equal(file,executable);assert.deepEqual(args,['-X','-q','-A','-t','-w','-v','ON_ERROR_STOP=1']);
   assert.equal(options.env.PGHOST,'db.tkbdyzxwwbhkpztgjjxh.supabase.co');assert.equal(options.env.PGUSER,'postgres');
   assert.equal(options.env.PGSSLMODE,'verify-full');assert.equal(options.env.NODE_OPTIONS,undefined);
   assert.equal(options.env.PGPASSWORD,'dummy-local-only');assert.ok(!args.includes('dummy-local-only'));assert.equal(options.shell,false);
   const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.unref=()=>{};
   child.stdin=new Writable({write(chunk,encoding,callback){sql=chunk.toString();callback();}});
   child.kill=signal=>{killSignals.push(signal);queueMicrotask(()=>child.emit('close',null));return true;};
   queueMicrotask(()=>{
    if(mode==='timeout')return;
    if(mode==='stderr-overflow'){child.stderr.emit('data',Buffer.alloc(CONNECTION_LIMITS.outputBytes+1));return;}
    if(mode==='spawn-error'){child.emit('error',new Error('dummy-secret-not-for-evidence'));return;}
    child.stdout.write(mode==='success'?'u1-staging-identity-verified\n':'unexpected private diagnostics');
    child.emit('close',mode==='nonzero'?1:0);
   });return child;
  };syncBuiltinESMExports();
  for(mode of ['success','mismatch','nonzero','stderr-overflow','spawn-error','timeout']){
   if(mode==='timeout')globalThis.setTimeout=(fn,ms,...args)=>originalTimer(fn,ms===15000?1:ms,...args);
   const result=await run({...inputs,password:'dummy-local-only'});
   assert.equal(result.status,mode==='success'?'verified':'inconclusive');assert.equal(result.exitObserved,true);
   assert.equal(result.manualCleanupRequired,false);assert.equal(sql,CONNECTION_SQL);
   assert.doesNotMatch(JSON.stringify(result),/dummy-local-only|private diagnostics|dummy-secret/);
   globalThis.setTimeout=originalTimer;
  }
  assert.equal(calls,6);assert.deepEqual(killSignals,['SIGKILL','SIGKILL','SIGKILL']);
  const before=calls;
  await assert.rejects(run({...inputs,password:'dummy-local-only',sha256:'0'.repeat(64)}));assert.equal(calls,before);
  await assert.rejects(run({...inputs,password:'dummy-local-only',host:'other'}));assert.equal(calls,before);
 }finally{cp.spawn=original;syncBuiltinESMExports();globalThis.setTimeout=originalTimer;fs.rmSync(dir,{recursive:true,force:true});}
});
