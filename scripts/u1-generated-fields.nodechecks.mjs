import assert from "node:assert/strict";
import test from "node:test";
import { expectedStartEventMetadata } from './u1-installed-contract.mjs';

import {
  bindGeneratedPhase,
  canonicalProtectedRows,
  compareGeneratedProtected,
  materializeProtected,
  rpcTimestamp,
  timestampMicros
} from "./u1-generated-fields.mjs";

const EVENT_ID = "event-11111111-1111-4111-8111-111111111111";
const AUDIT_ACTIVITY_ID = "activity-22222222-2222-4222-8222-222222222222";
const EVENT_ACTIVITY_ID = "activity-33333333-3333-4333-8333-333333333333";
const ACTOR = "actor-admin-a";
const ENTITY = "session-u1-a";
const MUTATION = "mutation-u1-a";
const AUDIT = "audit-u1-a";
const RPC_TIME = "2026-10-25T08:00:00.123456";
const SERVER_TIME = `${RPC_TIME}Z`;

const clone = value => structuredClone(value);

function generatedFixture(operation = "save_live_session_details") {
  const contract = {
    id: "phase-0-save-b",
    operation,
    entityId: ENTITY,
    actorId: ACTOR,
    mutationId: MUTATION,
    auditId: AUDIT,
    ...(operation !== "reject_session" ? { customerId: "customer-u1-a", customerWrite: operation === "start_session" ? "insert" : "update" } : {}),
    earliestServerTime: "2026-10-25T08:00:00.000000+00:00",
    latestServerTime: "2026-10-25T08:00:15.000000+00:00"
  };
  const response = {
    organization_id: "org-primary",
    entity_type: "session",
    entity_id: ENTITY,
    mutation_id: MUTATION,
    event_id: EVENT_ID,
    server_time: RPC_TIME,
    changed_rows: {
      sessions: [ENTITY], audit_logs: [AUDIT], operational_events: [EVENT_ID],
      ...(operation === "start_session" ? { customers: ["customer-u1-a"], session_items: [], session_combo_applications: [], stock_movements: [] } : {}),
      ...(operation === "save_live_session_details" ? { customers: ["customer-u1-a"] } : {}),
      ...(operation === "reject_session" ? { session_pause_logs: [] } : {})
    },
    ...(operation === "reject_session" ? { app_state_version: 12, server_duration_ms: 12.5 } : {})
  };
  const command = { organization_id: 'org-primary', mutation_id: MUTATION, mutation_kind: 'startSession', user_id: ACTOR,
    payload: { session: { id: ENTITY, stationId: 'station-a', startedAt: SERVER_TIME, items: [], comboApplications: [], continuedFromSessionIds: [] },
      customer: { id: 'customer-u1-a', name: 'fixture-a' }, stockMovements: [], auditLogs: [{ id: AUDIT, userId: ACTOR }] } };
  const eventMetadata = operation === "start_session"
    ? expectedStartEventMetadata(command, EVENT_ID)
    : operation === "reject_session"
      ? { mutation_id: MUTATION, changed_rows: { sessions: [ENTITY], audit_logs: [AUDIT], session_pause_logs: [] },
        app_state_version: 12, released_continued_from_session_ids: [], server_duration_ms: 12.5 }
      : { mutation_id: MUTATION, audit_log_id: AUDIT, customer_id: "customer-u1-a" };
  const rows = {
    operational_events: [{
      id: EVENT_ID,
      organization_id: "org-primary",
      event_type: operation,
      entity_type: "session",
      entity_id: ENTITY,
      created_by: ACTOR,
      created_at: SERVER_TIME,
      metadata: eventMetadata
    }],
    audit_logs: [{
      id: AUDIT,
      organization_id: "org-primary",
      user_id: ACTOR,
      entity_type: "session",
      entity_id: ENTITY,
      audit_at: SERVER_TIME,
      created_at: SERVER_TIME,
      updated_at: SERVER_TIME,
      raw_data: { userId: ACTOR, createdAt: SERVER_TIME }
    }],
    activity_events: [{
      id: AUDIT_ACTIVITY_ID,
      organization_id: "org-primary",
      source_kind: "audit_log",
      source_id: AUDIT,
      actor_user_id: ACTOR,
      entity_type: "session",
      entity_id: ENTITY,
      legacy: false,
      occurred_at: SERVER_TIME,
      created_at: SERVER_TIME,
      mutation_id: null,
      details: { audit_id: AUDIT }
    }, {
      id: EVENT_ACTIVITY_ID,
      organization_id: "org-primary",
      source_kind: "operational_event",
      source_id: EVENT_ID,
      actor_user_id: ACTOR,
      entity_type: "session",
      entity_id: ENTITY,
      legacy: false,
      occurred_at: SERVER_TIME,
      created_at: SERVER_TIME,
      mutation_id: MUTATION,
      audit_reference_ids: [AUDIT],
      details: { event_id: EVENT_ID }
    }]
  };
  return { contract, response, rows, command };
}

test("timestampMicros preserves PostgreSQL microseconds and rejects malformed/nonfinite values", () => {
  assert.equal(timestampMicros("2026-10-25T08:00:00.123456Z") - timestampMicros("2026-10-25T08:00:00.123455Z"), 1n);
  assert.equal(timestampMicros("2026-10-25T13:30:00.123456+05:30"), timestampMicros("2026-10-25T08:00:00.123456Z"));
  assert.equal(timestampMicros("2026-10-25T08:00:00Z"), timestampMicros("2026-10-25T08:00:00.000000+00:00"));
  for (const value of [null, "", "2026-10-25", "2026-10-25T08:00:00", "not-a-time", "2026-13-25T08:00:00Z", "2026-02-30T08:00:00Z"])
    assert.throws(() => timestampMicros(value));
  assert.equal(rpcTimestamp(RPC_TIME), SERVER_TIME);
  assert.equal(rpcTimestamp("2026-10-25T13:30:00.123456+05:30"), "2026-10-25T13:30:00.123456+05:30");
  for (const value of [null, "", "2026-10-25", "not-a-time"])
    assert.throws(() => rpcTimestamp(value));
});

test("bindGeneratedPhase requires one exact event, audit, and two source-qualified Activity rows", () => {
  for (const operation of ["start_session", "save_live_session_details", "reject_session"]) {
    const input = generatedFixture(operation);
    assert.deepEqual(bindGeneratedPhase(input.contract, input.response, input.rows, input.command), {
      eventId: EVENT_ID,
      serverTime: SERVER_TIME,
      operation,
      customerWrite: operation === "start_session" ? "insert" : operation === "save_live_session_details" ? "update" : null,
      entityId: ENTITY,
      auditId: AUDIT,
      mutationId: MUTATION,
      customerId: operation !== "reject_session" ? "customer-u1-a" : null,
      ...(operation === "reject_session" ? { serverDurationMs: 12.5 } : {}),
      auditActivityId: AUDIT_ACTIVITY_ID,
      operationalActivityId: EVENT_ACTIVITY_ID
    });
  }
});

test("bindGeneratedPhase rejects contract, response, event, audit, and Activity correlation drift", () => {
  const mutations = [
    value => { value.contract.operation = "other"; },
    value => { value.contract.mutationId = ""; },
    value => { value.contract.latestServerTime = "2026-10-25T08:00:15.000001Z"; },
    value => { value.response.server_time = "2026-10-25T08:00:15.000001Z"; },
    value => { value.response.organization_id = "other"; },
    value => { value.response.entity_type = "customer_tab"; },
    value => { value.response.entity_id = "other"; },
    value => { value.response.mutation_id = "other"; },
    value => { value.response.idempotent = true; },
    value => { delete value.response.changed_rows; },
    value => { value.response.unexpected = true; },
    value => { value.response.changed_rows.sessions = ["other"]; },
    value => { value.response.event_id = "event-not-a-uuid"; },
    value => { value.rows.operational_events.push(clone(value.rows.operational_events[0])); },
    value => { value.rows.operational_events[0].id = "event-44444444-4444-4444-8444-444444444444"; },
    value => { value.rows.operational_events[0].event_type = "start_session"; },
    value => { value.rows.operational_events[0].entity_id = "other"; },
    value => { value.rows.operational_events[0].created_by = "other"; },
    value => { value.rows.operational_events[0].metadata.audit_log_id = "other"; },
    value => { value.rows.operational_events[0].metadata.customer_id = "other"; },
    value => { value.rows.operational_events[0].created_at = "2026-10-25T08:00:00.123455Z"; },
    value => { value.rows.audit_logs.push(clone(value.rows.audit_logs[0])); },
    value => { value.rows.audit_logs[0].user_id = "other"; },
    value => { value.rows.audit_logs[0].audit_at = "2026-10-25T08:00:00.123455Z"; },
    value => { value.rows.audit_logs[0].raw_data.createdAt = "2026-10-25T08:00:00.123455Z"; },
    value => { value.rows.activity_events[0].source_kind = "operational_event"; },
    value => { value.rows.activity_events[0].id = "activity-not-a-uuid"; },
    value => { value.rows.activity_events[0].legacy = true; },
    value => { value.rows.activity_events[0].actor_user_id = "other"; },
    value => { value.rows.activity_events[0].occurred_at = "2026-10-25T08:00:00.123455Z"; },
    value => { value.rows.activity_events[0].details.audit_id = "other"; },
    value => { value.rows.activity_events[0].mutation_id = MUTATION; },
    value => { value.rows.activity_events[1].id = AUDIT_ACTIVITY_ID; },
    value => { value.rows.activity_events[1].mutation_id = "other"; },
    value => { value.rows.activity_events[1].audit_reference_ids = []; },
    value => { value.rows.activity_events[1].details.event_id = "other"; }
  ];
  for (const [index, mutate] of mutations.entries()) {
    const input = generatedFixture();
    mutate(input);
    assert.throws(() => bindGeneratedPhase(input.contract, input.response, input.rows), `mutation ${index} must reject`);
  }
});

function protectedTemplate() {
  return {
    sessions: [{ id: ENTITY, updated_at: { $generated: "serverTime", phase: "save" } }],
    audit_logs: [{ id: AUDIT, created_at: { $generated: "serverTime", phase: "save" }, updated_at: { $generated: "serverTime", phase: "save" }, audit_at: { $generated: "serverTime", phase: "save" },
      raw_data: { createdAt: { $generated: "serverTime", phase: "save" } } }],
    operational_events: [{ id: { $generated: "eventId", phase: "save" }, created_at: { $generated: "serverTime", phase: "save" },
      metadata: { mutation_id: MUTATION } }],
    activity_events: [
      { id: { $generated: "auditActivityId", phase: "save" }, source_kind: "audit_log", source_id: AUDIT,
        created_at: { $generated: "serverTime", phase: "save" }, occurred_at: { $generated: "serverTime", phase: "save" } },
      { id: { $generated: "operationalActivityId", phase: "save" }, source_kind: "operational_event",
        source_id: { $generated: "eventId", phase: "save" },
        details: { event_id: { $generated: "eventId", phase: "save" } }, created_at: { $generated: "serverTime", phase: "save" }, occurred_at: { $generated: "serverTime", phase: "save" } }
    ]
  };
}

test("materializeProtected permits only reviewed generated fields and compare tolerates row order/timezone serialization", () => {
  const bindings = { save: bindGeneratedPhase(...Object.values(generatedFixture())) };
  const expected = materializeProtected(protectedTemplate(), bindings);
  const actual = clone(expected);
  actual.activity_events.reverse();
  for (const rows of Object.values(actual)) for (const row of rows) {
    for (const field of ["created_at", "updated_at", "audit_at", "occurred_at"])
      if (row[field] === SERVER_TIME) row[field] = "2026-10-25T13:30:00.123456+05:30";
  }
  actual.audit_logs[0].raw_data.createdAt = "2026-10-25T13:30:00.123456+05:30";
  assert.deepEqual(compareGeneratedProtected(protectedTemplate(), actual, bindings), canonicalProtectedRows(expected));
});

test("reject bindings include the exact generated server duration slot", () => {
  const input = generatedFixture("reject_session");
  const binding = bindGeneratedPhase(input.contract, input.response, input.rows);
  assert.equal(binding.serverDurationMs, 12.5);
  const template = { operational_events: [{ id: { $generated: "eventId", phase: "reject" },
    metadata: { mutation_id: MUTATION, server_duration_ms: { $generated: "serverDurationMs", phase: "reject" } } }] };
  assert.deepEqual(materializeProtected(template, { reject: binding }), {
    operational_events: [{ id: EVENT_ID, metadata: { mutation_id: MUTATION, server_duration_ms: 12.5 } }]
  });
  for (const mutate of [
    value => { delete value.response.server_duration_ms; },
    value => { value.response.server_duration_ms = -1; },
    value => { value.rows.operational_events[0].metadata.server_duration_ms = 13; },
    value => { delete value.response.app_state_version; },
    value => { value.response.app_state_version = 0; },
    value => { value.rows.operational_events[0].metadata.app_state_version = 11; },
    value => { value.rows.operational_events[0].metadata.released_continued_from_session_ids = ["other"]; },
    value => { value.rows.operational_events[0].metadata.changed_rows.session_pause_logs = ["other"]; }
  ]) {
    const candidate = generatedFixture("reject_session");
    mutate(candidate);
    assert.throws(() => bindGeneratedPhase(candidate.contract, candidate.response, candidate.rows, candidate.command));
  }

  for (const mutate of [
    value => { value.rows.operational_events[0].metadata.session_item_ids = ["other"]; },
    value => { value.rows.operational_events[0].metadata.stock_movement_ids = ["other"]; },
    value => { value.response.changed_rows.session_items = ["other"]; },
    value => { value.rows.operational_events[0].metadata.request_fingerprint = '0'.repeat(32); },
    value => { delete value.rows.operational_events[0].metadata.changed_rows; },
    value => { value.rows.operational_events[0].metadata.station_id = 'other'; },
    value => { value.rows.operational_events[0].metadata.mutation_kind = 'other'; },
    value => { value.rows.operational_events[0].metadata.extra = true; }
  ]) {
    const candidate = generatedFixture("start_session");
    mutate(candidate);
    assert.throws(() => bindGeneratedPhase(candidate.contract, candidate.response, candidate.rows, candidate.command));
  }
});

test("materialization keeps prior-phase generated identities bound to their owning phase", () => {
  const save = bindGeneratedPhase(...Object.values(generatedFixture()));
  const prior = Object.freeze({
    ...save,
    eventId: "event-55555555-5555-4555-8555-555555555555",
    entityId: "session-prior",
    auditId: "audit-prior",
    mutationId: "mutation-prior",
    auditActivityId: "activity-66666666-6666-4666-8666-666666666666",
    operationalActivityId: "activity-77777777-7777-4777-8777-777777777777"
  });
  const template = {
    sessions: [
      { id: prior.entityId, updated_at: { $generated: "serverTime", phase: "prior" } },
      { id: save.entityId, updated_at: { $generated: "serverTime", phase: "save" } }
    ],
    operational_events: [
      { id: { $generated: "eventId", phase: "prior" }, metadata: { mutation_id: prior.mutationId } },
      { id: { $generated: "eventId", phase: "save" }, metadata: { mutation_id: save.mutationId } }
    ]
  };
  const bindings = { prior, save };
  const materialized = materializeProtected(template, bindings);
  assert.equal(materialized.operational_events[0].id, prior.eventId);
  assert.equal(materialized.operational_events[1].id, save.eventId);

  const borrowed = clone(template);
  borrowed.operational_events[0].metadata.mutation_id = save.mutationId;
  assert.throws(() => materializeProtected(borrowed, bindings));
});

test("operation-specific timestamp slots distinguish start inserts, save updates, and reject writes", () => {
  const start = bindGeneratedPhase(...Object.values(generatedFixture("start_session")));
  const save = bindGeneratedPhase(...Object.values(generatedFixture("save_live_session_details")));
  const reject = bindGeneratedPhase(...Object.values(generatedFixture("reject_session")));
  assert.doesNotThrow(() => materializeProtected({
    sessions: [{ id: ENTITY, created_at: { $generated: "serverTime", phase: "start" }, updated_at: { $generated: "serverTime", phase: "start" } }],
    customers: [{ id: start.customerId, created_at: { $generated: "serverTime", phase: "start" }, updated_at: { $generated: "serverTime", phase: "start" } }]
  }, { start }));
  assert.doesNotThrow(() => materializeProtected({ sessions: [{ id: ENTITY, updated_at: { $generated: "serverTime", phase: "save" } }] }, { save }));
  assert.doesNotThrow(() => materializeProtected({ sessions: [{ id: ENTITY, updated_at: { $generated: "serverTime", phase: "reject" } }] }, { reject }));

  for (const [template, bindings] of [
    [{ sessions: [{ id: ENTITY, created_at: { $generated: "serverTime", phase: "save" } }] }, { save }],
    [{ sessions: [{ id: ENTITY, created_at: { $generated: "serverTime", phase: "reject" } }] }, { reject }],
    [{ customers: [{ id: start.customerId, created_at: { $generated: "serverTime", phase: "save" } }] }, { save: { ...save, customerId: start.customerId, customerWrite: "update" } }],
    [{ customers: [{ id: start.customerId, updated_at: { $generated: "serverTime", phase: "reject" } }] }, { reject: { ...reject, customerId: start.customerId, customerWrite: "update" } }]
  ]) assert.throws(() => materializeProtected(template, bindings));
});

test("generated templates and protected comparisons reject unbound, misplaced, ambiguous, or changed rows", () => {
  const bindings = { save: bindGeneratedPhase(...Object.values(generatedFixture())) };
  for (const template of [
    { sessions: [{ id: { $generated: "eventId", phase: "save" } }] },
    { operational_events: [{ id: { $generated: "serverTime", phase: "save" } }] },
    { operational_events: [{ id: { $generated: "eventId", phase: "missing" } }] },
    { operational_events: [{ id: { $generated: "eventId", phase: "save", extra: true } }] },
    { operational_events: [{ metadata: { mutation_id: { $generated: "eventId", phase: "save" } } }] }
  ]) assert.throws(() => materializeProtected(template, bindings));

  const template = protectedTemplate();
  const actual = materializeProtected(template, bindings);
  const changed = clone(actual);
  changed.sessions[0].business_field = "unexpected";
  assert.throws(() => compareGeneratedProtected(template, changed, bindings));
  const changedAuditUpdate = clone(actual);
  changedAuditUpdate.audit_logs[0].updated_at = "2026-10-25T08:00:00.123455Z";
  assert.throws(() => compareGeneratedProtected(template, changedAuditUpdate, bindings));
  const duplicate = clone(actual);
  duplicate.sessions.push(clone(duplicate.sessions[0]));
  assert.throws(() => compareGeneratedProtected(template, duplicate, bindings));
  const missing = clone(actual);
  missing.activity_events.pop();
  assert.throws(() => compareGeneratedProtected(template, missing, bindings));

  for (const [table, extra] of [
    ["operational_events", { ...clone(actual.operational_events[0]), id: "event-44444444-4444-4444-8444-444444444444", metadata: { mutation_id: "unrelated" } }],
    ["audit_logs", { ...clone(actual.audit_logs[0]), id: "audit-unrelated" }],
    ["activity_events", { ...clone(actual.activity_events[0]), id: "activity-44444444-4444-4444-8444-444444444444", source_id: "audit-unrelated" }]
  ]) {
    const withExtra = clone(actual);
    withExtra[table].push(extra);
    assert.throws(() => compareGeneratedProtected(template, withExtra, bindings), `extra ${table} row must reject in full protected comparison`);
  }
});
