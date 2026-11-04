import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareInstalledPhase, compareInstalledPhase } from './u1-phase-expectations.mjs';
import { expectedStartEventMetadata } from './u1-installed-contract.mjs';
const time='2026-11-04T12:00:00.123456Z';
const old={organization_id:'org-primary',business_date:'2026-11-01',reason:'preserve',updated_at:'2026-11-01T10:00:00Z'};
const session={id:'s',organization_id:'org-primary',status:'active',closed_bill_id:null,started_at:'2026-11-03T08:00:00Z'};
const command={organization_id:'org-primary',user_id:'actor',mutation_id:'mutation',mutation_kind:'startSession',payload:{
  session:{id:'s',stationId:'station',startedAt:'2026-11-04T08:00:00Z',items:[],comboApplications:[],continuedFromSessionIds:[],closedBillId:null},
  customer:{id:'c',name:'fixture'},stockMovements:[],auditLogs:[{id:'audit',userId:'actor'}]}};
const dirty=date=>({organization_id:'org-primary',business_date:date,reason:'session_change',updated_at:time});
test('start metadata is sealed from frozen input before observed result exists',()=>{
  const c=structuredClone(command);
  const intent=prepareInstalledPhase({sessions:[],analytics_dirty_dates:[old]},'start_session',c);
  assert.deepEqual(intent.startMetadata,expectedStartEventMetadata(c,'event-pending'));
  const hash=intent.startMetadata.request_fingerprint;c.payload.session.stationId='changed';
  assert.equal(intent.startMetadata.request_fingerprint,hash);
  assert.notEqual(hash,expectedStartEventMetadata(c,'event-pending').request_fingerprint);
});
test('shared analytics delta preserves preexisting dates and rejects missing extra duplicate or altered rows',()=>{
  const intent=prepareInstalledPhase({sessions:[],analytics_dirty_dates:[old]},'start_session',command);
  const template={analytics_dirty_dates:[old,{...dirty('2026-11-04'),updated_at:{$generated:'serverTime',phase:'p'}}]};
  const actual={analytics_dirty_dates:[dirty('2026-11-04'),old]};
  const bindings=()=>({p:{serverTime:time}});
  assert.doesNotThrow(()=>compareInstalledPhase(template,actual,bindings(),'p',intent));
  for(const change of [
    x=>x.analytics_dirty_dates.pop(),x=>x.analytics_dirty_dates.push(dirty('2026-11-05')),
    x=>x.analytics_dirty_dates.push(dirty('2026-11-04')),x=>x.analytics_dirty_dates[0].reason='bad',
    x=>x.analytics_dirty_dates[0].updated_at='2026-11-04T12:00:00.123455Z',
    x=>x.analytics_dirty_dates[1].reason='tampered'
  ]){const x=structuredClone(actual);change(x);assert.throws(()=>compareInstalledPhase(template,x,bindings(),'p',intent));}
  const borrowed=structuredClone(template);borrowed.analytics_dirty_dates[0].updated_at={$generated:'serverTime',phase:'p'};
  assert.throws(()=>compareInstalledPhase(borrowed,actual,bindings(),'p',intent),/Unwritten analytics/);
});
test('save old/new dates and rejection start-only dates derive from expected preimage, not endedAt',()=>{
  const before={sessions:[session],analytics_dirty_dates:[old]};
  const save={organization_id:'org-primary',payload:{sessionId:'s',startedAt:'2026-11-04T08:00:00Z'}};
  const intent=prepareInstalledPhase(before,'save_live_session_details',save);
  const rows=[old,dirty('2026-11-03'),dirty('2026-11-04')];
  assert.doesNotThrow(()=>compareInstalledPhase({analytics_dirty_dates:rows},{analytics_dirty_dates:rows},{p:{serverTime:time}},'p',intent));
  const reject={organization_id:'org-primary',payload:{session:{id:'s',closedBillId:null,endedAt:'2026-11-05T10:00:00Z'}}};
  const cleanup=prepareInstalledPhase(before,'reject_session',reject);
  const cleanupRows=[old,dirty('2026-11-03')];
  assert.doesNotThrow(()=>compareInstalledPhase({analytics_dirty_dates:cleanupRows},{analytics_dirty_dates:cleanupRows},{p:{serverTime:time}},'p',cleanup));
  assert.throws(()=>prepareInstalledPhase({...before,sessions:[{...session,closed_bill_id:'bill'}]},'reject_session',reject));
});
