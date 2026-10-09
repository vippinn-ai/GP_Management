import {test} from 'node:test';
import assert from 'node:assert/strict';
import {INVENTORY_CONTRACT_TESTS,parseLifecycleArguments,lifecycleSuiteContract,lifecycleSelectionArguments,assertLifecycleSuiteDiscovery,assertCompleteLifecycleSummary,lifecycleRuntimeIdentity} from './lifecycle-runner-guards.mjs';

test('only fixed supplemental invocation is accepted',()=>{
  assert.equal(parseLifecycleArguments([]).mode,'full');
  assert.equal(parseLifecycleArguments(['--inventory-contract']).discoveryOnly,false);
  assert.equal(parseLifecycleArguments(['--inventory-contract','--list']).discoveryOnly,true);
  for(const args of [['--list','--inventory-contract'],['--inventory-contract','--grep=x'],['--inventory-contract','--config=x'],['--inventory-contract','--retries=1'],['--inventory-contract','--inventory-contract'],['--inventory-contract','--list','--list']]) assert.throws(()=>parseLifecycleArguments(args));
});

test('focused discovery requires exactly two full file/project/title identities',()=>{
  assert.equal(assertLifecycleSuiteDiscovery(INVENTORY_CONTRACT_TESTS,'inventory-contract').fullReleaseGate,false);
  for(const entries of [[],INVENTORY_CONTRACT_TESTS.slice(0,1),[...INVENTORY_CONTRACT_TESTS,INVENTORY_CONTRACT_TESTS[0]],[INVENTORY_CONTRACT_TESTS[0],INVENTORY_CONTRACT_TESTS[0]],INVENTORY_CONTRACT_TESTS.map(x=>({...x,title:x.title+' extra'})),INVENTORY_CONTRACT_TESTS.map(x=>({...x,project:'other'})),INVENTORY_CONTRACT_TESTS.map(x=>({...x,file:'wrong.ts'}))]) assert.throws(()=>assertLifecycleSuiteDiscovery(entries,'inventory-contract'));
  assert.throws(()=>assertLifecycleSuiteDiscovery(INVENTORY_CONTRACT_TESTS,'full'));
  assert.throws(()=>lifecycleSuiteContract('subset'));
});

test('fixed selector is anchored to approved full titles, not arbitrary substrings',()=>{
  const [flag,pattern]=lifecycleSelectionArguments('inventory-contract');
  assert.equal(flag,'--grep');
  const regex=new RegExp(pattern);
  for(const entry of INVENTORY_CONTRACT_TESTS){
    const title=entry.title.replaceAll(' > ',' ');
    assert.ok(regex.test(title));
    assert.ok(!regex.test(title+' extra'));
    assert.ok(!regex.test('other '+title));
  }
  assert.deepEqual(lifecycleSelectionArguments('full'),[]);
});

test('focused result cannot pass missing, duplicate, skipped, retried or wrong-title cases',()=>{
  const tests=INVENTORY_CONTRACT_TESTS.map(x=>({...x,status:'passed',retry:0}));
  const summary={runId:'run',status:'passed',tests};
  assertCompleteLifecycleSummary(summary,INVENTORY_CONTRACT_TESTS,'run');
  for(const changed of [tests.slice(0,1),[...tests,tests[0]],[tests[0],tests[0]],tests.map(x=>({...x,status:'skipped'})),tests.map(x=>({...x,retry:1})),tests.map(x=>({...x,title:'wrong'}))]) assert.throws(()=>assertCompleteLifecycleSummary({...summary,tests:changed},INVENTORY_CONTRACT_TESTS,'run'));
});

test('mode is part of runtime identity and fixed suite cannot claim full release',()=>{
  assert.notEqual(lifecycleRuntimeIdentity({E2E_LIFECYCLE_MODE:'full'}).sha256,lifecycleRuntimeIdentity({E2E_LIFECYCLE_MODE:'inventory-contract'}).sha256);
  assert.deepEqual(lifecycleSuiteContract('inventory-contract'),{suite:'operational-lifecycle-inventory-contract',mode:'inventory-contract',expectedTestCount:2,fullReleaseGate:false});
  assert.deepEqual(lifecycleSuiteContract('full'),{suite:'operational-lifecycle',mode:'full',expectedTestCount:31,fullReleaseGate:true});
});
