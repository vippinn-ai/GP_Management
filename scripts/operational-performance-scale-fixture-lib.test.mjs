import { describe, expect, it } from "vitest";
import {
  AUXILIARY_IDENTITY_TABLES,
  APP_STATE_COLLECTIONS,
  SCALE_TABLES,
  TEMPORAL_SHAPE_COUNT_KEYS,
  assertRolloverStableIdentity,
  assertSafeGeneratedSql,
  buildFixturePackage,
  buildRolloverCleanupPackage,
  computeAppStateScalePlan,
  computeScalePlan,
  estimateRepresentativeAppStateUpperBoundBytes,
  extractAppStateCollectionCountsFromCopy,
  extractProductionShapeCountsFromCopy,
  parseJsonBytes,
  scaleIdentityFromSnapshot,
  stableScaleIdentity,
  validatePreflight
} from "./operational-performance-scale-fixture-lib.mjs";
import {
  getSellableInventoryOptions,
  resolveComboChoiceSelections,
  resolveComboFixedSelections
} from "../src/utils";

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
    expect(generated.seed).toContain("revoke execute on function public.get_operational_performance_scale_identity(jsonb) from service_role");
    expect(generated.seed).toContain("md5(replace(replace(v_proc.prosrc,chr(13)||chr(10),chr(10)),chr(13),chr(10)))");
    expect(generated.seed).toContain("md5(replace(replace(prosrc,chr(13)||chr(10),chr(10)),chr(13),chr(10)))");
    expect(generated.seed).toContain("md5(replace(replace(pg_get_functiondef(to_regprocedure('public.get_operational_performance_scale_identity(jsonb)')),chr(13)||chr(10),chr(10)),chr(13),chr(10)))");
    expect(generated.seed).not.toContain("to_jsonb(a)");
    expect(generated.seed).not.toContain("has_function_privilege('public'");
    expect(generated.seed).toContain("aclexplode");
    expect(generated.plan.appState.runtimeExactSizeGuard).toBe(true);
    expect(generated.seed).toContain("disable trigger bills_analytics_dirty");
    expect(generated.cleanup).toContain("disable trigger stock_movements_inventory_report_dirty");
    expect(generated.proof).toContain("auxiliary_fingerprints");
    expect(generated.seed).toContain("amount_paid,amount_due");
    expect(generated.seed).toMatch(/insert into public\.combo_fixed_items \([^\r\n]*quantity[^\r\n]*\)\r?\nselect [^\r\n]*,1,jsonb_build_object\('qaScaleRunId'/);
    expect(generated.seed).not.toMatch(/insert into public\.combo_fixed_items \([^\r\n]*quantity[^\r\n]*\)\r?\nselect [^\r\n]*,0,jsonb_build_object\('qaScaleRunId'/);
    expect(generated.seed).toMatch(/insert into public\.combo_fixed_items \([^\r\n]*sellable_option_id[^\r\n]*\)\r?\nselect [^\r\n]*-inventory-[^\r\n]*::variant::[^\r\n]*-variant-/);
    expect(generated.seed).toMatch(/insert into public\.combo_choice_options \([^\r\n]*option_id[^\r\n]*\)\r?\nselect [^\r\n]*-combo-group-[^\r\n]*-inventory-[^\r\n]*::variant::[^\r\n]*-variant-/);
    expect(generated.seed).not.toContain("-sellable-option-");
    expect(generated.seed).not.toContain("-combo-option-");
    expect(generated.seed).toContain("coalesce(item.sell_base_item,true)");
    expect(generated.seed).toContain("item.id||'::variant::'||variant.id");
    expect(generated.seed).toContain("not coalesce(item.is_reusable,false)");
    expect(generated.seed).toContain("coalesce(item.category,'')<>'Cigarettes'");
    expect(generated.seed).toMatch(/insert into public\.session_items \([^\r\n]*quantity[^\r\n]*\)\r?\nselect [^\r\n]*,'QA Performance Item',1,0,/);
    expect(generated.seed).toMatch(/insert into public\.customer_tab_items \([^\r\n]*quantity[^\r\n]*\)\r?\nselect [^\r\n]*,'QA Performance Item',1,0,/);
    expect(generated.seed).not.toContain("'name','QA Performance Item','quantity',0,'unitPrice',0");
    expect(generated.seed).toContain("fixture combo fixed-item quantity violates the bootstrap contract");
    expect(generated.seed).toContain("fixture combo fixed-item option does not resolve");
    expect(generated.seed).toContain("fixture combo choice option does not resolve");
    expect(generated.seed).toContain("fixture session-item quantity violates the bootstrap contract");
    expect(generated.seed).toContain("fixture tab-item quantity violates the bootstrap contract");
    expect(generated.seed).toContain("quantity<>0) then raise exception 'fixture movement is not inert'");
    expect(generated.cleanup).toContain("scaled dataset drift prevents cleanup");
    expect(generated.cleanup).toMatch(/delete from public\.combo_choice_options where organization_id='org-primary' and choice_group_id in \(select [^;]*-combo-group-[^;]*generate_series\(1,1\) g\);/);
    expect(generated.cleanup).toContain("disable trigger app_state_set_updated_at");
    expect(generated.cleanup).toContain("enable trigger app_state_set_updated_at");
    expect(generated.cleanup).toContain("cleanup did not restore exact preflight identity");
    expect(generated.proof.trimEnd().endsWith("rollback;")).toBe(true);
  });

  it("uses application-resolvable composite variant IDs for generated fixed and choice options",()=>{
    const inventoryItem={
      id:"normops-unit-inventory-000001",name:"QA Performance Item",category:"QA Performance",price:0,
      stockQty:0,lowStockThreshold:0,unit:"piece",isReusable:false,active:true,sellBaseItem:false,
      saleVariants:[{id:"normops-unit-variant-000001",name:"QA Performance Variant",price:0,stockUnitsPerSale:1,active:true}],
      createdAt:"2026-09-14T00:00:00.000Z",updatedAt:"2026-09-14T00:00:00.000Z"
    };
    const optionId=`${inventoryItem.id}::variant::${inventoryItem.saleVariants[0].id}`;
    const options=getSellableInventoryOptions([inventoryItem]);
    const combo={
      id:"combo-1",name:"QA Performance Combo",type:"game",active:true,stationIds:[],price:0,includedMinutes:1,
      fixedItems:[{id:"fixed-1",sellableOptionId:optionId,quantity:1}],
      choiceGroups:[{id:"choice-1",label:"Choice",requiredQuantity:1,optionIds:[optionId]}],
      createdAt:"2026-09-14T00:00:00.000Z",updatedAt:"2026-09-14T00:00:00.000Z"
    };
    expect(options.map((option)=>option.id)).toEqual([optionId]);
    expect(resolveComboFixedSelections(combo,options)).toHaveLength(1);
    expect(resolveComboChoiceSelections(combo,options,{"choice-1":optionId})).toHaveLength(1);

    for(const invalid of [
      {...inventoryItem,active:false},
      {...inventoryItem,isReusable:true},
      {...inventoryItem,category:"Cigarettes"},
      {...inventoryItem,saleVariants:[{...inventoryItem.saleVariants[0],active:false}]}
    ]) expect(getSellableInventoryOptions([invalid])).toEqual([]);
    expect(resolveComboFixedSelections({...combo,fixedItems:[{id:"fixed-1",sellableOptionId:inventoryItem.saleVariants[0].id,quantity:1}]},options)).toBeNull();
    expect(resolveComboFixedSelections({...combo,fixedItems:[{id:"fixed-1",sellableOptionId:"missing",quantity:1}]},options)).toBeNull();
  });

  it("fails closed when combo option deficits have no active synthetic variant anchor",()=>{
    const targets=counts();
    Object.assign(targets,{combos:1,combo_fixed_items:1,combo_choice_groups:1,combo_choice_options:1});
    expect(()=>buildFixturePackage({
      runId:"normops-20260914-1600-scale-no-option",snapshot:snapshot(),production:production(targets),
      productionAppStateCounts:appStateCounts(),productionShapeCounts:shapeCounts(),packageBindingSha256:"c".repeat(64)
    })).toThrow(/without an active synthetic sale variant/);

    const constrainedTargets=counts();
    Object.assign(constrainedTargets,{inventory_items:1,sale_variants:1,combos:1,combo_choice_groups:1,combo_choice_options:2});
    expect(()=>buildFixturePackage({
      runId:"normops-20260914-1601-scale-option-capacity",snapshot:snapshot(),production:production(constrainedTargets),
      productionAppStateCounts:appStateCounts(),
      productionShapeCounts:{...shapeCounts(),active_inventory_items:1},packageBindingSha256:"c".repeat(64)
    })).toThrow(/cannot generate unique combo choice options/);
  });

  it("rejects a deliberately unsafe generated cleanup artifact",()=>{
    expect(()=>assertSafeGeneratedSql("unsafe","begin; drop schema qa_performance_scale cascade; rollback;")).toThrow(/unsafe cleanup SQL/);
    expect(()=>assertSafeGeneratedSql("unsafe","begin; delete from public.bills where id like 'x%'; rollback;")).toThrow(/unsafe cleanup SQL/);
  });

  it("accepts only clock-derived workload-shape ageing as a rollover-stable identity",()=>{
    const applied=snapshot({
      scale_fixture_absent:false,scale_fixture_key_absent:false,scale_fixture_rpc_absent:false,
      scale_fixture_rpc:{owner:"postgres"},
      shape_counts:{active_inventory_items:112,current_business_day_bills:1,current_business_day_payments:1,pending_bills:36,recent_stock_movements:1506}
    });
    const aged={...applied,shape_counts:{...applied.shape_counts,current_business_day_bills:0,current_business_day_payments:0,recent_stock_movements:1462}};
    expect(TEMPORAL_SHAPE_COUNT_KEYS).toEqual(["current_business_day_bills","current_business_day_payments","recent_stock_movements"]);
    expect(stableScaleIdentity(scaleIdentityFromSnapshot(aged))).toEqual(stableScaleIdentity(scaleIdentityFromSnapshot(applied)));
    expect(()=>assertRolloverStableIdentity(scaleIdentityFromSnapshot(aged),scaleIdentityFromSnapshot(applied))).not.toThrow();
    for(const drifted of [
      {...aged,app_state:{...aged.app_state,md5:"e".repeat(32)}},
      {...aged,public_counts:{...aged.public_counts,bills:1}},
      {...aged,public_fingerprints:{...aged.public_fingerprints,bills:"e".repeat(32)}},
      {...aged,auxiliary_counts:{...aged.auxiliary_counts,activity_events:1}},
      {...aged,auxiliary_fingerprints:{...aged.auxiliary_fingerprints,activity_events:"e".repeat(32)}},
      {...aged,scale_fixture_rpc:{owner:"unexpected"}},
      {...aged,shape_counts:{...aged.shape_counts,active_inventory_items:111}},
      {...aged,shape_counts:{...aged.shape_counts,pending_bills:35}}
    ]) expect(()=>assertRolloverStableIdentity(scaleIdentityFromSnapshot(drifted),scaleIdentityFromSnapshot(applied))).toThrow(/not a clock-only/);
    expect(()=>stableScaleIdentity({...scaleIdentityFromSnapshot(aged),shape_counts:{}})).toThrow(/workload-shape identity is invalid/);
  });

  it("generates a unique rollover cleanup that retains strict stored identity and exact deletion counts",()=>{
    const original=snapshot();
    const targets=counts();
    Object.assign(targets,{bills:2,bill_lines:2,payments:1,stock_movements:2,inventory_items:1,sale_variants:1,combos:1,combo_choice_groups:2,combo_choice_options:2,audit_logs:1,operational_events:1});
    const fixture=buildFixturePackage({
      runId:"normops-20260913-1400-scale-unit",
      snapshot:original,
      production:production(targets),
      productionAppStateCounts:appStateCounts(1),
      productionShapeCounts:{active_inventory_items:1,current_business_day_bills:1,current_business_day_payments:1,pending_bills:2,recent_stock_movements:2},
      packageBindingSha256:"c".repeat(64)
    });
    const fixtureManifest={
      operation:"staging-operational-performance-scale-fixture",runId:"normops-20260913-1400-scale-unit",
      target:{projectRef:"tkbdyzxwwbhkpztgjjxh",identityNonce:"f9bc0aed-b6c4-410f-ba2a-572522d03869",organizationId:"org-primary"},
      packageBindingSha256:"c".repeat(64),plan:fixture.plan,productionAllowed:false,automaticRetryAllowed:false
    };
    const applied={
      ...original,scale_fixture_absent:false,scale_fixture_key_absent:false,scale_fixture_rpc_absent:false,
      app_state:{...original.app_state,version:8,bytes:500000,md5:"c".repeat(32)},
      public_counts:fixture.plan.targetCounts,
      shape_counts:fixture.plan.shape.targetCounts,
      scale_fixture_rpc:{owner:"postgres",security_definer:true}
    };
    const aged={...applied,shape_counts:{...applied.shape_counts,current_business_day_bills:0,current_business_day_payments:0,recent_stock_movements:1}};
    const rollover=buildRolloverCleanupPackage({
      rolloverRunId:"normops-20260914-1300-scale-rollover-cleanup-unit",
      fixtureManifest,originalSnapshot:original,appliedSnapshot:applied,currentSnapshot:aged
    });
    expect(rollover.cleanup.trimEnd().endsWith("commit;")).toBe(true);
    expect(rollover.proof.trimEnd().endsWith("rollback;")).toBe(true);
    for(const sql of [rollover.cleanup,rollover.proof]){
      expect(sql).toContain("staging-operational-performance-scale-rollover-cleanup");
      expect(sql).toContain("get diagnostics v_deleted=row_count");
      expect(sql).toContain("fixture cleanup row count mismatch in bills");
      expect(sql).toMatch(/delete from public\.combo_choice_options where organization_id='org-primary' and choice_group_id in \(select [^;]*-combo-group-[^;]*generate_series\(1,2\) g\);[\s\S]*?if v_deleted<>2 then raise exception 'fixture cleanup row count mismatch in combo_choice_options'/);
      expect(sql).toContain("-'current_business_day_bills'");
      expect(sql).toContain("-'current_business_day_payments'");
      expect(sql).toContain("-'recent_stock_movements'");
      expect(sql).toContain("scaled dataset drift prevents cleanup");
      expect(sql).toContain("cleanup did not restore exact stored preflight identity");
      expect(sql).not.toContain("v_live<>v_expected");
      expect(sql).not.toContain("drop schema qa_performance_scale cascade");
    }
  });
});
