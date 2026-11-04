import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { REQUIRED_PROOF_CHECKS, U1BrowserDatabaseAdapter, loadBrowserPackage } from "./u1-browser-database-adapter.mjs";
import { PROTECTED_TABLES, buildProtectedRead } from "./u1-protected-reader.mjs";
import { canonicalHash } from "./u1-data-reconciler.mjs";
import { prepareInstalledPhase } from './u1-phase-expectations.mjs';

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const clone = value => structuredClone(value);
const tmp = name => fs.mkdtempSync(path.join(os.tmpdir(), `u1-${name}-`));
const RUN_ID = "u1-adapter-offline-001";
function removeTmp(directory) {
  const resolved = path.resolve(directory), root = `${path.resolve(os.tmpdir())}${path.sep}`;
  assert(resolved.startsWith(root) && path.basename(resolved).startsWith("u1-"), "refuse cleanup outside owned temp root");
  fs.rmSync(resolved, { recursive: true, force: true });
}

function phase(index, pair, actors) {
  const offset = index % 5;
  const operation = ["start_session", "start_session", "save_live_session_details", "reject_session", "reject_session"][offset];
  const role = ["start-a", "start-b", "save-b", "reject-a", "reject-b"][offset];
  const actorSlot = offset === 0 || offset === 3 ? "A" : "B";
  const entityId = offset === 0 || offset === 3 ? pair.aId : pair.bId;
  const actorId = actors[actorSlot].id;
  const mutationId = `mutation-${index}`;
  const auditId = `audit-${index}`;
  const customerId = offset === 0 ? `customer-${pair.index}-a` : `customer-${pair.index}-b`;
  const customerName = [pair.customerA, pair.customerBBefore, pair.customerBAfter][offset];
  const audit = { id: auditId, userId: actorId };
  const payload = operation === "start_session"
    ? { session: { id: entityId, stationId: offset === 0 ? pair.stationIdA : pair.stationIdB,
      startedAt: '2026-10-25T08:00:00Z',
      items: [], comboApplications: [], continuedFromSessionIds: [] }, customer: { id: customerId }, auditLogs: [audit], stockMovements: [] }
    : operation === "save_live_session_details" ? { sessionId: entityId,
      customer: { id: customerId, name: customerName }, auditLog: audit }
      : { session: { id: entityId }, auditLog: audit };
  if (operation === "start_session") payload.customer.name = customerName;
  return { id: `phase-${index}`, pairIndex: Math.floor(index / 5), role, operation, actorSlot, actorId, entityId,
    mutationId, auditId, command: { organization_id: "org-primary", user_id: actorId, mutation_id: mutationId,
      mutation_kind: offset < 2 ? 'startSession' : offset === 2 ? 'saveLiveSessionDetails' : 'rejectSession', payload },
    generated: { id: `phase-${index}`, operation, entityId, actorId, mutationId, auditId,
      ...(["start_session", "save_live_session_details"].includes(operation)
        ? { customerId, customerWrite: operation === "start_session" ? "insert" : "update" } : {}) },
    plan: { operation, actor: actorId, outcome: "committed", patches: {} }, protectedRows: {} };
}

function writeAdmittedPackage(directory) {
  const runId = RUN_ID;
  const actors = { A: { id: "actor-a", role: "admin" }, B: { id: "actor-b", role: "admin" } };
  const pairs = Array.from({ length: 50 }, (_, index) => ({ index, aId: `session-${index}-a`, bId: `session-${index}-b`,
    stationIdA: `station-${index}-a`, stationIdB: `station-${index}-b`, customerA: `${RUN_ID}-a-${index}`,
    customerBBefore: `${RUN_ID}-b-before-${index}`, customerBAfter: `${RUN_ID}-b-after-${index}` }));
  const phases = Array.from({ length: 250 }, (_, index) => phase(index, pairs[Math.floor(index / 5)], actors));
  const intents = pairs.map((_pair, index) => {
    const measured = phases[index * 5 + 2];
    return { payload: measured.command, mutationId: measured.mutationId, auditId: measured.auditId,
      actorId: measured.actorId, entityId: measured.entityId };
  });
  const manifest = { runId, applicationCommit: "70ee5ab00bd758c3de2b86e4f68ae76e69c82f1e",
    baseURL: "https://gp-management-staging-pages.breakperfectgaminglounge.workers.dev/", project: "tkbdyzxwwbhkpztgjjxh", organization: "org-primary", pairs, intents };
  const pkg = { schema: "u1-browser-package-v1", generatedFieldPolicy: "u1-correlated-v1", manifest, actors, pairs, phases,
    protectedTables: PROTECTED_TABLES, proofs: {}, proofFiles: {}, assets: { "/assets/app.js": "a".repeat(64) } };
  for (const proof of ["catalog", "rollback", "source", "build", "reviewer", "tester"]) {
    const name = `${proof}.json`;
    const receipt = { runId, project: manifest.project, manifestHash: canonicalHash(manifest),
      ...(["reviewer", "tester"].includes(proof)
        ? { decision: "approved", scope: "u1-staging-run" }
        : { schema: `u1-${proof}-receipt-v1`, status: "passed", applicationCommit: manifest.applicationCommit,
          organization: "org-primary", checks: (REQUIRED_PROOF_CHECKS[proof] ?? [`${proof}-check`]).map((name, checkIndex) => {
            const evidenceFile = `${proof}-${checkIndex}.json`, evidenceBytes = Buffer.from(JSON.stringify({ proof, name }));
            fs.writeFileSync(path.join(directory, evidenceFile), evidenceBytes);
            return { name, status: "passed", evidenceFile, evidenceSha256: sha(evidenceBytes) };
          }) }) };
    const bytes = Buffer.from(JSON.stringify(receipt));
    fs.writeFileSync(path.join(directory, name), bytes);
    pkg.proofs[proof] = sha(bytes); pkg.proofFiles[proof] = name;
  }
  const file = path.join(directory, "package.json");
  const bytes = Buffer.from(JSON.stringify(pkg)); fs.writeFileSync(file, bytes);
  return { file, hash: sha(bytes), pkg };
}

test("browser package admission binds bytes, exact environment, 250 ordered phases, receipts, actors, and assets", () => {
  const directory = tmp("package");
  try {
    const admitted = writeAdmittedPackage(directory);
    assert.equal(loadBrowserPackage(admitted.file, admitted.hash).manifest.runId, admitted.pkg.manifest.runId);
    for (const slot of ['A','B']) for (const role of ['admin','manager','receptionist',null,'',' admin','Admin','viewer',1]) {
      const variant = clone(admitted.pkg); variant.actors[slot].role = role;
      const bytes = Buffer.from(JSON.stringify(variant)); fs.writeFileSync(admitted.file,bytes);
      if (['admin','manager','receptionist'].includes(role)) assert.doesNotThrow(()=>loadBrowserPackage(admitted.file,sha(bytes)));
      else assert.throws(()=>loadBrowserPackage(admitted.file,sha(bytes)),/Unauthorized fixture role/);
    }
    fs.writeFileSync(admitted.file,JSON.stringify(admitted.pkg));
    assert.throws(() => loadBrowserPackage(admitted.file, "0".repeat(64)));
    for (const mutate of [
      value => { value.manifest.project = "other"; },
      value => { value.manifest.baseURL = "https://production.example.invalid/"; },
      value => { value.phases.pop(); },
      value => { value.actors.B.id = value.actors.A.id; },
      value => { value.actors.B.role = 'viewer'; },
      value => { value.phases[0].mutationId = value.phases[1].mutationId; },
      value => { value.pairs[0].aId = "substituted"; },
      value => { value.manifest.intents[0].auditId = "substituted"; },
      value => { value.phases[2].generated.customerId = "substituted"; },
      value => { value.phases[0].command.payload.session.stationId = value.pairs[0].stationIdB; },
      value => { value.phases[2].command.payload.customer.name = value.phases[1].command.payload.customer.name; },
      value => { value.assets["/assets/app.js"] = "not-a-hash"; }
    ]) {
      const changed = clone(admitted.pkg); mutate(changed);
      const bytes = Buffer.from(JSON.stringify(changed)); fs.writeFileSync(admitted.file, bytes);
      assert.throws(() => loadBrowserPackage(admitted.file, sha(bytes)));
    }
    const missingProof = clone(admitted.pkg);
    const catalogFile = missingProof.proofFiles.catalog;
    const catalog = JSON.parse(fs.readFileSync(path.join(directory, catalogFile), "utf8"));
    catalog.checks.pop();
    const catalogBytes = Buffer.from(JSON.stringify(catalog)); fs.writeFileSync(path.join(directory, catalogFile), catalogBytes);
    missingProof.proofs.catalog = sha(catalogBytes);
    const missingProofBytes = Buffer.from(JSON.stringify(missingProof)); fs.writeFileSync(admitted.file, missingProofBytes);
    assert.throws(() => loadBrowserPackage(admitted.file, sha(missingProofBytes)), /Missing required proof checks/);
  } finally { removeTmp(directory); }
});

test("protected SQL collector is read-only, staging-pinned, rollback-terminated, and rejects identifier injection", () => {
  const scope = { sessionIds: ["session_a"], customerIds: ["customer_a"], customerNames: ["owned_customer"],
    auditIds: ["audit_a"], mutationIds: ["mutation_a"] };
  const sql = buildProtectedRead(scope);
  assert.match(sql, /^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;/);
  assert.match(sql, /transaction_read_only'\)<>'on'/);
  assert.match(sql, /tkbdyzxwwbhkpztgjjxh/);
  assert.match(sql, /f9bc0aed-b6c4-410f-ba2a-572522d03869/);
  assert.match(sql, /statement_timeout='5s'/);
  assert.match(sql, /lock_timeout='1s'/);
  assert.match(sql, /public\.operational_mutations/);
  assert.match(sql, /public\.analytics_dirty_dates/);
  assert.match(sql, /t\.organization_id<>'org-primary'/);
  assert.match(sql, /'incompleteOperationalMutations'/);
  assert.match(sql, /'incompleteFinancialMutations'/);
  assert.match(sql, /status<>'committed'/);
  assert.match(sql, /ROLLBACK;$/);
  assert.doesNotMatch(sql, /\b(?:insert|update|delete|alter|drop|truncate|grant|revoke|commit)\b/i);
  for (const bad of ["x');drop_table", "space id", "x.y", "'", "a".repeat(121)])
    assert.throws(() => buildProtectedRead({ ...scope, sessionIds: [bad] }));
  assert.throws(() => buildProtectedRead({ ...scope, mutationIds: ["same", "same"] }));
});

function minimalAdapter({ directory, responseStatus = 500, onPost = () => {} }) {
  const pair = { index: 0, aId: "session-a", bId: "session-b", stationIdA: "station-a", stationIdB: "station-b",
    customerA: `${RUN_ID}-a`, customerBBefore: `${RUN_ID}-b-before`, customerBAfter: `${RUN_ID}-b-after` };
  const actors = { A: { id: "actor-a", role: 'admin' }, B: { id: "actor-b", role: 'manager' } };
  const start = phase(0, pair, actors);
  const response = { status: () => responseStatus, body: async () => Buffer.from('{"code":"offline-test"}') };
  const request = { post: async (url, options) => { onPost(url, options); return response; } };
  const page = { request };
  const pkg = { manifest: { runId: "u1-adapter", pairs: [pair], intents: [{}] }, pairs: [pair], phases: [start], actors, finalProtectedRows: {} };
  const adapter = Object.create(U1BrowserDatabaseAdapter.prototype);
  Object.assign(adapter, { pages: { A: page, B: page }, pkg, credentials: {}, protectedReader: async () => ({}),
    directory: path.resolve(directory), headers: {}, errors: [], bindings: Object.create(null), generatedIds: new Set(),
    sequence: 0, phaseIndex: 0, observations: [], ownedIds: [], expectedProtected: { sessions: [], analytics_dirty_dates: [] },
    preparedPhases: [], previousRecordHash: null });
  fs.mkdirSync(adapter.directory, { recursive: false });
  adapter.current = { id: "primary", version: 1 };
  adapter.latestRows = { sessions: [] };
  return { adapter, start };
}

test("adapter constructor refuses evidence outside the exact run-owned project directory", () => {
  const directory = tmp("bad-evidence");
  try {
    const page = { request: {} }, runId = "u1-path-guard";
    assert.throws(() => new U1BrowserDatabaseAdapter({ origin: page, observer: page,
      package: { manifest: { runId }, actors: {} }, credentials: {}, protectedReader: async () => ({}), evidenceDirectory: directory }),
    /Unapproved evidence directory/);
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally { removeTmp(directory); }
});

test("mutation admission records the exact command and registers owned start ID before one zero-retry POST", async () => {
  const root = tmp("post"), directory = path.join(root, "evidence");
  try {
    let posts = 0; const order = [];
    const { adapter, start } = minimalAdapter({ directory, onPost: (_url, options) => {
      posts++; order.push("post");
      assert(adapter.ownedIds.includes(start.entityId));
      assert.equal(options.maxRetries, 0); assert.equal(options.maxRedirects, 0);
      assert.deepEqual(options.data, { payload: start.command });
    } });
    const originalRecord = adapter.record.bind(adapter);
    adapter.record = async value => { order.push(value.phase); return originalRecord(value); };
    await assert.rejects(() => adapter.executePhase(0));
    assert.deepEqual(order.slice(0, 4), ["prepared-command", "submission-attempt", "post", "submission-failure"]);
    assert.equal(posts, 1); assert.equal(adapter.phaseIndex, 1);
    await assert.rejects(() => adapter.executePhase(0));
    assert.equal(posts, 1, "failed or ambiguous POST must not be retried");
    const prepared = JSON.parse(fs.readFileSync(path.join(directory, fs.readdirSync(directory).find(name => name.includes("prepared-command"))), "utf8"));
    assert.deepEqual(prepared.command, start.command);
    assert.match(prepared.installedIntent.startMetadata.request_fingerprint, /^[a-f0-9]{32}$/);
  } finally { removeTmp(root); }
});

test("terminal evidence seals immutable expected/observed files and binds their terminal record hash", async () => {
  const root = tmp("terminal"); const directory = path.join(root, "evidence");
  try {
    const { adapter } = minimalAdapter({ directory });
    adapter.initialState = { id: "primary", version: 1 };
    adapter.preparedPhases = [];
    adapter.observations = [];
    adapter.finalSnapshot = { appState: { id: "primary", version: 1 }, protectedRows: {} };
    const reference = await adapter.record({ phase: "terminal", status: "completed-unverified", samples: [] });
    const observed = JSON.parse(fs.readFileSync(path.join(directory, "observed.json"), "utf8"));
    assert.deepEqual(observed.terminalRecord, reference);
    assert.equal(sha(fs.readFileSync(path.join(directory, reference.file))), reference.sha256);
    assert.equal(observed.retry, 0); assert.equal(observed.attempt, 1);
    assert.throws(() => fs.openSync(path.join(directory, "observed.json"), "wx"));
  } finally { removeTmp(root); }
});

test("deferred finalization uses authoritative readback and rejects an out-of-budget canonical response", async () => {
  const root = tmp("deferred"); const directory = path.join(root, "evidence");
  try {
    const { adapter, start } = minimalAdapter({ directory, responseStatus: 200 });
    const pending = { phase: start,
      generated: { ...start.generated, earliestServerTime: "2026-10-25T08:00:00.000000Z", latestServerTime: "2026-10-25T08:00:15.000000Z" },
      planInput: {}, intent: null, prepared: { file: "prepared.json", sha256: "a".repeat(64) },
      body: { organization_id: "org-primary", entity_type: "session", entity_id: start.entityId,
        mutation_id: start.mutationId, event_id: "event-11111111-1111-4111-8111-111111111111",
        server_time: "2026-10-25T08:00:15.000001",
        changed_rows: { sessions: [start.entityId], audit_logs: [start.auditId],
          operational_events: ["event-11111111-1111-4111-8111-111111111111"], customers: [start.generated.customerId],
          session_items: [], session_combo_applications: [], stock_movements: [] } } };
    adapter.snapshot = async () => ({ appState: { id: "primary", version: 2, updated_at: "2026-10-25T08:00:15.000001Z" },
      protectedRows: { operational_events: [], audit_logs: [], activity_events: [] } });
    await assert.rejects(() => adapter.finalizePhase(pending), /timestamp|canonical|response|bound/i);
    assert.equal(adapter.observations.length, 0);
  } finally { removeTmp(root); }
});

test("finalization compares authoritative protected readback instead of fabricating expected success", async () => {
  const root = tmp("readback"); const directory = path.join(root, "evidence");
  try {
    const pair = { index: 0, aId: "session-a", bId: "session-b", stationIdA: "station-a", stationIdB: "station-b",
      customerA: `${RUN_ID}-a`, customerBBefore: `${RUN_ID}-b-before`, customerBAfter: `${RUN_ID}-b-after` };
    const actors = { A: { id: "actor-a" }, B: { id: "actor-b" } };
    const save = phase(2, pair, actors);
    const eventId = "event-11111111-1111-4111-8111-111111111111";
    const auditActivityId = "activity-22222222-2222-4222-8222-222222222222";
    const operationalActivityId = "activity-33333333-3333-4333-8333-333333333333";
    const serverTime = "2026-10-25T08:00:00.123456Z";
    const installedIntent = prepareInstalledPhase({ analytics_dirty_dates: [], sessions: [{ id: save.entityId,
      organization_id: 'org-primary', status: 'active', closed_bill_id: null, started_at: serverTime }] }, save.operation, save.command);
    save.protectedRows = {
      sessions: [{ id: save.entityId, customer_name: "expected", updated_at: { $generated: "serverTime", phase: save.id } }],
      audit_logs: [{ id: save.auditId, created_at: { $generated: "serverTime", phase: save.id },
        updated_at: { $generated: "serverTime", phase: save.id }, audit_at: { $generated: "serverTime", phase: save.id },
        raw_data: { createdAt: { $generated: "serverTime", phase: save.id } } }],
      operational_events: [{ id: { $generated: "eventId", phase: save.id }, created_at: { $generated: "serverTime", phase: save.id },
        metadata: { mutation_id: save.mutationId, audit_log_id: save.auditId, customer_id: save.generated.customerId } }],
      activity_events: [
        { id: { $generated: "auditActivityId", phase: save.id }, source_kind: "audit_log", source_id: save.auditId,
          created_at: { $generated: "serverTime", phase: save.id }, occurred_at: { $generated: "serverTime", phase: save.id } },
        { id: { $generated: "operationalActivityId", phase: save.id }, source_kind: "operational_event",
          source_id: { $generated: "eventId", phase: save.id }, details: { event_id: { $generated: "eventId", phase: save.id } },
          created_at: { $generated: "serverTime", phase: save.id }, occurred_at: { $generated: "serverTime", phase: save.id } }
      ]
    };
    const actual = {
      sessions: [{ id: save.entityId, customer_name: "corrupted", updated_at: serverTime }],
      audit_logs: [{ id: save.auditId, organization_id: "org-primary", user_id: save.actorId, entity_type: "session", entity_id: save.entityId,
        created_at: serverTime, updated_at: serverTime, audit_at: serverTime, raw_data: { userId: save.actorId, createdAt: serverTime } }],
      operational_events: [{ id: eventId, organization_id: "org-primary", event_type: save.operation, entity_type: "session", entity_id: save.entityId,
        created_by: save.actorId, created_at: serverTime, metadata: { mutation_id: save.mutationId, audit_log_id: save.auditId,
          customer_id: save.generated.customerId } }],
      activity_events: [
        { id: auditActivityId, organization_id: "org-primary", source_kind: "audit_log", source_id: save.auditId, actor_user_id: save.actorId,
          entity_type: "session", entity_id: save.entityId, legacy: false, mutation_id: null, occurred_at: serverTime, created_at: serverTime,
          details: { audit_id: save.auditId } },
        { id: operationalActivityId, organization_id: "org-primary", source_kind: "operational_event", source_id: eventId,
          actor_user_id: save.actorId, entity_type: "session", entity_id: save.entityId, legacy: false, mutation_id: save.mutationId,
          audit_reference_ids: [save.auditId], occurred_at: serverTime, created_at: serverTime, details: { event_id: eventId } }
      ]
    };
    const page = { request: {} };
    const dirty = { organization_id: 'org-primary', business_date: '2026-10-25', reason: 'session_change', updated_at: serverTime };
    save.protectedRows.analytics_dirty_dates = [dirty];
    actual.analytics_dirty_dates = [clone(dirty)];
    const adapter = Object.create(U1BrowserDatabaseAdapter.prototype);
    Object.assign(adapter, { pages: { A: page, B: page },
      pkg: { manifest: { runId: "u1-readback", pairs: [pair], intents: [{}] }, pairs: [pair], phases: [save], actors, finalProtectedRows: {} },
      credentials: {}, protectedReader: async () => ({}), directory: path.resolve(directory), headers: {}, errors: [],
      bindings: Object.create(null), generatedIds: new Set(), sequence: 0, phaseIndex: 0, observations: [], ownedIds: [],
      expectedProtected: null, preparedPhases: [], previousRecordHash: null });
    fs.mkdirSync(adapter.directory, { recursive: false });
    adapter.current = { id: "primary", version: 1 };
    adapter.snapshot = async () => ({ appState: { id: "primary", version: 1, updated_at: serverTime }, protectedRows: actual });
    const pending = { phase: save, installedIntent,
      generated: { ...save.generated, earliestServerTime: "2026-10-25T08:00:00.000000Z", latestServerTime: "2026-10-25T08:00:15.000000Z" },
      planInput: {}, intent: null, prepared: { file: "prepared.json", sha256: "a".repeat(64) },
      body: { organization_id: "org-primary", entity_type: "session", entity_id: save.entityId, mutation_id: save.mutationId,
        event_id: eventId, server_time: "2026-10-25T08:00:00.123456",
        changed_rows: { sessions: [save.entityId], audit_logs: [save.auditId], operational_events: [eventId], customers: [save.generated.customerId] } } };
    await assert.rejects(() => adapter.finalizePhase(pending), /Protected generated\/business rows mismatch/);
    assert.equal(adapter.observations.length, 0);
  } finally { removeTmp(root); }
});
