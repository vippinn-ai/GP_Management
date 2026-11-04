import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  canonicalHash,
  patchArrayById,
  planPhase,
  prepareSessionReject,
  reconcilePhase,
  reconcileRun,
  sealSessionReject,
  sealPhaseIntent,
  finalizePhaseIntent,
  verifyPairIdentities,
  verifySamples
} from "./u1-data-reconciler.mjs";
import { reconcileEvidence } from "./reconcile-u1-evidence.mjs";

const ACTOR = "61cc0000-0000-4000-8000-000000000001";
const SERVER_TIME = "2026-10-24T09:00:00.123456Z";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function initialRow() {
  return {
    id: "primary",
    version: 40,
    updated_at: "2026-10-24T08:59:00.000000Z",
    updated_by: "previous-actor",
    data: {
      sessions: [
        { id: "session-a", status: "active", endedAt: null, closeDisposition: null },
        { id: "session-b", status: "active", endedAt: null, closeDisposition: null }
      ],
      sessionPauseLogs: [],
      customerTabs: [{ id: "tab-a", status: "open" }],
      auditLogs: [{ id: "audit-old", action: "session_started" }],
      protectedOrder: ["one", "two"]
    }
  };
}

function committedRejectPlan(before = initialRow(), overrides = {}) {
  return planPhase({
    operation: "reject_session",
    outcome: "committed",
    before,
    patches: {
      sessions: [{ id: "session-a", status: "closed", endedAt: SERVER_TIME, closeDisposition: "rejected" }],
      auditLogs: [{ id: "audit-reject-a", action: "session_rejected", userId: ACTOR, createdAt: SERVER_TIME }]
    },
    actor: ACTOR,
    serverTime: SERVER_TIME,
    ...overrides
  });
}

function expectedCommittedReject(before = initialRow()) {
  const after = clone(before);
  after.version += 1;
  after.updated_at = SERVER_TIME;
  after.updated_by = ACTOR;
  after.data.sessions = patchArrayById(after.data.sessions, [
    { id: "session-a", status: "closed", endedAt: SERVER_TIME, closeDisposition: "rejected" }
  ]);
  after.data.auditLogs = patchArrayById(after.data.auditLogs, [
    { id: "audit-reject-a", action: "session_rejected", userId: ACTOR, createdAt: SERVER_TIME }
  ]);
  return after;
}

function samples() {
  return Array.from({ length: 50 }, (_, index) => ({
    index,
    aId: `u1-${index}-a`,
    bId: `u1-${index}-b`,
    elapsedMs: 1_000 + index
  }));
}

function sessionRejectFixture() {
  const before = initialRow();
  before.data.sessions[0] = {
    id: "session-a",
    customerName: "QA U1 A",
    stationId: "station-a",
    status: "active",
    startedAt: "2026-10-24T08:30:00.000000Z",
    endedAt: null,
    closeDisposition: null,
    closeReason: null,
    continuedFromSessionIds: [],
    closedBillId: null,
    custom: { retained: true }
  };
  const session = {
    ...clone(before.data.sessions[0]),
    status: "closed",
    endedAt: "2026-10-24T09:00:00.000000Z",
    closeDisposition: "rejected",
    closeReason: "U1 exact cleanup"
  };
  const auditLog = {
    id: "audit-u1-session-a",
    action: "session_rejected",
    entityType: "session",
    entityId: "session-a",
    userId: ACTOR,
    createdAt: "2026-10-24T09:00:00.000000Z",
    message: "client draft is not authoritative"
  };
  const command = {
    organization_id: "org-primary",
    mutation_id: "u1-cleanup-session-a",
    mutation_kind: "rejectSession",
    user_id: ACTOR,
    base_app_state_version: before.version,
    payload: { session, auditLog }
  };
  const normalizedSession = {
    id: "session-a",
    organization_id: "org-primary",
    status: "active",
    closed_bill_id: null,
    close_disposition: null,
    continued_from_session_ids: [],
    station_name_snapshot: "8 Ball Pool",
    raw_data: clone(before.data.sessions[0])
  };
  return { before, command, normalizedSession, actor: ACTOR, ownedIds: ["session-a"], serverTime: SERVER_TIME };
}

function evidenceFixture() {
  const initial = initialRow();
  initial.data.sessions = samples().flatMap(({ index, aId, bId }) => [
    { id: aId, status: "active", endedAt: null, closeDisposition: null },
    { id: bId, status: "active", endedAt: null, closeDisposition: null }
  ]);
  const pairs = samples().map(({ index, aId, bId }) => ({
    index, aId, bId, intentHash: canonicalHash({ index, entityId: bId, operation: "save_live_session_details" })
  }));
  const phases = [];
  const actualPhases = [];
  let current = clone(initial);
  const roles = ["start-a", "start-b", "save-b", "reject-a", "reject-b"];
  const operations = ["start_session", "start_session", "save_live_session_details", "reject_session", "reject_session"];
  for (const pair of pairs) {
    for (let offset = 0; offset < 5; offset += 1) {
      const role = roles[offset];
      const operation = operations[offset];
      const entityId = offset === 0 || offset === 3 ? pair.aId : pair.bId;
      const actorId = `actor-${role}`;
      const mutationId = `mutation-${pair.index}-${role}`;
      const auditId = `audit-${pair.index}-${role}`;
      const serverTime = new Date(Date.parse(SERVER_TIME) + phases.length * 1000).toISOString();
      const patches = offset >= 3 ? {
        sessions: [{ id: entityId, status: "closed", endedAt: serverTime, closeDisposition: "rejected" }],
        auditLogs: [{ id: auditId, action: "session_rejected", userId: actorId, createdAt: serverTime }]
      } : {};
      const planInput = offset >= 3
        ? { operation, outcome: "committed", patches, actor: actorId,
            earliestServerTime: serverTime,
            latestServerTime: new Date(Date.parse(serverTime) + 15_000).toISOString() }
        : { operation, outcome: "committed", patches, actor: actorId, serverTime };
      const plan = offset >= 3
        ? finalizePhaseIntent(sealPhaseIntent({ ...planInput, before: clone(current) }), {
            responseTime: serverTime, databaseTime: serverTime
          })
        : planPhase({ ...planInput, before: clone(current) });
      const protectedRows = { pairIndex: pair.index, role, entityId, marker: `protected-${pair.index}-${role}` };
      const uiParity = role === "save-b" ? {
        origin: { entityId: pair.aId, state: "visible" }, observer: { entityId: pair.bId, state: "saved" }
      } : undefined;
      const metadata = { id: `phase-${pair.index}-${role}`, pairIndex: pair.index, role, entityId,
        actorId, mutationId, auditId };
      phases.push({ ...metadata, plan: planInput, protectedRows: clone(protectedRows), ...(uiParity ? { uiParity } : {}) });
      actualPhases.push({ ...metadata, appState: clone(plan.expected), protectedRows: clone(protectedRows),
        ...(offset >= 3 ? { responseTime: serverTime, databaseTime: serverTime } : {}),
        ...(uiParity ? { uiParity: clone(uiParity), pendingQueues: { origin: [], observer: [] } } : {}) });
      current = clone(plan.expected);
    }
  }
  const finalProtectedRows = { sessions: current.data.sessions, audits: current.data.auditLogs };
  const expected = {
    schema: "u1-expectations-v1",
    project: "tkbdyzxwwbhkpztgjjxh",
    organization: "org-primary",
    runId: "u1-evidence-test-001",
    initial: clone(initial),
    pairs,
    phases,
    finalProtectedRows: clone(finalProtectedRows)
  };
  const actual = {
    schema: "u1-observations-v1",
    project: expected.project,
    organization: expected.organization,
    runId: expected.runId,
    status: "completed-unverified",
    attempt: 1,
    retry: 0,
    phases: actualPhases,
    samples: samples().map(sample => {
      const measured = actualPhases[sample.index * 5 + 2];
      return { ...sample, outcome: "completed", pendingQueuesEmpty: true,
        acknowledged: true, errorPriorityViolation: false,
        mutationId: measured.mutationId, entityId: measured.entityId, actorId: measured.actorId,
        intentHash: pairs[sample.index].intentHash, parityHash: canonicalHash(measured.uiParity) };
    }),
    final: clone(current),
    finalProtectedRows: clone(finalProtectedRows)
  };
  return { expected, actual };
}

test("canonicalHash is key-order stable but remains array-order and value sensitive", () => {
  assert.equal(canonicalHash({ b: 2, a: { d: 4, c: 3 } }), canonicalHash({ a: { c: 3, d: 4 }, b: 2 }));
  assert.notEqual(canonicalHash({ ids: ["a", "b"] }), canonicalHash({ ids: ["b", "a"] }));
  assert.notEqual(canonicalHash({ version: 40 }), canonicalHash({ version: 41 }));
});

test("patchArrayById replaces in place, appends new IDs, and rejects ambiguous patches", () => {
  assert.deepEqual(
    patchArrayById([{ id: "a", value: 1 }, { id: "b", value: 2 }], [{ id: "a", value: 3 }, { id: "c", value: 4 }]),
    // The installed compatibility helper prepends missing patch IDs and then
    // retains the original order for replaced/existing rows.
    [{ id: "c", value: 4 }, { id: "a", value: 3 }, { id: "b", value: 2 }]
  );
  for (const patches of [
    [{ value: 2 }],
    [{ id: "a" }, { id: "a" }],
    [{ id: "", value: 2 }]
  ]) assert.throws(() => patchArrayById([{ id: "a", value: 1 }], patches));
  assert.throws(() => patchArrayById([{ id: "a" }, { id: "a" }], [{ id: "a" }]));
});

test("normalized-only committed phases require the complete app_state row to remain invariant", () => {
  const before = initialRow();
  const plan = planPhase({
    operation: "save_live_session_details",
    outcome: "committed",
    before,
    patches: {},
    actor: ACTOR,
    serverTime: SERVER_TIME
  });
  assert.doesNotThrow(() => reconcilePhase(plan, clone(before)));
  for (const mutate of [
    (row) => { row.version += 1; },
    (row) => { row.updated_at = SERVER_TIME; },
    (row) => { row.updated_by = ACTOR; },
    (row) => { row.data.sessions[0].status = "closed"; },
    (row) => { row.data.protectedOrder.reverse(); }
  ]) {
    const after = clone(before);
    mutate(after);
    assert.throws(() => reconcilePhase(plan, after));
  }
});

test("committed compatibility phase derives one exact patch and one version increment from before-images", () => {
  const before = initialRow();
  const plan = committedRejectPlan(before);
  assert.doesNotThrow(() => reconcilePhase(plan, expectedCommittedReject(before)));

  const wrong = [
    (row) => { row.version = before.version; },
    (row) => { row.version = before.version + 2; },
    (row) => { row.updated_by = "wrong-actor"; },
    (row) => { row.updated_at = "2026-10-24T09:00:01.000000Z"; },
    (row) => { row.data.sessions.push({ id: "unexpected", status: "closed" }); },
    (row) => { row.data.sessions = row.data.sessions.filter((entry) => entry.id !== "session-b"); },
    (row) => { row.data.sessions.reverse(); },
    (row) => { row.data.protectedOrder.reverse(); },
    (row) => { row.data.auditLogs.push({ id: "extra-audit" }); }
  ];
  for (const mutate of wrong) {
    const after = expectedCommittedReject(before);
    mutate(after);
    assert.throws(() => reconcilePhase(plan, after));
  }
});

test("compatibility operation whitelists reject unapproved arrays and invalid patch identities", () => {
  const before = initialRow();
  assert.throws(() => committedRejectPlan(before, { patches: { customerTabs: [{ id: "tab-a", status: "rejected" }] } }));
  // Missing-row insertion is an intentional compatibility-helper contract;
  // the protected-row reconciler must separately prove that the prepared ID
  // is the exact expected target rather than treating every insertion as bad.
  assert.doesNotThrow(() => committedRejectPlan(before, { patches: { sessions: [{ id: "prepared-new-session" }] } }));
  assert.throws(() => committedRejectPlan(before, {
    patches: { sessions: [{ id: "session-a" }, { id: "session-a" }] }
  }));
});

test("replayed and rejected phases are invariant and cannot smuggle patches or increments", () => {
  const before = initialRow();
  for (const outcome of ["replayed", "rejected"]) {
    const plan = planPhase({ operation: "reject_session", outcome, before, patches: {}, actor: ACTOR, serverTime: SERVER_TIME });
    assert.doesNotThrow(() => reconcilePhase(plan, clone(before)));
    const incremented = clone(before);
    incremented.version += 1;
    assert.throws(() => reconcilePhase(plan, incremented));
    assert.throws(() => planPhase({
      operation: "reject_session",
      outcome,
      before,
      patches: { sessions: [{ id: "session-a", status: "closed" }] },
      actor: ACTOR,
      serverTime: SERVER_TIME
    }));
  }
});

test("plans require prebound actors, finite server instants, complete rows, and known operations/outcomes", () => {
  const base = { operation: "reject_session", outcome: "committed", before: initialRow(), patches: {}, actor: ACTOR, serverTime: SERVER_TIME };
  for (const mutate of [
    (value) => { value.actor = ""; },
    (value) => { value.serverTime = "not-a-time"; },
    (value) => { delete value.serverTime; },
    (value) => { delete value.before.data; },
    (value) => { delete value.before.version; },
    (value) => { value.operation = "generic_state_save"; },
    (value) => { value.outcome = "ambiguous"; }
  ]) {
    const input = clone(base);
    mutate(input);
    assert.throws(() => planPhase(input));
  }

  // Actor and server time are evidence bindings for every submitted outcome,
  // not only for a compatibility commit.  A rejected or normalized-only
  // phase must not be admitted with those identities filled retrospectively.
  for (const phase of [
    { operation: "save_live_session_details", outcome: "committed" },
    { operation: "reject_session", outcome: "replayed" },
    { operation: "reject_session", outcome: "rejected" }
  ]) {
    for (const missing of ["actor", "serverTime"]) {
      const input = { ...phase, before: initialRow(), patches: {}, actor: ACTOR, serverTime: SERVER_TIME };
      delete input[missing];
      assert.throws(() => planPhase(input));
    }
  }
});

test("run reconciliation folds committed C phases in order without restoring history", () => {
  const initial = initialRow();
  const firstPlan = committedRejectPlan(initial);
  const firstAfter = expectedCommittedReject(initial);
  const secondPlan = planPhase({
    operation: "reject_session",
    outcome: "committed",
    before: firstAfter,
    patches: {
      sessions: [{ id: "session-b", status: "closed", endedAt: "2026-10-24T09:01:00.123456Z", closeDisposition: "rejected" }],
      auditLogs: [{ id: "audit-reject-b", action: "session_rejected", userId: ACTOR, createdAt: "2026-10-24T09:01:00.123456Z" }]
    },
    actor: ACTOR,
    serverTime: "2026-10-24T09:01:00.123456Z"
  });
  const final = clone(firstAfter);
  final.version += 1;
  final.updated_at = "2026-10-24T09:01:00.123456Z";
  final.data.sessions = patchArrayById(final.data.sessions, [
    { id: "session-b", status: "closed", endedAt: final.updated_at, closeDisposition: "rejected" }
  ]);
  final.data.auditLogs = patchArrayById(final.data.auditLogs, [
    { id: "audit-reject-b", action: "session_rejected", userId: ACTOR, createdAt: final.updated_at }
  ]);
  assert.doesNotThrow(() => reconcileRun(initial, [
    { plan: firstPlan, after: firstAfter },
    { plan: secondPlan, after: final }
  ], final));

  assert.throws(() => reconcileRun(initial, [
    { plan: secondPlan, after: final },
    { plan: firstPlan, after: firstAfter }
  ], final));
  assert.throws(() => reconcileRun(initial, [{ plan: firstPlan, after: firstAfter }], initial));
});

test("verifySamples accepts exactly the 50 ordered unique pairs under the strict limit", () => {
  assert.doesNotThrow(() => verifySamples(samples()));
  for (const mutate of [
    (rows) => { rows.pop(); },
    (rows) => { rows.push({ ...rows[49], index: 50, aId: "extra-a", bId: "extra-b", elapsedMs: 1 }); },
    (rows) => { rows[10].index = 11; },
    (rows) => { rows[10].aId = rows[9].aId; },
    (rows) => { rows[10].bId = rows[9].bId; },
    (rows) => { rows[10].bId = rows[10].aId; },
    (rows) => { rows[10].elapsedMs = 7_000; },
    (rows) => { rows[10].elapsedMs = Number.NaN; },
  ]) {
    const rows = samples();
    mutate(rows);
    assert.throws(() => verifySamples(rows));
  }
});

test("approved pair identities reject unique substitutions as well as omission and reordering", () => {
  const expected = samples().map(({ index, aId, bId }) => ({ index, aId, bId }));
  assert.equal(verifyPairIdentities(expected, expected), true);
  for (const mutate of [
    (rows) => { rows[10].aId = "replacement-a"; },
    (rows) => { rows[10].bId = "replacement-b"; },
    (rows) => { rows.splice(10, 1); },
    (rows) => { [rows[10], rows[11]] = [rows[11], rows[10]]; },
    (rows) => { rows[10].index = 11; }
  ]) {
    const actual = clone(expected);
    mutate(actual);
    assert.throws(() => verifyPairIdentities(actual, expected));
  }
});

test("prepareSessionReject builds the exact server-canonical active-session C patch from pre-submit evidence", () => {
  const input = sessionRejectFixture();
  const plan = prepareSessionReject(input);
  assert.equal(plan.operation, "reject_session");
  assert.equal(plan.compatibilityCommit, true);
  assert.equal(plan.expected.version, input.before.version + 1);
  assert.equal(plan.expected.updated_by, ACTOR);
  assert.equal(plan.expected.updated_at, SERVER_TIME);
  const session = plan.expected.data.sessions.find((entry) => entry.id === "session-a");
  assert.deepEqual(session.custom, { retained: true });
  assert.deepEqual(session.continuedFromSessionIds, []);
  assert.equal(session.closedBillId, null);
  const audit = plan.expected.data.auditLogs.find((entry) => entry.id === "audit-u1-session-a");
  assert.equal(audit.message, "Rejected 8 Ball Pool. Reason: U1 exact cleanup");
  assert.doesNotThrow(() => reconcilePhase(plan, clone(plan.expected)));
});

test("prepareSessionReject refuses stale, unowned, non-active, billed, paused, and unrelated-row cleanup", () => {
  const mutations = [
    (value) => { value.command.organization_id = "other"; },
    (value) => { value.command.user_id = "wrong-actor"; },
    (value) => { value.command.mutation_kind = "rejectSessionV2"; },
    (value) => { value.command.mutation_id = ""; },
    (value) => { value.command.base_app_state_version += 1; },
    (value) => { value.ownedIds = ["some-other-session"]; },
    (value) => { value.normalizedSession.organization_id = "other"; },
    (value) => { value.normalizedSession.status = "closed"; },
    (value) => { value.normalizedSession.status = "paused"; },
    (value) => { value.normalizedSession.closed_bill_id = "bill-1"; },
    (value) => { value.normalizedSession.close_disposition = "billed"; },
    (value) => { value.command.payload.pauseLog = { id: "pause-1" }; },
    (value) => { value.command.payload.session.status = "active"; },
    (value) => { value.command.payload.session.closeDisposition = "billed"; },
    (value) => { value.command.payload.session.customerName = "substituted"; },
    (value) => { value.command.payload.session.custom.retained = false; },
    (value) => { value.command.payload.auditLog.id = ""; },
    (value) => { value.command.payload.auditLog.entityId = "other"; },
    (value) => { value.command.payload.auditLog.userId = "wrong-actor"; },
    (value) => { value.command.payload.auditLog.action = "other"; },
    (value) => { value.command.payload.session.endedAt = "not-a-time"; },
    (value) => { value.command.extra = true; },
    (value) => { value.command.payload.extra = true; },
    (value) => { value.ownedIds.push("session-a"); },
    (value) => { value.command.payload.auditLog.createdAt = "2026-10-24T09:00:01.000000Z"; },
    (value) => { value.command.payload.session.endedAt = "2026-10-24T08:29:59.000000Z"; value.command.payload.auditLog.createdAt = value.command.payload.session.endedAt; },
    (value) => { value.command.payload.session.endedAt = "2026-10-24T09:00:01.000000Z"; value.command.payload.auditLog.createdAt = value.command.payload.session.endedAt; },
    (value) => { value.normalizedSession.continued_from_session_ids = ["prior"]; },
    (value) => { delete value.normalizedSession.raw_data; }
  ];
  for (const mutate of mutations) {
    const input = sessionRejectFixture();
    mutate(input);
    assert.throws(() => prepareSessionReject(input));
  }
});

test("prepareSessionReject rejects blank reason and derives the continuation suffix without trusting the client message", () => {
  const input = sessionRejectFixture();
  input.command.payload.session.closeReason = "  ";
  assert.throws(() => prepareSessionReject(input));
  input.command.payload.session.closeReason = "U1 exact cleanup";
  input.normalizedSession.continued_from_session_ids = ["prior-a", "prior-b"];
  input.normalizedSession.raw_data.continuedFromSessionIds = ["prior-a", "prior-b"];
  input.command.payload.session.continuedFromSessionIds = ["prior-a", "prior-b"];
  const plan = prepareSessionReject(input);
  const audit = plan.expected.data.auditLogs.find((entry) => entry.id === "audit-u1-session-a");
  assert.equal(audit.message, "Rejected 8 Ball Pool. Reason: U1 exact cleanup Released 2 prior game continuations.");
  assert.deepEqual(plan.expected.data.sessions.find((entry) => entry.id === "session-a").continuedFromSessionIds, []);
});

test("sealed phase intents admit only the response/DB timestamp in the prebound 15-second slot", () => {
  const before = initialRow();
  const patches = {
    sessions: [{ id: "session-a", status: "closed", endedAt: SERVER_TIME, closeDisposition: "rejected" }],
    auditLogs: [{ id: "audit-reject-a", action: "session_rejected", userId: ACTOR, createdAt: SERVER_TIME }]
  };
  const intent = sealPhaseIntent({
    operation: "reject_session", outcome: "committed", before, patches, actor: ACTOR,
    earliestServerTime: "2026-10-24T09:00:00.000Z", latestServerTime: "2026-10-24T09:00:15.000Z"
  });
  const plan = finalizePhaseIntent(intent, { responseTime: SERVER_TIME, databaseTime: SERVER_TIME });
  assert.equal(plan.expected.updated_at, SERVER_TIME);
  assert.deepEqual(plan.expected.data.sessions.find(row => row.id === "session-a"), patches.sessions[0]);
  assert.throws(() => finalizePhaseIntent(intent, { responseTime: SERVER_TIME, databaseTime: SERVER_TIME }));

  for (const result of [
    { responseTime: "2026-10-24T09:00:01.000Z", databaseTime: SERVER_TIME },
    { responseTime: "2026-10-24T08:59:59.999Z", databaseTime: "2026-10-24T08:59:59.999Z" },
    { responseTime: "2026-10-24T09:00:15.001Z", databaseTime: "2026-10-24T09:00:15.001Z" },
    { responseTime: "bad", databaseTime: "bad" }
  ]) assert.throws(() => finalizePhaseIntent(intent, result));

  assert.throws(() => sealPhaseIntent({
    operation: "reject_session", outcome: "committed", before, patches, actor: ACTOR,
    earliestServerTime: "2026-10-24T09:00:00.000Z", latestServerTime: "2026-10-24T09:00:15.001Z"
  }));
  assert.throws(() => finalizePhaseIntent({ ...intent }, { responseTime: SERVER_TIME, databaseTime: SERVER_TIME }));
});

test("sealSessionReject freezes the command-derived cleanup before response and permits exactly one bounded finalization", () => {
  const input = sessionRejectFixture();
  const sealed = sealSessionReject({ ...input,
    earliestServerTime: "2026-10-24T09:00:00.000Z",
    latestServerTime: "2026-10-24T09:00:15.000Z"
  });
  input.command.payload.session.custom.retained = false;
  input.command.payload.session.status = "active";
  input.command.payload.auditLog.message = "mutated client draft";
  const databaseTime = "2026-10-24T09:00:05.000Z";
  const plan = finalizePhaseIntent(sealed, { responseTime: databaseTime, databaseTime });
  const session = plan.expected.data.sessions.find(row => row.id === "session-a");
  const audit = plan.expected.data.auditLogs.find(row => row.id === "audit-u1-session-a");
  assert.equal(session.status, "closed");
  assert.deepEqual(session.custom, { retained: true });
  assert.equal(audit.message, "Rejected 8 Ball Pool. Reason: U1 exact cleanup");
  assert.equal(plan.expected.updated_at, databaseTime);
  assert.throws(() => finalizePhaseIntent(sealed, { responseTime: databaseTime, databaseTime }));
});

test("reconcileEvidence accepts only the exact sealed 50-pair identity, phase, protected rows, and final fold", () => {
  const { expected, actual } = evidenceFixture();
  const result = reconcileEvidence(expected, actual);
  assert.equal(result.status, "passed");
  assert.equal(result.samples.count, 50);
  assert.equal(result.ledger.phases, 250);
  assert.equal(result.ledger.compatibilityCommits, 100);
  assert.match(result.scope, /Offline supplied-evidence comparison only/);
});

test("reconcileEvidence rejects identity, retry, phase, protected-row, sample, and final-state tampering", () => {
  const mutations = [
    ({ expected }) => { expected.schema = "other"; },
    ({ actual }) => { actual.schema = "other"; },
    ({ actual }) => { actual.project = "production-project"; },
    ({ actual }) => { actual.organization = "other"; },
    ({ actual }) => { actual.runId = "other-run"; },
    ({ actual }) => { actual.status = "failed"; },
    ({ actual }) => { actual.attempt = 2; },
    ({ actual }) => { actual.retry = 1; },
    ({ actual }) => { actual.phases = []; },
    ({ actual }) => { actual.phases[0].id = "replacement-phase"; },
    ({ expected }) => { [expected.phases[0], expected.phases[1]] = [expected.phases[1], expected.phases[0]]; },
    ({ expected }) => { expected.phases[0].pairIndex = 1; },
    ({ expected }) => { expected.phases[0].role = "start-b"; },
    ({ expected }) => { expected.phases[0].entityId = expected.pairs[0].bId; },
    ({ expected }) => { expected.phases[0].actorId = "other-actor"; },
    ({ expected }) => { expected.phases[0].plan.before = clone(expected.initial); },
    ({ expected }) => { expected.phases[0].plan.unexpectedConstraint = true; },
    ({ expected }) => { expected.phases[3].plan.serverTime = SERVER_TIME; },
    ({ expected }) => { expected.phases[3].plan.unexpectedConstraint = true; },
    ({ expected }) => { expected.phases[1].mutationId = expected.phases[0].mutationId; },
    ({ expected }) => { expected.phases[1].auditId = expected.phases[0].auditId; },
    ({ expected }) => { expected.phases[3].plan.patches.sessions[0].id = "other-session"; },
    ({ expected }) => { expected.phases[3].plan.patches.auditLogs[0].id = "other-audit"; },
    ({ actual }) => { actual.phases[2].pairIndex = 4; },
    ({ actual }) => { actual.phases[2].role = "reject-a"; },
    ({ actual }) => { actual.phases[2].entityId = "other"; },
    ({ actual }) => { actual.phases[2].actorId = "other"; },
    ({ actual }) => { actual.phases[2].mutationId = "other"; },
    ({ actual }) => { actual.phases[2].auditId = "other"; },
    ({ actual }) => { actual.phases[3].responseTime = "2026-10-24T10:00:00.000Z"; },
    ({ actual }) => { actual.phases[3].responseTime = "2026-10-24T10:00:00.000Z"; actual.phases[3].databaseTime = "2026-10-24T10:00:00.000Z"; },
    ({ actual }) => { actual.phases[0].appState.version += 1; },
    ({ actual }) => { actual.phases[0].protectedRows.marker = "changed"; },
    ({ actual }) => { actual.samples.pop(); },
    ({ actual }) => { actual.samples[7].aId = "replacement-a"; },
    ({ actual }) => { [actual.samples[7], actual.samples[8]] = [actual.samples[8], actual.samples[7]]; },
    ({ actual }) => { actual.samples[7].elapsedMs = 7_000; },
    ({ actual }) => { actual.samples[7].outcome = "incomplete"; },
    ({ actual }) => { actual.samples[7].pendingQueuesEmpty = false; },
    ({ actual }) => { delete actual.samples[7].acknowledged; },
    ({ actual }) => { actual.samples[7].acknowledged = false; },
    ({ actual }) => { delete actual.samples[7].errorPriorityViolation; },
    ({ actual }) => { actual.samples[7].errorPriorityViolation = true; },
    ({ actual }) => { actual.samples[7].mutationId = "other"; },
    ({ actual }) => { actual.samples[7].entityId = "other"; },
    ({ actual }) => { actual.samples[7].actorId = "other"; },
    ({ actual }) => { actual.samples[7].intentHash = "0".repeat(64); },
    ({ actual }) => { actual.samples[7].parityHash = "0".repeat(64); },
    ({ actual }) => { actual.phases[7 * 5 + 2].pendingQueues.origin.push({ id: "queued" }); },
    ({ actual }) => { actual.phases[7 * 5 + 2].uiParity.observer.state = "stale"; },
    ({ actual }) => { actual.final.version += 1; },
    ({ actual }) => { actual.finalProtectedRows.audits.push({ id: "unexpected", action: "other" }); }
  ];
  for (const mutate of mutations) {
    const fixture = evidenceFixture();
    mutate(fixture);
    assert.throws(() => reconcileEvidence(fixture.expected, fixture.actual));
  }
});

test("reconcile-u1-evidence CLI binds expected bytes, writes once, and emits only sanitized failure evidence", () => {
  const tempRoot = path.resolve("test-artifacts", "tmp", `u1-reconcile-${process.pid}-${Date.now()}`);
  assert.ok(tempRoot.startsWith(path.resolve("test-artifacts", "tmp") + path.sep));
  fs.mkdirSync(tempRoot, { recursive: true });
  try {
    const cli = path.resolve("scripts", "reconcile-u1-evidence.mjs");
    const { expected, actual } = evidenceFixture();
    const expectedPath = path.join(tempRoot, "expected.json");
    const observedPath = path.join(tempRoot, "observed.json");
    const reportPath = path.join(tempRoot, "report.json");
    const expectedBytes = `${JSON.stringify(expected)}\n`;
    fs.writeFileSync(expectedPath, expectedBytes, { flag: "wx" });
    fs.writeFileSync(observedPath, `${JSON.stringify(actual)}\n`, { flag: "wx" });
    const expectedSha = createHash("sha256").update(expectedBytes).digest("hex");
    const run = (...args) => spawnSync(process.execPath, [cli, ...args, "--historical-offline"], {
      cwd: process.cwd(), encoding: "utf8", env: { ...process.env }
    });

    const passed = run(expectedPath, expectedSha, observedPath, reportPath);
    assert.equal(passed.status, 0, passed.stderr);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.status, "passed");
    assert.equal(report.expectedSha256, expectedSha);
    assert.equal(report.observedSha256, createHash("sha256").update(fs.readFileSync(observedPath)).digest("hex"));

    const overwrite = run(expectedPath, expectedSha, observedPath, reportPath);
    assert.equal(overwrite.status, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(reportPath, "utf8")), report);

    const wrongHashReport = path.join(tempRoot, "wrong-hash-report.json");
    const wrongHash = run(expectedPath, "0".repeat(64), observedPath, wrongHashReport);
    assert.equal(wrongHash.status, 1);
    assert.equal(fs.existsSync(wrongHashReport), false);

    const sensitive = "PRIVATE-SERVER-TEXT-MUST-NOT-PERSIST";
    fs.writeFileSync(observedPath, `{${sensitive}`, { flag: "w" });
    const failedReportPath = path.join(tempRoot, "failed-report.json");
    const failed = run(expectedPath, expectedSha, observedPath, failedReportPath);
    assert.equal(failed.status, 1);
    const failedBytes = fs.readFileSync(failedReportPath, "utf8");
    assert.doesNotMatch(failedBytes, new RegExp(sensitive));
    assert.equal(JSON.parse(failedBytes).status, "failed");

    const samePath = run(expectedPath, expectedSha, observedPath, observedPath);
    assert.equal(samePath.status, 1);
  } finally {
    const resolved = path.resolve(tempRoot);
    assert.ok(resolved.startsWith(path.resolve("test-artifacts", "tmp") + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

