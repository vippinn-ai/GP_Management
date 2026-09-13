import { describe, expect, it } from "vitest";
import {
  AUXILIARY_IDENTITY_TABLES,
  APP_STATE_COLLECTIONS,
  SCALE_TABLES,
  assertSafeGeneratedSql,
  buildFixturePackage,
  computeAppStateScalePlan,
  computeScalePlan,
  estimateRepresentativeAppStateUpperBoundBytes,
  extractAppStateCollectionCountsFromCopy,
  extractProductionShapeCountsFromCopy,
  parseJsonBytes,
  validatePreflight
} from "./operational-performance-scale-fixture-lib.mjs";

const counts=(value=0)=>Object.fromEntries(SCALE_TABLES.map((table)=>[table,value]));
const fingerprints=()=>Object.fromEntries(SCALE_TABLES.map((table)=>[table,"a".repeat(32)]));
const auxiliaryCounts=(value=0)=>Object.fromEntries(AUXILIARY_IDENTITY_TABLES.map((table)=>[table,value]));
const auxiliaryFingerprints=()=>Object.fromEntries(AUXILIARY_IDENTITY_TABLES.map((table)=>[table,"d".repeat(32)]));
const appStateCounts=(value=0)=>Object.fromEntries(APP_STATE_COLLECTIONS.map((key)=>[key,value]));
const shapeCounts=()=>({active_inventory_items:0,current_business_day_bills:0,current_business_day_payments:0,pending_bills:0,recent_stock_movements:0});
const snapshot=(overrides={})=>({
  schema_version:1,expected_project_ref:"tkbdyzxwwbhkpztgjjxh",identity_nonce:"f9bc0aed-b6c4-410f-ba2a-572522d03869",
  organization_id:"org-primary",transaction_read_only:true,open_sessions:0,open_customer_tabs:0,recoverable_hopped_sessions:0,
  processing_financial_mutations:0,processing_operational_mutations:0,scale_fixture_absent:true,scale_fixture_key_absent:true,scale_fixture_rpc_absent:true,scale_fixture_rpc:null,
  app_state:{version:7,bytes:1000,md5:"b".repeat(32),updated_at:"2026-09-13T00:00:00+00:00",updated_by:"61cc2f83-69d1-46ab-9d89-9df7f7b1e497"},
  public_counts:counts(),public_fingerprints:fingerprints(),auxiliary_counts:auxiliaryCounts(),auxiliary_fingerprints:auxiliaryFingerprints(),app_state_collection_counts:appStateCounts(),shape_counts:shapeCounts(),...overrides
});
const production=(publicCounts=counts())=>({status:"passed",projectRef:"rrdwbxvuwrbxefarxnse",databaseBaseline:{transactionReadOnly:true,appState:{bytes:500000,dataSelected:false},publicCounts,financialTotals:{pending_bill_count:2}}});

describe("operational performance scale fixture",()=>{
  it("parses immutable PowerShell JSON with or without a UTF-8 BOM",()=>{
    expect(parseJsonBytes(Buffer.from("\ufeff{\"ok\":true}"))).toEqual({ok:true});
    expect(parseJsonBytes(Buffer.from("{\"ok\":true}"))).toEqual({ok:true});
  });

  it("extracts only aggregate app_state collection counts from a bound COPY artifact",()=>{
    const data=Object.fromEntries(APP_STATE_COLLECTIONS.map((key)=>[key,key==="bills"?[{},{}]:[]]));
    const copy=`COPY public.app_state (id, data, version, updated_at, updated_by) FROM stdin;\nprimary\t${JSON.stringify(data)}\t1\t2026-09-13 00:00:00+00\t\\N\n\\.\n`;
    expect(extractAppStateCollectionCountsFromCopy(Buffer.from(copy)).bills).toBe(2);
  });

  it("extracts bounded production workload-shape counts without exporting row values",()=>{
    const copy=[
      "COPY public.bills (organization_id, id, status, issued_at) FROM stdin;","org-primary\tb1\tpending\t2026-08-31T02:00:00Z","\\.",
      "COPY public.payments (organization_id, id, paid_at) FROM stdin;","org-primary\tp1\t2026-08-31T02:00:00Z","\\.",
      "COPY public.inventory_items (organization_id, id, active) FROM stdin;","org-primary\ti1\tt","\\.",
      "COPY public.stock_movements (organization_id, id, movement_at) FROM stdin;","org-primary\tm1\t2026-08-02T02:00:00Z","org-primary\tm2\t2020-01-01T00:00:00Z","\\.",""
    ].join("\n");
    expect(extractProductionShapeCountsFromCopy(Buffer.from(copy),"2026-08-31T11:06:06Z")).toEqual({active_inventory_items:1,current_business_day_bills:1,current_business_day_payments:1,pending_bills:1,recent_stock_movements:1});
  });

  it("computes zero, one, and odd deficits and adds only required relational anchors",()=>{
    const current=counts(5); const target=counts(5);
    target.sessions=6; target.audit_logs=12; target.session_items=5;
    const plan=computeScalePlan(current,target);
    expect(plan.deficits.sessions).toBe(1);
    expect(plan.deficits.audit_logs).toBe(7);
    expect(plan.deficits.payments).toBe(0);
    expect(plan.insertCounts.sessions).toBe(1);
    expect(plan.targetCounts.audit_logs).toBe(12);

    const anchors=computeScalePlan(counts(5),{...counts(5),bill_lines:6,combo_choice_options:6,sale_variants:6});
    expect(anchors.insertCounts.bills).toBe(1);
    expect(anchors.insertCounts.combos).toBe(1);
    expect(anchors.insertCounts.combo_choice_groups).toBe(1);
    expect(anchors.insertCounts.inventory_items).toBe(1);
  });

  it("keeps the full observed production-shaped representative AppData plan inside the exact runtime envelope",()=>{
    const stagingAppState={stations:7,pricingRules:8,sessions:206,sessionPauseLogs:18,customers:64,customerTabs:103,inventoryItems:62,inventoryCategories:8,combos:8,stockMovements:287,bills:132,payments:139,auditLogs:787,expenses:6,expenseTemplates:2,expenseTemplateOverrides:0};
    const productionAppState={stations:7,pricingRules:8,sessions:1678,sessionPauseLogs:983,customers:674,customerTabs:1363,inventoryItems:168,inventoryCategories:10,combos:7,stockMovements:5554,bills:2480,payments:2401,auditLogs:10345,expenses:29,expenseTemplates:10,expenseTemplateOverrides:0};
    const productionNormalized={...counts(),sessions:1678,session_items:2568,customer_tabs:1363,customer_tab_items:2538,bills:2480,bill_lines:6603,bill_line_discounts:186,sale_variants:56};
    const plan=computeScalePlan(counts(),productionNormalized);
    plan.appState=computeAppStateScalePlan(stagingAppState,productionAppState);
    const estimate=estimateRepresentativeAppStateUpperBoundBytes(1_045_421,plan);
    const targetBytes=4_811_943;
    const maximumBytes=Math.ceil(targetBytes*1.25);
    expect(plan.appState.representationFraction).toBe(0.25);
    expect(Math.max(targetBytes,estimate.prePaddingUpperBoundBytes)+estimate.paddingBatchUpperBoundBytes).toBeLessThanOrEqual(maximumBytes);
  });

  it("rejects wrong environment, dirty floors, missing fingerprints, and existing fixture state",()=>{
    for(const changed of [
      {identity_nonce:"wrong"},{open_sessions:1},{recoverable_hopped_sessions:1},{processing_operational_mutations:1},
      {scale_fixture_absent:false},{scale_fixture_key_absent:false},{scale_fixture_rpc_absent:false},{public_fingerprints:{}},{auxiliary_fingerprints:{}},{shape_counts:{}}
    ]) expect(()=>validatePreflight(snapshot(changed))).toThrow(/preflight is invalid/);
  });

  it("generates atomic, deterministic, terminal, zero-value apply, cleanup, and rollback-only proof SQL",()=>{
    const source=snapshot();
    const targets=counts();
    Object.assign(targets,{sessions:3,session_items:5,session_pause_logs:2,customer_tabs:2,customer_tab_items:3,bills:2,bill_lines:5,payments:1,customers:1,audit_logs:3,operational_events:3,stock_movements:3,inventory_items:2,sale_variants:3,combo_choice_options:2,expenses:1,expense_templates:1});
    const targetAppState=appStateCounts(2);
    const generated=buildFixturePackage({runId:"normops-20260913-1400-scale-unit",snapshot:source,production:production(targets),productionAppStateCounts:targetAppState,productionShapeCounts:{active_inventory_items:2,current_business_day_bills:1,current_business_day_payments:1,pending_bills:2,recent_stock_movements:2},packageBindingSha256:"c".repeat(64)});
    for(const sql of [generated.seed,generated.cleanup,generated.proof]){
      expect((sql.match(/\bbegin;/gi)??[])).toHaveLength(1);
      expect((sql.match(/\b(commit|rollback);/gi)??[])).toHaveLength(1);
      expect(sql).toContain("7623125441096521075");
      expect(sql).toContain("f9bc0aed-b6c4-410f-ba2a-572522d03869");
      expect(sql).toContain("qa_performance_scale");
      expect(sql).not.toContain("drop schema qa_performance_scale cascade");
      expect(sql).not.toMatch(/delete[^;]+like/i);
    }
    expect(generated.seed).toContain("started_at,ended_at,status,customer_id");
    expect(generated.seed).toContain("'closed'");
    expect(generated.seed).toContain("close_disposition");
    expect(generated.seed).toContain("'rejected'");
    expect(generated.seed).toContain("qaPerformanceScaleFixture");
    expect(generated.seed).toContain("array['bills']");
    expect(generated.seed).toContain("array['inventoryItems']");
    expect(generated.seed).toContain("qa_scale_fixture_padding");
    expect(generated.seed).toContain("create function public.get_operational_performance_scale_identity");
    expect(generated.seed).not.toContain("create or replace function public.get_operational_performance_scale_identity");
    expect(generated.seed).not.toContain("to_jsonb(a)");
    expect(generated.seed).not.toContain("has_function_privilege('public'");
    expect(generated.seed).toContain("aclexplode");
    expect(generated.plan.appState.runtimeExactSizeGuard).toBe(true);
    expect(generated.seed).toContain("disable trigger bills_analytics_dirty");
    expect(generated.cleanup).toContain("disable trigger stock_movements_inventory_report_dirty");
    expect(generated.proof).toContain("auxiliary_fingerprints");
    expect(generated.seed).toContain("amount_paid,amount_due");
    expect(generated.seed).toContain("quantity<>0) then raise exception 'fixture movement is not inert'");
    expect(generated.cleanup).toContain("scaled dataset drift prevents cleanup");
    expect(generated.cleanup).toContain("disable trigger app_state_set_updated_at");
    expect(generated.cleanup).toContain("enable trigger app_state_set_updated_at");
    expect(generated.cleanup).toContain("cleanup did not restore exact preflight identity");
    expect(generated.proof.trimEnd().endsWith("rollback;")).toBe(true);
  });

  it("rejects a deliberately unsafe generated cleanup artifact",()=>{
    expect(()=>assertSafeGeneratedSql("unsafe","begin; drop schema qa_performance_scale cascade; rollback;")).toThrow(/unsafe cleanup SQL/);
    expect(()=>assertSafeGeneratedSql("unsafe","begin; delete from public.bills where id like 'x%'; rollback;")).toThrow(/unsafe cleanup SQL/);
  });
});
