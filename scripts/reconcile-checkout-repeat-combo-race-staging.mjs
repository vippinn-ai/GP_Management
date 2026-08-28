import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { selectComboRaceEvidenceCandidate } from "./checkout-repeat-combo-race-evidence.mjs";
import {
  assertLiveCredentials,
  assertStagingSupabaseEnvironment,
  parseEnvFile,
  sanitizeRunId,
  STAGING_PROJECT_REF
} from "./playwright-staging-env.mjs";

const root = process.cwd();
const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const env = { ...localEnv, ...process.env };
const organizationId = "org-primary";
const scenarioNames = ["checkout_first", "combo_first", "simultaneous"];

assertStagingSupabaseEnvironment(stagingEnv, true);
assertLiveCredentials(env);
if (!env.E2E_REPEAT_COMBO_RECONCILE_RUN_ID?.trim()) throw new Error("E2E_REPEAT_COMBO_RECONCILE_RUN_ID is required.");
const runId = sanitizeRunId(env.E2E_REPEAT_COMBO_RECONCILE_RUN_ID);
const artifactRoot = path.join(root, "test-artifacts");
const preflightPath = path.join(artifactRoot, "preflight", `checkout-repeat-combo-race-preflight-${runId}.json`);
const revision = env.E2E_REPEAT_COMBO_RECONCILE_REVISION?.trim();
if (revision && !/^[A-Za-z0-9_-]{3,32}$/.test(revision)) throw new Error("E2E_REPEAT_COMBO_RECONCILE_REVISION is invalid.");
const baseOutputPath = path.join(artifactRoot, "reconciliation", `checkout-repeat-combo-race-postflight-${runId}.json`);
const outputPath = revision
  ? path.join(artifactRoot, "reconciliation", `checkout-repeat-combo-race-postflight-${runId}-${revision}.json`)
  : baseOutputPath;
if (!fs.existsSync(preflightPath)) throw new Error("The exact combo-race preflight artifact is missing.");
if (revision && !fs.existsSync(baseOutputPath)) throw new Error("A superseding review requires the immutable original postflight artifact.");
if (fs.existsSync(outputPath)) throw new Error("The exact combo-race postflight artifact already exists; refusing overwrite.");
const preflight = JSON.parse(fs.readFileSync(preflightPath, "utf8"));
if (!preflight.safeToRun || preflight.runId !== runId) throw new Error("The combo-race preflight was not safe.");

const artifacts = scenarioNames.map((scenario) => {
  const candidates = [
    `checkout-repeat-combo-race-${runId}-${scenario}.json`,
    `checkout-repeat-combo-race-${runId}-${scenario}-responses.json`,
    `checkout-repeat-combo-race-${runId}-${scenario}-prepared.json`
  ].map((fileName) => path.join(artifactRoot, "reconciliation", fileName))
    .filter((artifactPath) => fs.existsSync(artifactPath))
    .map((artifactPath) => ({ artifactPath, content: fs.readFileSync(artifactPath, "utf8") }));
  return { scenario, ...selectComboRaceEvidenceCandidate(candidates, runId, scenario) };
});

const hash = (data) => createHash("sha256").update(JSON.stringify(data)).digest("hex");
const changedIds = (result, collection) => {
  const values = result?.changedRows?.[collection] ?? result?.changed_rows?.[collection];
  return Array.isArray(values) ? values.map(String).sort() : [];
};
const unique = (values) => [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
const sameIds = (left, right) => JSON.stringify(unique(left).sort()) === JSON.stringify(unique(right).sort());

const failures = [];
const checks = [];
function check(condition, message) {
  checks.push({ passed: Boolean(condition), message });
  if (!condition) failures.push(message);
}
function requireData(result, label) {
  if (result.error) throw new Error(`${label} reconciliation failed: ${result.error.message}`);
  return result.data ?? [];
}

const report = {
  runId,
  revision: revision ?? null,
  supersedes: revision ? path.relative(root, baseOutputPath) : null,
  checkedAt: new Date().toISOString(),
  projectRef: STAGING_PROJECT_REF,
  classifications: artifacts.map(({ scenario, artifactPath, classification, evidence, rejectedCandidates }) => ({
    scenario,
    artifactPath,
    classification,
    rejectedCandidates,
    sessionId: evidence?.sessionId ?? null,
    primaryError: evidence?.primaryError ?? null,
    lifecycle: evidence?.lifecycle ?? null
  })),
  checks,
  failures,
  passed: false
};

try {
  const supabaseUrl = stagingEnv.VITE_SUPABASE_URL?.trim();
  const supabaseAnonKey = stagingEnv.VITE_SUPABASE_ANON_KEY?.trim();
  if (!supabaseUrl || !supabaseAnonKey || new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) {
    throw new Error("Combo-race reconciliation is locked to staging.");
  }
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
  const lookup = await supabase.functions.invoke("resolve-login-email", { body: { username: env.E2E_USER_A.trim() } });
  if (lookup.error || !lookup.data?.email) throw new Error("Unable to resolve the reconciliation account.");
  const login = await supabase.auth.signInWithPassword({ email: lookup.data.email, password: env.E2E_PASSWORD_A });
  if (login.error || !login.data.user) throw new Error("Unable to authenticate the reconciliation account.");
  const role = await supabase.rpc("current_user_org_role", { target_organization_id: organizationId });
  if (role.error || role.data !== "admin") throw new Error("Combo-race reconciliation requires an authoritative staging admin.");
  report.actorId = login.data.user.id;

  const completed = artifacts.filter((entry) => entry.classification === "completed").map((entry) => entry.evidence);
  const acknowledged = artifacts.filter((entry) => entry.evidence?.sessionId).map((entry) => entry.evidence);
  const customerNames = scenarioNames.map((scenario) => `QA Combo Race ${runId} ${scenario}`);
  const billNumbers = scenarioNames.map((scenario) => `BILL-QA-COMBO-RACE-${runId}-${scenario}`);
  const sessionIds = unique(acknowledged.map((entry) => entry.sessionId));
  const billIds = unique(acknowledged.map((entry) => entry.candidateBillId));
  const mutationIds = unique(acknowledged.flatMap((entry) => [entry.checkoutMutationId, entry.comboMutationId, entry.cleanup?.result?.mutationId, entry.emergencyCleanup?.result?.mutationId]));
  const auditIds = unique(acknowledged.flatMap((entry) => [
    ...(entry.expectedFinancial?.auditIds ?? []), entry.repeatedAuditId,
    ...changedIds(entry.cleanup?.result, "audit_logs"), ...changedIds(entry.emergencyCleanup?.result, "audit_logs")
  ]));
  const movementIds = unique(acknowledged.flatMap((entry) => [
    ...(entry.setupStockMovementIds ?? []), ...(entry.expectedFinancial?.stockMovementIds ?? []), ...(entry.repeatedStockMovementIds ?? []),
    ...changedIds(entry.cleanup?.result, "stock_movements"), ...changedIds(entry.emergencyCleanup?.result, "stock_movements")
  ]));

  async function byIds(table, select, column, ids) {
    if (ids.length === 0) return [];
    return requireData(await supabase.from(table).select(select).eq("organization_id", organizationId).in(column, ids), table);
  }

  const [runSessionsResult, runBillsResult, openSessionsResult, openTabsResult, appStateResult] = await Promise.all([
    supabase.from("sessions").select("id,status,close_disposition,closed_bill_id,customer_name,station_name_snapshot").eq("organization_id", organizationId).in("customer_name", customerNames),
    supabase.from("bills").select("id,bill_number,status,issued_by_user_id,total,amount_paid,amount_due").eq("organization_id", organizationId).in("bill_number", billNumbers),
    supabase.from("sessions").select("id,status,customer_name").eq("organization_id", organizationId).neq("status", "closed"),
    supabase.from("customer_tabs").select("id,status,customer_name").eq("organization_id", organizationId).eq("status", "open"),
    supabase.from("app_state").select("version,data").eq("id", "primary").single()
  ]);
  const runSessions = requireData(runSessionsResult, "run sessions");
  const runBills = requireData(runBillsResult, "run bills");
  const openSessions = requireData(openSessionsResult, "open sessions");
  const openTabs = requireData(openTabsResult, "open tabs");
  if (appStateResult.error) throw new Error(`app_state reconciliation failed: ${appStateResult.error.message}`);

  const [sessions, combos, items, bills, billLines, payments, events, audits, movements, inventory] = await Promise.all([
    byIds("sessions", "id,status,close_disposition,closed_bill_id,customer_name,station_name_snapshot", "id", sessionIds),
    byIds("session_combo_applications", "id,session_id,combo_id", "session_id", sessionIds),
    byIds("session_items", "id,session_id,inventory_item_id,combo_application_id,quantity,stock_units_per_sale", "session_id", sessionIds),
    byIds("bills", "id,bill_number,status,issued_by_user_id,total,amount_paid,amount_due", "id", billIds),
    byIds("bill_lines", "id,bill_id,type,linked_session_id,inventory_item_id,quantity,unit_price,total,raw_data", "bill_id", billIds),
    byIds("payments", "id,bill_id,amount,mode,received_by_user_id", "bill_id", billIds),
    byIds("operational_events", "id,event_type,entity_id,created_by,metadata", "metadata->>mutation_id", mutationIds),
    byIds("audit_logs", "id,action,entity_id,user_id,message", "id", auditIds),
    byIds("stock_movements", "id,item_id,type,quantity,user_id,related_bill_id", "id", movementIds),
    byIds("inventory_items", "id,stock_qty", "id", preflight.fixture.stockEvidence.map((entry) => entry.itemId))
  ]);

  const checkoutStatuses = {};
  for (const entry of acknowledged) {
    if (!entry.checkoutMutationId) continue;
    const status = await supabase.rpc("get_financial_mutation_result", {
      payload: { organization_id: organizationId, mutation_id: entry.checkoutMutationId, mutation_kind: "commitCheckoutBill" }
    });
    if (status.error) throw new Error(`${entry.scenario} mutation lookup failed: ${status.error.message}`);
    checkoutStatuses[entry.scenario] = status.data;
  }

  let compatibility = { version: preflight.appState.version, hash: preflight.appState.hash };
  for (const artifact of artifacts) {
    const entry = artifact.evidence;
    const exactSessions = runSessions.filter((row) => row.customer_name === `QA Combo Race ${runId} ${artifact.scenario}`);
    const exactBills = runBills.filter((row) => row.bill_number === `BILL-QA-COMBO-RACE-${runId}-${artifact.scenario}`);
    check(artifact.classification !== "invalid_artifact", `${artifact.scenario} artifact identity is valid.`);
    if (artifact.classification === "ambiguous") {
      checks.push({ passed: true, message: `${artifact.scenario} submitted outcome will be resolved from deterministic database evidence.` });
    }

    if (artifact.classification === "not_started") {
      check(exactSessions.length === 0, `${artifact.scenario} not-started identity has no session.`);
      check(exactBills.length === 0, `${artifact.scenario} not-started identity has no bill.`);
      continue;
    }

    check(exactSessions.length === 1 && exactSessions[0].id === entry.sessionId, `${artifact.scenario} has exactly one acknowledged session identity.`);
    const session = sessions.find((row) => row.id === entry.sessionId);
    check(Boolean(session), `${artifact.scenario} acknowledged session exists.`);

    if (artifact.classification === "setup_only") {
      const cleanup = entry.emergencyCleanup;
      check(Boolean(cleanup), `${artifact.scenario} setup-only execution has acknowledged emergency cleanup.`);
      check(session?.status === "closed" && session?.close_disposition === "rejected" && session?.closed_bill_id === null, `${artifact.scenario} setup-only session is terminal rejected.`);
      check(exactBills.length === 0, `${artifact.scenario} setup-only identity has no bill.`);
      if (cleanup) {
        const cleanupEvents = events.filter((row) => row.metadata?.mutation_id === cleanup.result?.mutationId);
        const cleanupAudits = audits.filter((row) => changedIds(cleanup.result, "audit_logs").includes(row.id));
        const cleanupMovements = movements.filter((row) => changedIds(cleanup.result, "stock_movements").includes(row.id));
        check(cleanupEvents.length === 1 && cleanupEvents[0].id === cleanup.result?.eventId && cleanupEvents[0].created_by === report.actorId, `${artifact.scenario} emergency cleanup event and actor match.`);
        check(cleanupAudits.length === 1 && cleanupAudits[0].action === "session_rejected" && cleanupAudits[0].entity_id === entry.sessionId && cleanupAudits[0].user_id === report.actorId, `${artifact.scenario} emergency cleanup audit and actor match.`);
        check(changedIds(cleanup.result, "stock_movements").length === 0 && cleanupMovements.length === 0, `${artifact.scenario} emergency cleanup creates no compensating stock movements under reject_session.`);
        check(cleanup.appState?.version === compatibility.version + 1, `${artifact.scenario} emergency cleanup advances compatibility state exactly once.`);
        compatibility = cleanup.appState ?? compatibility;
      }
      continue;
    }

    if (artifact.classification === "ambiguous") {
      const bill = bills.find((row) => row.id === entry.candidateBillId);
      const status = checkoutStatuses[entry.scenario] ?? null;
      const expected = entry.expectedFinancial;
      const checkoutEvent = events.filter((row) => row.metadata?.mutation_id === entry.checkoutMutationId);
      const comboEvent = events.filter((row) => row.metadata?.mutation_id === entry.comboMutationId);
      const checkoutLines = billLines.filter((row) => row.bill_id === entry.candidateBillId);
      const checkoutPayments = payments.filter((row) => row.bill_id === entry.candidateBillId);
      const checkoutAudits = audits.filter((row) => expected?.auditIds?.includes(row.id));
      const checkoutMovements = movements.filter((row) => expected?.stockMovementIds?.includes(row.id));
      const repeatedCombos = combos.filter((row) => row.id === entry.repeatedComboApplicationId);
      const repeatedItems = items.filter((row) => entry.repeatedItemIds?.includes(row.id));
      const repeatedAudits = audits.filter((row) => row.id === entry.repeatedAuditId);
      const repeatedMovements = movements.filter((row) => entry.repeatedStockMovementIds?.includes(row.id));
      const checkoutCommitted = Boolean(bill || status || checkoutEvent.length || checkoutLines.length || checkoutPayments.length || checkoutAudits.length || checkoutMovements.length);
      const comboCommitted = Boolean(comboEvent.length || repeatedCombos.length || repeatedItems.length || repeatedAudits.length || repeatedMovements.length);
      check(Number(checkoutCommitted) + Number(comboCommitted) <= 1, `${artifact.scenario} ambiguous commands did not both commit.`);

      if (checkoutCommitted) {
        check(session?.status === "closed" && session?.close_disposition === "billed" && session?.closed_bill_id === entry.candidateBillId, `${artifact.scenario} ambiguous checkout effect has exact terminal session.`);
        check(exactBills.length === 1 && exactBills[0].id === entry.candidateBillId && bill?.status === "issued", `${artifact.scenario} ambiguous checkout effect has one issued bill.`);
        check(Number(bill?.total) === Number(expected?.bill?.total) && Number(bill?.amount_paid) === Number(expected?.bill?.amountPaid) && Number(bill?.amount_due) === Number(expected?.bill?.amountDue) && bill?.issued_by_user_id === entry.actors?.checkout, `${artifact.scenario} ambiguous checkout bill totals and actor match.`);
        check(status?.bill_id === entry.candidateBillId && sameIds(changedIds(status, "bills"), [entry.candidateBillId]) && sameIds(changedIds(status, "payments"), expected?.paymentIds ?? []) && sameIds(changedIds(status, "audit_logs"), expected?.auditIds ?? []) && sameIds(changedIds(status, "stock_movements"), expected?.stockMovementIds ?? []), `${artifact.scenario} ambiguous checkout canonical result and documented changed_rows match.`);
        check(sameIds(checkoutLines.map((row) => row.id), expected?.lineIds ?? []), `${artifact.scenario} ambiguous checkout exact bill-line IDs match.`);
        for (const expectedLine of expected?.bill?.lines ?? []) {
          const actual = checkoutLines.find((row) => row.id === expectedLine.id);
          check(Boolean(actual) && actual.type === expectedLine.type && actual.linked_session_id === entry.sessionId && (actual.raw_data?.linkedSessionItemId ?? null) === (expectedLine.linkedSessionItemId ?? null) && actual.inventory_item_id === (expectedLine.inventoryItemId ?? null) && Number(actual.quantity) === Number(expectedLine.quantity) && Number(actual.unit_price) === Number(expectedLine.unitPrice) && Number(actual.total) === Number(expectedLine.total), `${artifact.scenario} ambiguous checkout line ${expectedLine.id} matches.`);
        }
        const expectedPayment = expected?.payments?.[0];
        check(sameIds(checkoutPayments.map((row) => row.id), expected?.paymentIds ?? []) && checkoutPayments.length === 1 && Number(checkoutPayments[0].amount) === Number(expectedPayment?.amount) && checkoutPayments[0].mode === expectedPayment?.mode && checkoutPayments[0].received_by_user_id === entry.actors?.checkout, `${artifact.scenario} ambiguous checkout payments, values, and actors match.`);
        check(sameIds(checkoutAudits.map((row) => row.id), expected?.auditIds ?? []) && checkoutAudits.every((row) => row.user_id === entry.actors?.checkout), `${artifact.scenario} ambiguous checkout audits and actors match.`);
        for (const expectedAudit of expected?.audits ?? []) {
          const actual = checkoutAudits.find((row) => row.id === expectedAudit.id);
          check(Boolean(actual) && actual.action === expectedAudit.action && actual.entity_id === expectedAudit.entityId, `${artifact.scenario} ambiguous checkout audit ${expectedAudit.id} matches.`);
        }
        check(sameIds(checkoutMovements.map((row) => row.id), expected?.stockMovementIds ?? []) && checkoutMovements.every((row) => row.type === "sale" && Number(row.quantity) < 0 && row.user_id === entry.actors?.checkout && row.related_bill_id === entry.candidateBillId), `${artifact.scenario} ambiguous checkout movements and actors match.`);
        for (const expectedMovement of expected?.stockMovements ?? []) {
          const actual = checkoutMovements.find((row) => row.id === expectedMovement.id);
          check(Boolean(actual) && actual.item_id === expectedMovement.itemId && Number(actual.quantity) === Number(expectedMovement.quantity), `${artifact.scenario} ambiguous checkout movement ${expectedMovement.id} matches.`);
        }
        check(checkoutEvent.length === 1 && checkoutEvent[0].id === status?.event_id && checkoutEvent[0].event_type === "financial_checkout_committed_v2" && checkoutEvent[0].entity_id === entry.sessionId && checkoutEvent[0].created_by === entry.actors?.checkout, `${artifact.scenario} ambiguous checkout canonical event matches.`);
      } else {
        check(exactBills.length === 0 && !bill && status === null && checkoutEvent.length === 0 && checkoutLines.length === 0 && checkoutPayments.length === 0 && checkoutAudits.length === 0 && checkoutMovements.length === 0, `${artifact.scenario} ambiguous checkout has exact zero effect.`);
      }

      if (comboCommitted) {
        check(session?.status === "active" && session?.close_disposition === null && session?.closed_bill_id === null, `${artifact.scenario} ambiguous combo effect leaves the session active.`);
        check(comboEvent.length === 1 && comboEvent[0].event_type === "repeat_session_combo" && comboEvent[0].entity_id === entry.sessionId && comboEvent[0].created_by === entry.actors?.combo, `${artifact.scenario} ambiguous combo event and actor match.`);
        check(repeatedCombos.length === 1 && repeatedCombos[0].combo_id === preflight.fixture.combo.id, `${artifact.scenario} ambiguous repeat application matches fixture.`);
        check(sameIds(repeatedItems.map((row) => row.id), entry.repeatedItemIds ?? []), `${artifact.scenario} ambiguous repeat item IDs match.`);
        check(repeatedAudits.length === 1 && repeatedAudits[0].action === "combo_repeated" && repeatedAudits[0].user_id === entry.actors?.combo, `${artifact.scenario} ambiguous repeat audit and actor match.`);
        check(sameIds(repeatedMovements.map((row) => row.id), entry.repeatedStockMovementIds ?? []) && repeatedMovements.every((row) => row.type === "session_reservation" && Number(row.quantity) < 0 && row.user_id === entry.actors?.combo && row.related_bill_id === null), `${artifact.scenario} ambiguous repeat movements and actors match.`);
        for (const expectedItem of entry.expectedOperational?.items ?? []) {
          const actual = repeatedItems.find((row) => row.id === expectedItem.id);
          check(Boolean(actual) && actual.inventory_item_id === (expectedItem.inventoryItemId ?? null) && actual.combo_application_id === entry.repeatedComboApplicationId, `${artifact.scenario} ambiguous repeated item ${expectedItem.id} matches.`);
        }
        for (const expectedMovement of entry.expectedOperational?.stockMovements ?? []) {
          const actual = repeatedMovements.find((row) => row.id === expectedMovement.id);
          check(Boolean(actual) && actual.item_id === expectedMovement.itemId && Number(actual.quantity) === Number(expectedMovement.quantity), `${artifact.scenario} ambiguous repeat movement ${expectedMovement.id} matches.`);
        }
      } else {
        check(comboEvent.length === 0 && repeatedCombos.length === 0 && repeatedItems.length === 0 && repeatedAudits.length === 0 && repeatedMovements.length === 0, `${artifact.scenario} ambiguous combo has exact zero effect.`);
      }
      report.ambiguousOutcomes ??= [];
      report.ambiguousOutcomes.push({ scenario: artifact.scenario, checkoutCommitted, comboCommitted });
      continue;
    }

    if (artifact.classification !== "completed") continue;
    check(entry.lifecycle?.outcomeResolved === true, `${artifact.scenario} completed artifact records resolved outcome.`);
    check(entry.lifecycle?.checkoutSubmitted === true && entry.lifecycle?.comboSubmitted === true, `${artifact.scenario} submitted each command exactly once.`);
    check(entry.lifecycle?.checkoutCaptureCount === 1 && entry.lifecycle?.comboCaptureCount === 1, `${artifact.scenario} captured each command exactly once.`);
    check(entry.appStateBefore?.version === compatibility.version && entry.appStateBefore?.hash === compatibility.hash, `${artifact.scenario} compatibility baseline chains from the prior scenario.`);
    check(entry.afterRace?.appState?.version === entry.appStateBefore?.version && entry.afterRace?.appState?.hash === entry.appStateBefore?.hash, `${artifact.scenario} race leaves app_state unchanged.`);

    const bill = bills.find((row) => row.id === entry.candidateBillId);
    const comboEvent = events.filter((row) => row.metadata?.mutation_id === entry.comboMutationId);
    const checkoutEvent = events.filter((row) => row.metadata?.mutation_id === entry.checkoutMutationId);
    const repeatedCombos = combos.filter((row) => row.id === entry.repeatedComboApplicationId);
    const repeatedItems = items.filter((row) => entry.repeatedItemIds?.includes(row.id));
    const repeatedAudits = audits.filter((row) => row.id === entry.repeatedAuditId);
    const repeatedMovements = movements.filter((row) => entry.repeatedStockMovementIds?.includes(row.id));
    const expected = entry.expectedFinancial;
    const status = checkoutStatuses[entry.scenario] ?? null;
    const setupMovements = movements.filter((row) => entry.setupStockMovementIds?.includes(row.id));
    check(sameIds(setupMovements.map((row) => row.id), entry.setupStockMovementIds ?? []), `${entry.scenario} setup reservation movement IDs match.`);
    check(setupMovements.every((row) => row.type === "session_reservation" && Number(row.quantity) < 0 && row.user_id === entry.actors.checkout && row.related_bill_id === null), `${entry.scenario} setup reservations and actor match.`);

    if (entry.winner === "checkout") {
      check(session?.status === "closed" && session?.close_disposition === "billed" && session?.closed_bill_id === entry.candidateBillId, `${entry.scenario} checkout terminal session matches.`);
      check(exactBills.length === 1 && exactBills[0].id === entry.candidateBillId, `${entry.scenario} has exactly one winning bill identity.`);
      check(Boolean(bill) && bill.bill_number === entry.candidateBillNumber && bill.status === "issued", `${entry.scenario} winning bill exists and is issued.`);
      check(Number(bill?.total) === Number(expected.bill.total) && Number(bill?.amount_paid) === Number(expected.bill.amountPaid) && Number(bill?.amount_due) === Number(expected.bill.amountDue), `${entry.scenario} bill totals match canonical checkout.`);
      check(bill?.issued_by_user_id === entry.actors.checkout, `${entry.scenario} bill actor matches authenticated checkout actor.`);
      check(status?.bill_id === entry.candidateBillId && status?.bill_number === entry.candidateBillNumber, `${entry.scenario} canonical mutation result identifies the winning bill.`);
      check(sameIds(changedIds(status, "bills"), [entry.candidateBillId]), `${entry.scenario} canonical bill changed_rows match.`);
      check(sameIds(changedIds(status, "payments"), expected.paymentIds), `${entry.scenario} canonical payment changed_rows match.`);
      check(sameIds(changedIds(status, "audit_logs"), expected.auditIds), `${entry.scenario} canonical audit changed_rows match.`);
      check(sameIds(changedIds(status, "stock_movements"), expected.stockMovementIds), `${entry.scenario} canonical movement changed_rows match.`);

      const actualLines = billLines.filter((row) => row.bill_id === entry.candidateBillId);
      const expectedLines = expected.bill.lines ?? [];
      check(sameIds(actualLines.map((row) => row.id), expected.lineIds), `${entry.scenario} exact bill-line IDs match.`);
      for (const expectedLine of expectedLines) {
        const actual = actualLines.find((row) => row.id === expectedLine.id);
        check(Boolean(actual) && actual.type === expectedLine.type && actual.linked_session_id === entry.sessionId && (actual.raw_data?.linkedSessionItemId ?? null) === (expectedLine.linkedSessionItemId ?? null) && actual.inventory_item_id === (expectedLine.inventoryItemId ?? null) && Number(actual.quantity) === Number(expectedLine.quantity) && Number(actual.unit_price) === Number(expectedLine.unitPrice) && Number(actual.total) === Number(expectedLine.total), `${entry.scenario} bill line ${expectedLine.id} matches canonical values.`);
      }
      const actualPayments = payments.filter((row) => row.bill_id === entry.candidateBillId);
      check(sameIds(actualPayments.map((row) => row.id), expected.paymentIds), `${entry.scenario} exact payment IDs match.`);
      const expectedPayment = expected.payments?.[0];
      check(actualPayments.length === 1 && Number(actualPayments[0].amount) === Number(expected.bill.total) && actualPayments[0].mode === expectedPayment?.mode && actualPayments[0].received_by_user_id === entry.actors.checkout, `${entry.scenario} payment amount, mode, and actor match.`);
      const checkoutAudits = audits.filter((row) => expected.auditIds.includes(row.id));
      check(sameIds(checkoutAudits.map((row) => row.id), expected.auditIds) && checkoutAudits.every((row) => row.user_id === entry.actors.checkout), `${entry.scenario} checkout audits and actors match.`);
      for (const expectedAudit of expected.audits ?? []) {
        const actual = checkoutAudits.find((row) => row.id === expectedAudit.id);
        check(Boolean(actual) && actual.action === expectedAudit.action && actual.entity_id === expectedAudit.entityId && actual.user_id === entry.actors.checkout, `${entry.scenario} checkout audit ${expectedAudit.id} matches.`);
      }
      const checkoutMovements = movements.filter((row) => expected.stockMovementIds.includes(row.id));
      check(sameIds(checkoutMovements.map((row) => row.id), expected.stockMovementIds) && checkoutMovements.every((row) => row.type === "sale" && Number(row.quantity) < 0 && row.user_id === entry.actors.checkout && row.related_bill_id === entry.candidateBillId), `${entry.scenario} checkout sale movements and actors match.`);
      for (const expectedMovement of expected.stockMovements ?? []) {
        const actual = checkoutMovements.find((row) => row.id === expectedMovement.id);
        check(Boolean(actual) && actual.item_id === expectedMovement.itemId && Number(actual.quantity) === Number(expectedMovement.quantity), `${entry.scenario} checkout movement ${expectedMovement.id} matches.`);
      }
      check(checkoutEvent.length === 1 && checkoutEvent[0].id === status?.event_id && checkoutEvent[0].event_type === "financial_checkout_committed_v2" && checkoutEvent[0].entity_id === entry.sessionId && checkoutEvent[0].created_by === entry.actors.checkout && comboEvent.length === 0, `${entry.scenario} canonical checkout event and losing combo event match.`);
      check(repeatedCombos.length === 0 && repeatedItems.length === 0 && repeatedAudits.length === 0 && repeatedMovements.length === 0, `${entry.scenario} retained no losing combo residue.`);
      check(!entry.cleanup, `${entry.scenario} performed no rejection cleanup after checkout.`);
      compatibility = entry.afterRace.appState;
    } else {
      check(session?.status === "closed" && session?.close_disposition === "rejected" && session?.closed_bill_id === null, `${entry.scenario} combo-winner session is terminal rejected.`);
      const losingLines = billLines.filter((row) => row.bill_id === entry.candidateBillId);
      const losingPayments = payments.filter((row) => row.bill_id === entry.candidateBillId);
      const losingAudits = audits.filter((row) => expected.auditIds.includes(row.id));
      const losingMovements = movements.filter((row) => expected.stockMovementIds.includes(row.id));
      check(exactBills.length === 0 && !bill && status === null && checkoutEvent.length === 0 && losingLines.length === 0 && losingPayments.length === 0 && losingAudits.length === 0 && losingMovements.length === 0, `${entry.scenario} retained no losing checkout bill, lines, payments, audits, movements, mutation, or event.`);
      const comboCanonical = entry.responses?.combo?.body;
      check(comboEvent.length === 1 && comboEvent[0].id === comboCanonical?.event_id && comboEvent[0].event_type === "repeat_session_combo" && comboEvent[0].entity_id === entry.sessionId && comboEvent[0].created_by === entry.actors.combo, `${entry.scenario} canonical repeat event and actor match.`);
      check(sameIds(changedIds(comboCanonical, "sessions"), [entry.sessionId]) && sameIds(changedIds(comboCanonical, "session_combo_applications"), [entry.repeatedComboApplicationId]) && sameIds(changedIds(comboCanonical, "session_items"), entry.repeatedItemIds) && sameIds(changedIds(comboCanonical, "stock_movements"), entry.repeatedStockMovementIds) && sameIds(changedIds(comboCanonical, "audit_logs"), [entry.repeatedAuditId]) && sameIds(changedIds(comboCanonical, "operational_events"), [comboCanonical?.event_id]), `${entry.scenario} canonical repeat changed_rows match every persisted collection.`);
      check(repeatedCombos.length === 1 && repeatedCombos[0].combo_id === preflight.fixture.combo.id, `${entry.scenario} repeat combo application matches fixture.`);
      check(sameIds(repeatedItems.map((row) => row.id), entry.repeatedItemIds), `${entry.scenario} repeated item IDs match.`);
      check(repeatedAudits.length === 1 && repeatedAudits[0].action === "combo_repeated" && repeatedAudits[0].user_id === entry.actors.combo, `${entry.scenario} repeat audit and actor match.`);
      check(sameIds(repeatedMovements.map((row) => row.id), entry.repeatedStockMovementIds) && repeatedMovements.every((row) => row.type === "session_reservation" && Number(row.quantity) < 0 && row.user_id === entry.actors.combo && row.related_bill_id === null), `${entry.scenario} repeat reservation movements and actors match.`);
      for (const expectedMovement of entry.afterRace.repeatedMovements ?? []) {
        const actual = repeatedMovements.find((row) => row.id === expectedMovement.id);
        check(Boolean(actual) && actual.item_id === expectedMovement.item_id && Number(actual.quantity) === Number(expectedMovement.quantity), `${entry.scenario} repeat movement ${expectedMovement.id} matches.`);
      }

      const cleanup = entry.cleanup;
      const cleanupEvents = events.filter((row) => row.metadata?.mutation_id === cleanup?.result?.mutationId);
      const cleanupAudits = audits.filter((row) => changedIds(cleanup?.result, "audit_logs").includes(row.id));
      const cleanupMovements = movements.filter((row) => changedIds(cleanup?.result, "stock_movements").includes(row.id));
      check(Boolean(cleanup) && cleanupEvents.length === 1 && cleanupEvents[0].id === cleanup.result.eventId && cleanupEvents[0].created_by === entry.actors.checkout, `${entry.scenario} cleanup event and actor match.`);
      check(cleanupAudits.length === 1 && cleanupAudits[0].action === "session_rejected" && cleanupAudits[0].entity_id === entry.sessionId && cleanupAudits[0].user_id === entry.actors.checkout, `${entry.scenario} cleanup audit and actor match.`);
      check(changedIds(cleanup?.result, "stock_movements").length === 0 && cleanupMovements.length === 0, `${entry.scenario} cleanup creates no compensating stock movements under reject_session.`);
      check(entry.cleanup?.availabilityReleasedByClosedSession === true, `${entry.scenario} records that terminal session state releases reservation availability.`);
      check(entry.appStateAfterCleanup?.version === entry.appStateBefore.version + 1, `${entry.scenario} cleanup advances compatibility state exactly once.`);
      compatibility = entry.appStateAfterCleanup ?? compatibility;
    }
  }

  check(openSessions.length === 0 && openTabs.length === 0, "The staging floor is empty after execution or interruption.");
  check(appStateResult.data.version === compatibility.version && hash(appStateResult.data.data) === compatibility.hash, "Final app_state matches the chained expected compatibility state.");

  const winningBillIds = runBills.filter((entry) => entry.status === "issued").map((entry) => entry.id);
  const saleMovements = winningBillIds.length === 0 ? [] : requireData(
    await supabase.from("stock_movements").select("id,item_id,type,quantity,related_bill_id,user_id").eq("organization_id", organizationId).in("related_bill_id", winningBillIds).eq("type", "sale"),
    "sale movements"
  );
  for (const fixture of preflight.fixture.stockEvidence) {
    const expectedDelta = saleMovements.filter((movement) => movement.item_id === fixture.itemId).reduce((sum, movement) => sum + Number(movement.quantity), 0);
    const current = inventory.find((item) => item.id === fixture.itemId);
    check(Boolean(current) && Number(current.stock_qty) === Number(fixture.stockQty) + expectedDelta, `Final stock arithmetic matches for ${fixture.itemId}.`);
  }

  report.terminal = {
    runSessions, runBills, sessions, bills, billLines, payments, events, audits, movements, saleMovements, inventory,
    checkoutStatuses, openSessions, openTabs,
    appState: { version: appStateResult.data.version, hash: hash(appStateResult.data.data) }
  };
  report.passed = failures.length === 0;
} catch (error) {
  report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  failures.push(report.error);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
if (!report.passed) {
  console.error(JSON.stringify({ status: "blocked", artifact: path.relative(root, outputPath), report }, null, 2));
  process.exitCode = 2;
} else {
  console.log(JSON.stringify({ status: "passed", artifact: path.relative(root, outputPath), report }, null, 2));
}
