import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {runDarwinOwnedProcess} from './u1-darwin-process.mjs';
import {LAUNCH_LIMITS} from './u1-guarded-launcher.mjs';

const enabled=process.platform==='darwin';
const run=(code,captureJson=false)=>runDarwinOwnedProcess({file:process.execPath,args:['-e',code],cwd:process.cwd(),env:{},mode:'discovery',captureJson});
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'u1-darwin-containment-'));
const descendant=marker=>`const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(marker)},String(c.pid));c.unref();`;

test('Darwin success is explicit root close and empty owned group',{skip:!enabled},async()=>{
 const r=await run('process.exit(0)');
 assert.equal(r.status,'process-completed');assert.equal(r.cleanupConfirmed,true);assert.equal(r.groupGone,true);assert.equal(r.killInvoked,false);
 assert.deepEqual(LAUNCH_LIMITS,{discoveryMs:60000,processMs:1200000,killMs:5000,exitMs:3000,outputBytes:33554432});
});
test('Darwin root exit with living descendant cannot pass; sibling survives',{skip:!enabled},async()=>{
 const dir=temp(),marker=path.join(dir,'child.pid');
 const sibling=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',env:{}});
 try{
  const r=await run(descendant(marker)+'process.exit(0);');
  assert.equal(r.status,'inconclusive');assert.equal(r.failure,'descendant-after-root-close');
  assert.equal(r.killInvoked,true);assert.equal(r.cleanupConfirmed,true);assert.equal(r.manualCleanupRequired,false);
  assert.equal(alive(Number(fs.readFileSync(marker,'utf8'))),false);assert.equal(alive(sibling.pid),true);
 }finally{sibling.kill('SIGKILL');await new Promise(resolve=>sibling.once('close',resolve));fs.rmSync(dir,{recursive:true,force:true});}
});
test('Darwin combined output limit kills root and descendant without touching sibling',{skip:!enabled},async()=>{
 const dir=temp(),marker=path.join(dir,'child.pid');
 const sibling=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',env:{}});
 try{
  const r=await run(descendant(marker)+`const b=Buffer.alloc(1024*1024);for(let i=0;i<18;i++){process.stdout.write(b);process.stderr.write(b);}setInterval(()=>{},1000);`);
  assert.equal(r.status,'inconclusive');assert.equal(r.failure,'output-limit');assert.equal(r.killInvoked,true);assert.equal(r.cleanupConfirmed,true);
  assert.ok(r.result.stdoutBytes+r.result.stderrBytes>LAUNCH_LIMITS.outputBytes);
  assert.equal(alive(Number(fs.readFileSync(marker,'utf8'))),false);assert.equal(alive(sibling.pid),true);
 }finally{sibling.kill('SIGKILL');await new Promise(resolve=>sibling.once('close',resolve));fs.rmSync(dir,{recursive:true,force:true});}
});
test('Darwin spawn failure stays inconclusive and never signals a foreign PID',{skip:!enabled},async()=>{
 const r=await runDarwinOwnedProcess({file:'/u1-nonexistent-native-executable',args:[],cwd:process.cwd(),env:{},mode:'discovery',captureJson:false});
 assert.equal(r.status,'inconclusive');assert.equal(r.failure,'spawn-error');assert.equal(r.killInvoked,false);assert.equal(r.childPid,null);
});
test('Darwin nonzero exit is not promoted to success',{skip:!enabled},async()=>{
 const r=await run('process.exit(2)');assert.equal(r.status,'inconclusive');assert.equal(r.failure,'child-failed');assert.equal(r.cleanupConfirmed,true);
});
test('Darwin rejects caller limit overrides and unknown modes before spawning',{skip:!enabled},async()=>{
 const options={file:process.execPath,args:[],cwd:process.cwd(),env:{},mode:'discovery',captureJson:false};
 await assert.rejects(runDarwinOwnedProcess({...options,timeout:1}),/Exact containment options/);
 await assert.rejects(runDarwinOwnedProcess({...options,mode:'retry'}),/Explicit command/);
});
test('Darwin discovery JSON is bounded, strict and never parsed after failure',{skip:!enabled},async()=>{
 const good=await run('process.stdout.write(JSON.stringify({discovered:1}))',true);
 assert.deepEqual(good.json,{discovered:1});assert.equal(good.parseFailed,false);
 const bad=await run('process.stdout.write(Buffer.from([255]))',true);
 assert.equal(bad.json,null);assert.equal(bad.parseFailed,true);
 const failed=await run('process.stdout.write("{}");process.exit(1)',true);
 assert.equal(failed.json,null);assert.equal(failed.status,'inconclusive');
});
test('Darwin actual fixed 60-second discovery timeout kills owned process',{skip:!enabled,timeout:75000},async()=>{
 const r=await run('setInterval(()=>{},1000)');
 assert.equal(r.status,'inconclusive');assert.equal(r.failure,'deadline-exceeded');assert.equal(r.killInvoked,true);assert.equal(r.cleanupConfirmed,true);
 assert.ok(r.result.elapsedMs>=LAUNCH_LIMITS.discoveryMs);assert.ok(r.result.elapsedMs<LAUNCH_LIMITS.discoveryMs+LAUNCH_LIMITS.killMs+LAUNCH_LIMITS.exitMs);
});
