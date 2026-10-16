import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SIGN_IN_STAGES,SYNCED_LABEL,authStatusFromResponse,runSignInStages,closeBounded,withBoundedContext,closeBrowserResources} from './role-account-browser-safety.mjs';
import {roleOperationFailure,createRoleReceiptStore} from './role-account-provisioning-safety.mjs';
test('each sign-in substage preserves primary failure without raw error text',async()=>{
  for(const target of SIGN_IN_STAGES){
    const secret=new Error('private-password-and-token');const diagnostic={};const visited=[];
    const actions=Object.fromEntries(SIGN_IN_STAGES.map(stage=>[stage,async()=>{visited.push(stage);if(stage===target)throw secret;}]));
    await assert.rejects(runSignInStages(actions,diagnostic),error=>error===secret);
    assert.equal(diagnostic.substage,target);assert.equal(diagnostic.outcome,'failed');
    assert.equal(visited.at(-1),target);assert.ok(!JSON.stringify(diagnostic).includes(secret.message));
  }
});
test('success visits all stages and timeout gets a fixed code',async()=>{
  const d={};await runSignInStages(Object.fromEntries(SIGN_IN_STAGES.map(s=>[s,async()=>{}])),d);assert.equal(d.outcome,'passed');
  const error=new Error('secret');error.name='TimeoutError';const failed={};await assert.rejects(runSignInStages({navigation:async()=>{throw error;}},failed));assert.equal(failed.errorCode,'timeout');
});
test('auth diagnostic only accepts integer status from exact staging password POST',()=>{
  const ref='test-staging';const response=(url,method='POST',status=200)=>({url:()=>url,request:()=>({method:()=>method}),status:()=>status,json:()=>{throw Error('Must never read body');}});
  const good='https://test-staging.supabase.co/auth/v1/token?grant_type=password';
  assert.equal(authStatusFromResponse(response(good),ref),200);
  for(const r of [response(good.replace('test-staging','production')),response(good,'GET'),response(good.replace('password','refresh_token')),response(good,'POST','secret')])assert.equal(authStatusFromResponse(r,ref),null);
});
test('cleanup handles missing/success/rejection/synchronous throw/hang',async()=>{
  assert.equal((await closeBounded(null,10)).code,'not_created');
  assert.equal((await closeBounded({close:async()=>{}},10)).status,'fulfilled');
  for(const close of [()=>{throw Error('secret');},async()=>{throw Error('secret');},()=>new Promise(()=>{})]){
    const result=await closeBounded({close},10);assert.deepEqual(result,{status:'rejected',code:'close_failed_or_timed_out'});
  }
});
test('hanging or rejected context cannot prevent subsequent independent browser close',async()=>{
  for(const fail of [()=>new Promise(()=>{}),async()=>{throw Error('private');}]){
    const attempted=[];
    const result=await closeBrowserResources({close:()=>{attempted.push('context');return fail();}},{close:async()=>{attempted.push('browser');}},10);
    assert.deepEqual(attempted,['context','browser']);assert.deepEqual(result.map(x=>x.status),['rejected','fulfilled']);
  }
});
test('actual sync label accepts whitespace suffix but not prefix contamination',()=>{
  assert.ok(SYNCED_LABEL.test('Synced'));assert.ok(SYNCED_LABEL.test('Synced now'));assert.ok(SYNCED_LABEL.test('Synced\nnow'));
  assert.equal(SYNCED_LABEL.test('SyncedExtra'),false);assert.equal(SYNCED_LABEL.test('Not Synced'),false);
});
test('verification primary survives failed cleanup; cleanup-only failure cannot pass',async()=>{
  const primary=new Error('private primary');const records=[];
  await assert.rejects(withBoundedContext({close:()=>new Promise(()=>{})},async()=>{throw primary;},r=>records.push(r),10),e=>e===primary);
  assert.equal(records[0].status,'rejected');
  await assert.rejects(withBoundedContext({close:async()=>{throw Error('secret');}},async()=>42,r=>records.push(r),10),/cleanup failed closed/);
  assert.equal(await withBoundedContext({close:async()=>{}},async()=>42,()=>{},10),42);
});
test('operation failure takes precedence and cleanup receipt failure rejects completed operation',()=>{
  const failed=roleOperationFailure({operationFailed:true,terminalReceiptUnavailable:false,failureStage:'admin-sign-in',cleanupStatuses:['rejected']});assert.match(failed.message,/admin-sign-in/);assert.match(failed.message,/cleanup also/);
  assert.ok(roleOperationFailure({operationFailed:false,terminalReceiptUnavailable:true,cleanupStatuses:['fulfilled']}));
});
test('new sanitized cleanup receipt is accepted without changing terminal paths and refuses reuse',()=>{
  const written=new Map();
  const io={mkdirSync(){},writeFileSync(file,text,options){assert.equal(options.flag,'wx');if(written.has(file))throw Error('exists');written.set(file,text);}};
  const store=createRoleReceiptStore({root:process.cwd(),runId:'normops-20261016-1200-offline-browser',command:'create',io});
  store.write('failure',{failureStage:'admin-sign-in',signInDiagnostics:[{actorSlot:'admin',substage:'authenticated-request-capture',authStatus:200,outcome:'failed',errorCode:'timeout'}]});
  store.write('browser-cleanup',{resources:[{resource:'browser',status:'rejected',code:'close_failed_or_timed_out'}]});
  assert.ok([...written.keys()].some(k=>k.endsWith('create-terminal.json')));
  assert.ok([...written.keys()].some(k=>k.endsWith('create-browser-cleanup.json')));
  assert.throws(()=>store.write('browser-cleanup',{}));
});
