import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {prepareLaunch,launchOnce,verifyCloseout,validateDiscoveryReport,LAUNCH_LIMITS,EXECUTION_BLOCKERS} from './u1-guarded-launcher.mjs';
import {U1_IDENTITY,U1_LIMITS} from './u1-playwright-runner.mjs';
test('public execution and closeout reject before inspecting inputs or any I/O',async()=>{
 const saved=[];let calls=0;
 const trap=()=>{calls++;throw new Error('Unexpected I/O');};
 const poison=new Proxy({}, {get:trap,ownKeys:trap,getOwnPropertyDescriptor:trap});
 try{
  for(const [obj,names] of [[fs,['readFileSync','writeFileSync','mkdirSync','existsSync','realpathSync','statSync','lstatSync']],[cp,['spawn','execFile','execFileSync','spawnSync','execSync']]])for(const name of names){saved.push([obj,name,obj[name]]);obj[name]=trap;}
  syncBuiltinESMExports();
  for(const input of [undefined,{},poison,{admission:{schema:'u1-launch-admission-v1'},confirmation:'RUN U1 STAGING ONCE synthetic',credentials:{}}]){
   await assert.rejects(launchOnce(input),/^Error: U1 live launcher admission contract incomplete$/);
   assert.throws(()=>verifyCloseout(input),/^Error: U1 live launcher admission contract incomplete$/);
   assert.equal(prepareLaunch(input).status,'blocked-not-live-admitted');
  }
  assert.equal(calls,0);
 }finally{for(const [obj,name,original]of saved)obj[name]=original;syncBuiltinESMExports();}
});
test('preparation is nonadmitted and preserves fixed limits without approval claims',()=>{
 const p=prepareLaunch();
 assert.equal(p.executionEnabled,false);assert.equal(p.admissionValidated,false);
 assert.deepEqual(p.limits,U1_LIMITS);assert.equal(p.limits.pairs,50);
 assert.equal(p.processLimits.processMs,1200000);assert.equal(LAUNCH_LIMITS.outputBytes,32*1024*1024);
 assert.deepEqual(p.runArgs,['test','--config=playwright.u1.config.ts','--project=u1-baseline','--workers=1','--retries=0','--repeat-each=1','--max-failures=1','--reporter=json']);
 assert.deepEqual(p.discoveryArgs,[...p.runArgs,'--list']);
 assert.equal(p.blockers,EXECUTION_BLOCKERS);assert.equal(p.blockers.length,7);
 for(const value of [p,p.runArgs,p.discoveryArgs,p.blockers,p.processLimits])assert.equal(Object.isFrozen(value),true);
 assert.equal('receipts'in p,false);assert.equal('packageSha256'in p,false);
});
const listing=()=>({suites:[{specs:[{file:U1_IDENTITY.file,title:U1_IDENTITY.title,tests:[{projectName:U1_IDENTITY.project}]}]}],errors:[]});
test('pure discovery parser requires exact single file/title/project',()=>{
 const r=listing();assert.equal(validateDiscoveryReport(r).tests,1);
 for(const alter of [x=>x.suites[0].specs.push(structuredClone(x.suites[0].specs[0])),x=>x.suites[0].specs[0].tests.push({projectName:U1_IDENTITY.project}),x=>x.suites[0].specs[0].title='other',x=>x.suites[0].specs[0].tests[0].projectName='other',x=>x.errors.push({message:'failure'}),x=>x.suites=[]]){const bad=listing();alter(bad);assert.throws(()=>validateDiscoveryReport(bad));}
});

