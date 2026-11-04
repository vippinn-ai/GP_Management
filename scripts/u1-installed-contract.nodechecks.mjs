import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { postgresJsonbText, postgresJsonbMd5, expectedStartEventMetadata, analyticsBusinessDate, expectedAnalyticsDirtyDates } from './u1-installed-contract.mjs';
const command = () => ({ mutation_kind:'startSession', mutation_id:'m1', payload:{ session:{id:'s1',stationId:'st1',customerId:'c1',items:[],comboApplications:[],continuedFromSessionIds:[]}, customer:{id:'c1',name:'QA'}, stockMovements:[],auditLogs:[{id:'a1'}] } });
test('JSONB length-first keys, spaces, nested values and escaping', () => {
  const expected = '{"a": [true, null, "x\\n\\t\\\"\\\\"], "z": 1, "aa": {"b": 2, "aaa": -3}}';
  const input = {aa:{aaa:-3,b:2},z:1,a:[true,null,'x\n\t"\\']};
  assert.equal(postgresJsonbText(input),expected);
  assert.equal(postgresJsonbMd5(input),createHash('md5').update(expected).digest('hex'));
  assert.equal(postgresJsonbText({'10':1,'2':2}),'{"2": 2, "10": 1}');
});
test('unsafe number and unicode shapes fail closed', () => {
  for(const v of [NaN,Infinity,-Infinity,-0,1.2,1e21,9007199254740992,'\0','é','\ud800','😀',undefined,1n,()=>{}]) assert.throws(()=>postgresJsonbText(v));
  assert.equal(postgresJsonbText(Number.MAX_SAFE_INTEGER),'9007199254740991');
});
test('non-JSON containers, accessors, hidden fields and cycles rejected', () => {
  const cyclic={};cyclic.a=cyclic;
  const accessor={};Object.defineProperty(accessor,'a',{enumerable:true,get(){throw new Error('must not read');}});
  const hidden={};Object.defineProperty(hidden,'x',{value:1});
  for(const v of [new Date(),new Map(),Object.create(null),cyclic,accessor,hidden,Array(2),Object.assign([],{x:1}),{[Symbol('a')]:1}])assert.throws(()=>postgresJsonbText(v));
});
test('start metadata is complete and independent from input/result metadata', () => {
  const c=command(); const result=expectedStartEventMetadata(c,'event-pending');
  assert.deepEqual(Object.keys(result).sort(),['audit_log_ids','changed_rows','customer_id','mutation_id','mutation_kind','request_fingerprint','session_item_ids','station_id','stock_movement_ids'].sort());
  assert.deepEqual(result.changed_rows,{sessions:['s1'],customers:['c1'],session_items:[],session_combo_applications:[],stock_movements:[],audit_logs:['a1'],operational_events:['event-pending']});
  assert.equal(result.request_fingerprint,postgresJsonbMd5({mutation_kind:'startSession',session:c.payload.session,customer:c.payload.customer,stock_movements:[],audit_logs:[{id:'a1'}]}));
  const changed=command();changed.payload.session.stationId='other';assert.notEqual(expectedStartEventMetadata(changed,'event-pending').request_fingerprint,result.request_fingerprint);
  assert.equal(expectedStartEventMetadata(c,'event-other').request_fingerprint,result.request_fingerprint);
});
test('nonempty children, missing explicit customer and conflicting IDs rejected',()=>{
  for(const mutate of [c=>c.payload.session.items.push({id:'i'}),c=>c.payload.stockMovements.push({id:'x'}),c=>c.payload.auditLogs.push({id:'a2'}),c=>delete c.payload.customer,c=>c.payload.session.customerId='other',c=>c.mutation_kind='save']){const c=command();mutate(c);assert.throws(()=>expectedStartEventMetadata(c,'event-pending'));}
});
test('business date exact boundary and offset/microsecond equivalence',()=>{
  assert.equal(analyticsBusinessDate('2026-11-04T06:59:59.999999+05:30'),'2026-11-03');
  assert.equal(analyticsBusinessDate('2026-11-04T07:00:00.000000+05:30'),'2026-11-04');
  assert.equal(analyticsBusinessDate('2026-11-04T01:29:59.999999Z'),'2026-11-03');
  assert.equal(analyticsBusinessDate('2026-11-04 01:30:00Z'),'2026-11-04');
  assert.equal(analyticsBusinessDate(null),null);
});
test('invalid calendar/offset/precision and historical timestamps rejected',()=>{
  for(const value of ['2026-02-29T00:00:00Z','2026-13-01T00:00:00Z','2026-01-01T24:00:00Z','2026-01-01T00:00:60Z','2026-01-01T00:00:00+14:01','2026-01-01T00:00:00.1234567Z','1999-01-01T00:00:00Z',undefined])assert.throws(()=>analyticsBusinessDate(value));
  assert.equal(analyticsBusinessDate('2024-02-29T10:00:00Z'),'2024-02-29');
});
const tx='2026-11-04T12:00:00.123456Z';
const args=()=>({before:[],organizationId:'org-primary',operation:'start_session',oldStartedAt:null,newStartedAt:'2026-11-04T10:00:00Z',transactionTimestamp:tx,oldClosedBillId:null,newClosedBillId:null});
test('start inserts one date; same-date updates replace only reason/timestamp',()=>{
  const first=expectedAnalyticsDirtyDates(args());assert.deepEqual(first,[{organization_id:'org-primary',business_date:'2026-11-04',reason:'session_change',updated_at:tx}]);
  const before=[{...first[0],reason:'old',updated_at:'2026-11-04T08:00:00Z'}];
  assert.deepEqual(expectedAnalyticsDirtyDates({...args(),before,operation:'reject_session',oldStartedAt:args().newStartedAt}),first);
  assert.equal(before[0].reason,'old');
});
test('save marks old and new dates, preserving other dates/orgs exactly',()=>{
  const unrelated={organization_id:'other',business_date:'2026-11-03',reason:'keep',updated_at:'2026-11-03T01:00:00.654321Z'};
  const rows=expectedAnalyticsDirtyDates({...args(),before:[unrelated],operation:'save_live_session_details',oldStartedAt:'2026-11-03T10:00:00Z'});
  assert.deepEqual(rows[0],unrelated);assert.deepEqual(rows.slice(1).map(r=>r.business_date),['2026-11-03','2026-11-04']);
  assert.ok(rows.slice(1).every(r=>r.updated_at===tx&&r.reason==='session_change'));
});
test('analytics rejects ambiguity, duplicates, nonnull bill and malformed preimage',()=>{
  const row=expectedAnalyticsDirtyDates(args())[0];
  for(const patch of [{oldClosedBillId:undefined},{newClosedBillId:'bill'},{operation:'delete'},{oldStartedAt:'2026-11-03T10:00:00Z'},{before:[row,row]},{before:[{...row,extra:1}]},{newStartedAt:undefined}])assert.throws(()=>expectedAnalyticsDirtyDates({...args(),...patch}));
});
