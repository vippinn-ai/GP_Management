import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import cp from 'node:child_process';
import {EventEmitter} from 'node:events';
import {pathToFileURL} from 'node:url';
import {runDarwinBrowserProcess} from './u1-darwin-browser-process.mjs';
import {LAUNCH_LIMITS} from './u1-guarded-launcher.mjs';
const root=path.resolve(import.meta.dirname,'..');
const options=mode=>({node:process.execPath,playwright:path.join(import.meta.dirname,'u1-darwin-browser-process.fixture.mjs'),chrome:fs.realpathSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),root,args:[mode],env:{}});
const gone=pid=>{try{process.kill(-pid,0);return false;}catch(e){return e.code==='ESRCH';}};
test('real local Chrome normal completion closes exact owned browser and runner',{skip:process.platform!=='darwin'},async()=>{
 const r=await runDarwinBrowserProcess(options('normal'));
 assert.equal(r.result.status,'process-completed');assert.equal(r.manualCleanupRequired,false);assert.equal(r.groupCleanupConfirmed,true);
 assert.equal(gone(r.browserPid),true);assert.equal(gone(r.childPid),true);
});
test('real Chrome failure and overflow kill both owned groups; unrelated Chrome survives',{skip:process.platform!=='darwin'},async()=>{
 const {chromium}=await import(pathToFileURL(path.join(root,'node_modules/playwright/index.mjs')).href);
 const sibling=await chromium.launchServer({channel:'chrome',headless:true,host:'127.0.0.1'});
 try{
  for(const mode of ['failure','output']){
   const r=await runDarwinBrowserProcess(options(mode));
   assert.equal(r.result.status,'inconclusive');assert.equal(r.manualCleanupRequired,false);assert.equal(r.groupCleanupConfirmed,true);
   assert.equal(gone(r.browserPid),true);assert.equal(gone(r.childPid),true);assert.equal(gone(sibling.process().pid),false);
   if(mode==='output')assert.equal(r.result.failure,'output-limit');
  }
 }finally{await sibling.close();}
});
test('real Chrome timeout cleanup uses mocked scheduler, not a changed deadline',{skip:process.platform!=='darwin'},async()=>{
 const original=globalThis.setTimeout;
 try{
  globalThis.setTimeout=(fn,ms,...args)=>original(fn,ms>LAUNCH_LIMITS.processMs-1000?1500:ms,...args);
  const r=await runDarwinBrowserProcess(options('hold'));
  assert.equal(r.result.status,'inconclusive');assert.equal(r.result.failure,'deadline-exceeded');assert.equal(r.manualCleanupRequired,false);
  assert.equal(gone(r.browserPid),true);if(r.childPid)assert.equal(gone(r.childPid),true);
 }finally{globalThis.setTimeout=original;}
});
test('delayed startup cannot escape ownership; repeated startup errors stay bounded',{skip:process.platform!=='darwin'},async()=>{
 const {chromium}=await import(pathToFileURL(path.join(root,'node_modules/playwright/index.mjs')).href);
 const original={spawn:cp.spawn,kill:process.kill,launchServer:chromium.launchServer,timer:globalThis.setTimeout};
 try{
  for(const mode of ['before-spawn','after-capture','repeated-error']){
   let spawnCalls=0,closed=false;
   const child=new EventEmitter();child.pid=55555;child.stdout=new EventEmitter();child.stderr=new EventEmitter();
   cp.spawn=()=>{spawnCalls++;return child;};
   process.kill=(pid,signal)=>{assert.equal(pid,-55555);if(closed){const e=new Error('absent');e.code='ESRCH';throw e;}if(signal==='SIGKILL'){closed=true;child.emit('close',null);}else assert.equal(signal,0);return true;};
   globalThis.setTimeout=(fn,ms,...args)=>original.timer(fn,ms>LAUNCH_LIMITS.processMs-1000?20:ms,...args);
   chromium.launchServer=async()=>{
    if(mode==='before-spawn')await new Promise(r=>original.timer(r,100));
    const captured=cp.spawn(options('hold').chrome,[],{detached:true,shell:false});
    if(mode==='repeated-error')queueMicrotask(()=>{child.emit('error',new Error('synthetic'));child.emit('error',new Error('synthetic'));});
    await new Promise(r=>original.timer(r,100));
    assert.equal(closed,true,'Owned browser is killed before delayed startup resolves');
    return{process:()=>captured,wsEndpoint:()=> 'ws://127.0.0.1:12345/offline',close:async()=>{}};
   };
   const r=await runDarwinBrowserProcess(options('hold'));
   assert.equal(r.result.status,'inconclusive');assert.equal(r.manualCleanupRequired,false);assert.equal(r.spawnInterceptionReleased,true);assert.equal(r.childPid,null);
   assert.equal(spawnCalls,mode==='before-spawn'?0:1);
   if(mode!=='before-spawn')assert.equal(closed,true);
  }
 }finally{cp.spawn=original.spawn;process.kill=original.kill;chromium.launchServer=original.launchServer;globalThis.setTimeout=original.timer;}
});
test('unsettled launch remains fail-closed after bounded return and blocks its late spawn',{skip:process.platform!=='darwin'},async()=>{
 const {chromium}=await import(pathToFileURL(path.join(root,'node_modules/playwright/index.mjs')).href);
 const original={spawn:cp.spawn,launchServer:chromium.launchServer,timer:globalThis.setTimeout};
 let release,spawnCalls=0;
 try{
  cp.spawn=()=>{spawnCalls++;throw new Error('Must not execute late process');};
  const heldSpawn=cp.spawn;
  globalThis.setTimeout=(fn,ms,...args)=>original.timer(fn,ms>LAUNCH_LIMITS.processMs-1000?20:ms,...args);
  chromium.launchServer=async()=>{await new Promise(r=>{release=r;});return cp.spawn(options('hold').chrome,[],{detached:true,shell:false});};
  const r=await runDarwinBrowserProcess(options('hold'));
  assert.equal(r.result.status,'inconclusive');assert.equal(r.manualCleanupRequired,true);assert.equal(r.spawnInterceptionReleased,false);assert.equal(spawnCalls,0);
  assert.notEqual(cp.spawn,heldSpawn,'Stopped interceptor must remain installed');
  release();await new Promise(r=>original.timer(r,30));
  assert.equal(spawnCalls,0);assert.equal(cp.spawn,heldSpawn,'Restore only after pending launch has settled');
 }finally{release?.();cp.spawn=original.spawn;chromium.launchServer=original.launchServer;globalThis.setTimeout=original.timer;}
});
