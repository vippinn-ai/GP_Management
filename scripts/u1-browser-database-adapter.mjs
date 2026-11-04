import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expect } from '@playwright/test';
import { canonicalHash, planPhase, sealPhaseIntent, finalizePhaseIntent } from './u1-data-reconciler.mjs';
import { bindGeneratedPhase, compareGeneratedProtected, canonicalProtectedRows } from './u1-generated-fields.mjs';
import { verifyTarget } from './u1-playwright-runner.mjs';
import { PROTECTED_TABLES } from './u1-protected-reader.mjs';
import { expectedStartEventMetadata } from './u1-installed-contract.mjs';
import { prepareInstalledPhase, compareInstalledPhase } from './u1-phase-expectations.mjs';

const DB = 'https://tkbdyzxwwbhkpztgjjxh.supabase.co';
const ORG = 'org-primary';
const check = (ok, message) => { if (!ok) throw new Error(message); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const REQUIRED_PROOF_CHECKS = Object.freeze({
  catalog: ['installed-functions-grants', 'tables-rls-publication', 'staging-identity'],
  rollback: ['baseline-restored-assets', 'baseline-readback', 'protected-data-parity'],
  source: ['application-commit', 'harness-source-hashes', 'discovery-limits'],
  build: ['asset-hashes', 'feature-flags', 'staging-target'],
});
// Analytics summary refresh writes rollups and consumes dirty dates. It is not
// a read-only RPC and is forbidden during this dashboard-only fixture.
const readRpcs = new Set(['list_activity_events', 'load_inventory_report_summary', 'current_user_org_role']);
const tables = new Set(['sessions', 'session_items', 'session_pause_logs', 'session_combo_applications',
  'customers', 'customer_tabs', 'customer_tab_items', 'bills', 'bill_lines', 'payments', 'stock_movements',
  'inventory_items', 'sale_variants', 'audit_logs', 'operational_events', 'activity_events']);

export function loadBrowserPackage(file, approvedHash) {
  check(typeof file === 'string' && /^[a-f0-9]{64}$/.test(approvedHash ?? ''), 'Missing independently admitted package');
  const bytes = fs.readFileSync(file); check(sha(bytes) === approvedHash, 'Package bytes changed');
  const pkg = JSON.parse(bytes);
  check(pkg.schema === 'u1-browser-package-v1' && pkg.generatedFieldPolicy === 'u1-correlated-v1', 'Wrong package schema');
  check(pkg.manifest?.applicationCommit === '70ee5ab00bd758c3de2b86e4f68ae76e69c82f1e', 'Unexpected application candidate');
  check(/^[A-Za-z0-9_-]{6,80}$/.test(pkg.manifest?.runId ?? ''), 'Invalid run identity');
  verifyTarget(pkg.manifest.baseURL);
  check(pkg.manifest.project === 'tkbdyzxwwbhkpztgjjxh' && pkg.manifest.organization === ORG, 'Wrong environment');
  check(pkg.phases?.length === 250 && pkg.pairs?.length === 50, 'Incomplete package');
  check(canonicalHash(pkg.pairs) === canonicalHash(pkg.manifest.pairs) && pkg.manifest.intents?.length === 50,
    'Manifest pair authority mismatch');
  pkg.manifest.intents.forEach((intent, index) => {
    const phase = pkg.phases[index * 5 + 2];
    check(canonicalHash(intent.payload) === canonicalHash(phase.command) &&
      ['entityId', 'actorId', 'mutationId', 'auditId'].every(key => intent[key] === phase[key]), 'Manifest intent authority mismatch');
  });
  check(pkg.actors?.A?.id && pkg.actors?.B?.id && pkg.actors.A.id !== pkg.actors.B.id, 'Distinct actors required');
  check(['A', 'B'].every(slot => ['admin', 'manager', 'receptionist'].includes(pkg.actors[slot].role)), 'Unauthorized fixture role');
  check(canonicalHash(pkg.protectedTables) === canonicalHash(PROTECTED_TABLES), 'Incomplete protected table set');
  const mutations = new Set(), audits = new Set(), customers = new Set(), customerNames = new Set();
  const operations = ['start_session', 'start_session', 'save_live_session_details', 'reject_session', 'reject_session'];
  const roles = ['start-a', 'start-b', 'save-b', 'reject-a', 'reject-b'];
  pkg.phases.forEach((phase, index) => {
    const pairIndex = Math.floor(index / 5), offset = index % 5, pair = pkg.pairs[pairIndex];
    const entityId = pair[offset === 0 || offset === 3 ? 'aId' : 'bId'];
    const inner = phase.command?.payload;
    const commandEntity = offset === 2 ? inner?.sessionId : inner?.session?.id;
    const audit = offset < 2 ? inner?.auditLogs?.[0] : inner?.auditLog;
    check(phase.operation === operations[offset] && phase.role === roles[offset] && phase.pairIndex === pairIndex &&
      phase.actorSlot === (offset === 0 || offset === 3 ? 'A' : 'B') &&
      phase.entityId === entityId && commandEntity === entityId && phase.command?.organization_id === ORG &&
      phase.actorId === pkg.actors[phase.actorSlot]?.id && phase.command.user_id === phase.actorId &&
      phase.command.mutation_id === phase.mutationId && audit?.id === phase.auditId && audit.userId === phase.actorId &&
      !mutations.has(phase.mutationId) && !audits.has(phase.auditId), 'Invalid pre-submit phase binding');
    check(phase.generated?.id === phase.id && phase.generated.operation === phase.operation &&
      ['entityId', 'actorId', 'mutationId', 'auditId'].every(key => phase.generated[key] === phase[key]), 'Invalid generated phase binding');
    check(phase.plan?.operation === phase.operation && phase.plan.actor === phase.actorId && phase.plan.outcome === 'committed', 'Invalid expected plan');
    if (offset < 2) check(inner.auditLogs.length === 1 && ['items', 'comboApplications', 'continuedFromSessionIds'].every(key => (inner.session[key] ?? []).length === 0) &&
      (inner.stockMovements ?? []).length === 0 && inner.customer?.id === phase.generated.customerId, 'Fixture requires explicit customer and empty children');
    if (offset < 2) check(typeof pair[offset === 0 ? 'stationIdA' : 'stationIdB'] === 'string' &&
      inner.session.stationId === pair[offset === 0 ? 'stationIdA' : 'stationIdB'], 'Start station identity mismatch');
    if (offset < 3) check(typeof inner.customer?.name === 'string' && inner.customer.name.startsWith(`${pkg.manifest.runId}-`) &&
      /^[A-Za-z0-9_-]{6,120}$/.test(inner.customer.name) && !inner.customer.phone && inner.customer.id === phase.generated.customerId,
      'Fixture requires unique run-owned customer names and no phone matching');
    if (offset < 3) check(phase.generated.customerWrite === (offset < 2 ? 'insert' : 'update'), 'Wrong customer write mode');
    if (offset < 3) {
      const name = inner.customer.name.toLowerCase();
      check(!customerNames.has(name) && inner.customer.name === pair[['customerA', 'customerBBefore', 'customerBAfter'][offset]], 'Customer name ownership mismatch');
      customerNames.add(name);
    }
    if (offset < 2) {
      expectedStartEventMetadata(phase.command, 'event-pending');
      check(!customers.has(phase.generated.customerId), 'Duplicate fixture customer'); customers.add(phase.generated.customerId);
    }
    if (offset === 2) check(phase.generated.customerId === pkg.phases[index - 1].generated.customerId, 'Save customer must belong to started observer session');
    mutations.add(phase.mutationId); audits.add(phase.auditId);
  });
  for (const proof of ['catalog', 'rollback', 'source', 'build', 'reviewer', 'tester'])
  {
    check(/^[a-f0-9]{64}$/.test(pkg.proofs?.[proof] ?? ''), `Missing ${proof} receipt`);
    const relative = pkg.proofFiles?.[proof];
    check(typeof relative === 'string' && /^[A-Za-z0-9_-]+\.json$/.test(relative), 'Invalid receipt path');
    const receiptBytes = fs.readFileSync(path.join(path.dirname(path.resolve(file)), relative));
    check(sha(receiptBytes) === pkg.proofs[proof], 'Receipt bytes changed');
    const receipt = JSON.parse(receiptBytes);
    check(receipt.runId === pkg.manifest.runId && receipt.project === pkg.manifest.project &&
      receipt.manifestHash === canonicalHash(pkg.manifest), 'Receipt targets different run');
    if (proof === 'reviewer' || proof === 'tester') check(receipt.decision === 'approved' && receipt.scope === 'u1-staging-run', 'Missing independent run approval');
    else check(receipt.schema === `u1-${proof}-receipt-v1` && receipt.status === 'passed' &&
      receipt.applicationCommit === pkg.manifest.applicationCommit && receipt.organization === ORG &&
      Array.isArray(receipt.checks) && receipt.checks.length > 0 && receipt.checks.every(item =>
        typeof item.name === 'string' && item.name.length > 0 && item.status === 'passed' && /^[a-f0-9]{64}$/.test(item.evidenceSha256)),
    `Incomplete or failed ${proof} proof`);
    if (REQUIRED_PROOF_CHECKS[proof]) {
      check(canonicalHash(receipt.checks.map(item => item.name).sort()) === canonicalHash([...REQUIRED_PROOF_CHECKS[proof]].sort()), 'Missing required proof checks');
      for (const item of receipt.checks) {
        check(/^[A-Za-z0-9_.-]+\.(?:json|txt|sql)$/.test(item.evidenceFile ?? '') && !item.evidenceFile.includes('..'), 'Invalid proof evidence path');
        check(sha(fs.readFileSync(path.join(path.dirname(path.resolve(file)), item.evidenceFile))) === item.evidenceSha256, 'Proof evidence drift');
      }
    }
  }
  check(pkg.assets && Object.keys(pkg.assets).length > 0 && Object.entries(pkg.assets).every(([key, hash]) =>
    /^\/assets\/[A-Za-z0-9_.-]+\.(?:js|css)$/.test(key) && /^[a-f0-9]{64}$/.test(hash)), 'Missing pinned build assets');
  return { ...pkg, authority: { packageFile: path.resolve(file), packageSha256: approvedHash,
    manifestHash: canonicalHash(pkg.manifest), proofs: pkg.proofs } };
}

// All secrets remain in memory. record() writes only requested protected evidence,
// never response headers, login payloads, or bearer tokens.
export class U1BrowserDatabaseAdapter {
  constructor({ origin, observer, package: pkg, evidenceDirectory, credentials, protectedReader }) {
    const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
    this.pages = { A: origin, B: observer }; this.pkg = freeze(structuredClone(pkg)); this.credentials = credentials;
    check(typeof protectedReader === 'function', 'Missing independently guarded protected reader'); this.protectedReader = protectedReader;
    this.directory = path.resolve(evidenceDirectory);
    check(this.directory === path.resolve('test-artifacts', 'u1-evidence', pkg.manifest.runId), 'Unapproved evidence directory');
    for (let parent = path.dirname(this.directory); ; parent = path.dirname(parent)) {
      if (fs.existsSync(parent)) check(!fs.lstatSync(parent).isSymbolicLink(), 'Symlink evidence ancestor');
      if (parent === path.dirname(parent)) break;
    }
    fs.mkdirSync(path.dirname(this.directory), { recursive: true }); fs.mkdirSync(this.directory, { recursive: false });
    this.headers = {}; this.errors = []; this.bindings = Object.create(null); this.generatedIds = new Set();
    this.sequence = 0; this.phaseIndex = 0; this.observations = []; this.ownedIds = []; this.expectedProtected = null;
    this.preparedPhases = []; this.previousRecordHash = null;
  }
  async record(value) {
    const file = path.join(this.directory, `${String(this.sequence++).padStart(5, '0')}-${value.phase ?? 'evidence'}.json`);
    const bytes = `${JSON.stringify({ previousRecordHash: this.previousRecordHash, ...value })}\n`;
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this.previousRecordHash = sha(bytes);
    const reference = { file: path.basename(file), sha256: this.previousRecordHash };
    if (value.phase === 'terminal') this.writeTerminalArtifacts(value, reference);
    return reference;
  }
  writeTerminalArtifacts(terminal, reference) {
    const expected = { schema: 'u1-expectations-v1', generatedFieldPolicy: 'u1-correlated-v1',
      authority: this.pkg.authority,
      runId: this.pkg.manifest.runId, project: 'tkbdyzxwwbhkpztgjjxh', organization: ORG,
      initial: this.initialState, phases: this.preparedPhases,
      pairs: this.pkg.manifest.pairs.map((pair, index) => ({ ...pair, intentHash: canonicalHash(this.pkg.manifest.intents[index]) })),
      finalProtectedRows: this.pkg.finalProtectedRows };
    const observed = { schema: 'u1-observations-v1', runId: expected.runId, project: expected.project,
      authority: this.pkg.authority,
      organization: ORG, attempt: 1, retry: 0, status: terminal.status, samples: terminal.samples,
      phases: this.observations, final: this.finalSnapshot?.appState, finalProtectedRows: this.finalSnapshot?.protectedRows,
      terminalRecord: reference };
    for (const [name, value] of [['expected.json', expected], ['observed.json', observed]]) {
      const fd = fs.openSync(path.join(this.directory, name), 'wx', 0o600);
      try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
  }
  async read(slot, table, filters = {}) {
    check(table === 'profiles' || table === 'sessions', 'Only targeted UI/actor readbacks allowed');
    if (table === 'profiles') check(filters.id === `eq.${this.pkg.actors[slot].id}`, 'Unscoped profile read');
    else {
      const allowedPairs = this.pkg.pairs.map(pair => `in.(${pair.aId},${pair.bId})`);
      check(filters.organization_id === `eq.${ORG}` && allowedPairs.includes(filters.id), 'Unscoped session read');
    }
    const result = []; const page = this.pages[slot];
    for (let offset = 0; ; offset += 500) {
      const url = new URL(`${DB}/rest/v1/${table}`);
      for (const [key, value] of Object.entries({ select: '*', ...filters, order: 'id.asc', limit: '500', offset: String(offset) })) url.searchParams.set(key, value);
      const response = await page.request.get(url.href, { headers: this.headers[slot], timeout: 15000, maxRedirects: 0, maxRetries: 0 });
      check(response.status() === 200, 'Protected read failed');
      const rows = await response.json(); check(Array.isArray(rows), 'Invalid protected read'); result.push(...rows);
      if (rows.length < 500) break;
      check(offset < 100000, 'Protected read exceeded admitted pagination bound');
    }
    return result;
  }
  async snapshot() {
    const state = await this.protectedReader(); check(state.appState?.id === 'primary', 'Missing app_state');
    if (this.nonOwned) check(canonicalHash(state.protectedRows._unowned) === this.nonOwned, 'Non-owned data changed');
    this.latestRows = state.protectedRows; return state;
  }
  async login(slot) {
    const page = this.pages[slot];
    await page.context().route('**/*', async route => {
      const url = new URL(route.request().url());
      const allowed = [new URL(this.pkg.manifest.baseURL).origin, DB];
      if (!allowed.includes(url.origin)) { this.errors.push('unexpected-origin'); return route.abort(); }
      const method = route.request().method();
      const loginPath = ['/auth/v1/token', '/functions/v1/resolve-login-email'].includes(url.pathname);
      const permitted = url.origin !== DB ? ['GET', 'HEAD'].includes(method) :
        (['GET', 'HEAD'].includes(method) && (url.pathname.startsWith('/rest/v1/') || url.pathname === '/auth/v1/user')) ||
        (['POST', 'OPTIONS'].includes(method) && (loginPath || (url.pathname.startsWith('/rest/v1/rpc/') && readRpcs.has(url.pathname.split('/').at(-1))))) ||
        (method === 'OPTIONS' && url.pathname.startsWith('/rest/v1/'));
      if (!permitted) { this.errors.push('unexpected-request'); return route.abort(); }
      if (url.origin === DB && url.pathname.startsWith('/rest/v1/') && route.request().method() !== 'GET' &&
        !(route.request().method() === 'POST' && readRpcs.has(url.pathname.split('/').at(-1)))) {
        this.errors.push('unexpected-app-write'); return route.abort();
      }
      return route.continue();
    });
    await page.context().routeWebSocket('**/*', socket => {
      const url = new URL(socket.url());
      if (url.origin !== 'wss://tkbdyzxwwbhkpztgjjxh.supabase.co') { this.errors.push('unexpected-websocket'); return socket.close(); }
      socket.connectToServer();
    });
    page.on('pageerror', () => this.errors.push('page-error'));
    page.on('console', message => { if (message.type() === 'error') this.errors.push('console-error'); });
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === DB && url.pathname.startsWith('/rest/v1/')) {
        const headers = request.headers();
        if (headers.authorization && headers.apikey) this.headers[slot] = { authorization: headers.authorization, apikey: headers.apikey };
      }
    });
    await page.goto(this.pkg.manifest.baseURL, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Username', { exact: true }).fill(this.credentials[slot].username);
    await page.getByLabel('Password', { exact: true }).fill(this.credentials[slot].password);
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Live Dashboard', exact: true })).toBeVisible();
    check(this.headers[slot], 'Missing staging authenticated browser identity');
    const user = await page.request.get(`${DB}/auth/v1/user`, { headers: this.headers[slot], timeout: 15000, maxRedirects: 0, maxRetries: 0 });
    check(user.status() === 200 && (await user.json()).id === this.pkg.actors[slot].id, 'Wrong authenticated actor');
  }
  async preflight() {
    // Sequential login avoids the previously observed sign-in contention.
    await this.login('A'); await this.login('B');
    for (const slot of ['A', 'B']) {
      const profiles = await this.read(slot, 'profiles', { id: `eq.${this.pkg.actors[slot].id}` });
      check(profiles.length === 1 && profiles[0].active === true && profiles[0].role === this.pkg.actors[slot].role, 'Inactive or wrong QA actor');
      const role = await this.pages[slot].request.post(`${DB}/rest/v1/rpc/current_user_org_role`, {
        headers: this.headers[slot], data: { target_organization_id: ORG }, timeout: 15000, maxRedirects: 0, maxRetries: 0 });
      check(role.status() === 200 && await role.json() === this.pkg.actors[slot].role, 'Wrong organization membership');
    }
    const state = await this.snapshot();
    const loaded = await this.pages.A.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name).filter(name => /\/assets\/.*\.(?:js|css)(?:\?|$)/.test(name)));
    for (const name of loaded) check(Object.hasOwn(this.pkg.assets, new URL(name).pathname), 'Unpinned loaded build asset');
    for (const [assetPath, hash] of Object.entries(this.pkg.assets)) {
      const response = await this.pages.A.request.get(new URL(assetPath, this.pkg.manifest.baseURL).href, { timeout: 15000, maxRedirects: 0, maxRetries: 0 });
      check(response.status() === 200 && sha(await response.body()) === hash, 'Live build asset drift');
    }
    check(canonicalHash(state.appState) === this.pkg.manifest.initialAppStateHash, 'Initial state changed');
    check(canonicalHash(state.protectedRows) === this.pkg.initialProtectedHash, 'Initial protected rows changed');
    check(state.floor.openSessions === 0 && state.floor.openTabs === 0 && state.floor.unbilledHops === 0 &&
      state.floor.customerNameCollisions === 0 && state.floor.incompleteOperationalMutations === 0 &&
      state.floor.incompleteFinancialMutations === 0, 'Staging floor/fixture names are not clear');
    check(PROTECTED_TABLES.filter(table => table !== 'analytics_dirty_dates').every(table => state.protectedRows[table]?.length === 0), 'Fresh fixture IDs collide');
    check(Array.isArray(state.protectedRows.analytics_dirty_dates), 'Missing shared analytics preimage');
    await this.queues(); check(this.errors.length === 0, 'Preflight browser errors');
    this.nonOwned = canonicalHash(state.protectedRows._unowned);
    this.current = state.appState; this.expectedProtected = state.protectedRows;
    this.initialState = state.appState;
    await this.record({ phase: 'preflight', ...state });
    return { pairs: this.pkg.manifest.pairs, appState: state.appState };
  }
  async executePhase(index, defer = false) {
    check(this.errors.length === 0, 'Browser errors prohibit further mutations');
    check(index === this.phaseIndex, 'Out-of-order or repeated phase');
    const phase = this.pkg.phases[index];
    check(['start_session', 'save_live_session_details', 'reject_session'].includes(phase.operation), 'Unclassified writer');
    const actorSlot = phase.actorSlot; check(['A', 'B'].includes(actorSlot), 'Missing bound actor slot');
    check(['admin', 'manager', 'receptionist'].includes(this.pkg.actors[actorSlot]?.role), 'Unauthorized fixture role');
    check(phase.command.organization_id === ORG && phase.command.user_id === this.pkg.actors[actorSlot].id &&
      phase.command.mutation_id === phase.mutationId, 'Command identity mismatch');
    if (phase.operation === 'reject_session') check(phase.command.base_app_state_version === this.current.version, 'Stale cleanup version');
    if (phase.operation === 'reject_session') {
      const row = this.latestRows.sessions.find(row => row.id === phase.entityId);
      check(this.ownedIds.includes(phase.entityId) && row?.status === 'active' && row.closed_bill_id === null && row.close_disposition === null,
        'Unsafe cleanup target');
    }
    const earliestServerTime = new Date().toISOString(); const latestServerTime = new Date(Date.parse(earliestServerTime) + 15000).toISOString();
    const generated = { ...phase.generated, id: phase.id, operation: phase.operation, earliestServerTime, latestServerTime };
    const installedIntent = prepareInstalledPhase(this.expectedProtected, phase.operation, phase.command);
    const planInput = { ...phase.plan, before: this.current, earliestServerTime, latestServerTime };
    const intent = phase.operation === 'reject_session' ? sealPhaseIntent(planInput) : null;
    // Persist independent expectations+exact request BEFORE the network side effect.
    const expectedPlan = phase.operation === 'reject_session'
      ? { operation: phase.operation, outcome: 'committed', actor: phase.actorId, patches: phase.plan.patches, earliestServerTime, latestServerTime }
      : { operation: phase.operation, outcome: 'committed', actor: phase.actorId, patches: {}, serverTime: earliestServerTime };
    const expectedPhase = { id: phase.id, pairIndex: phase.pairIndex, role: phase.role, entityId: phase.entityId,
      actorId: phase.actorId, mutationId: phase.mutationId, auditId: phase.auditId, generated,
      plan: expectedPlan, protectedRows: phase.protectedRows, ...(phase.uiParity ? { uiParity: phase.uiParity } : {}) };
    const prepared = await this.record({ phase: 'prepared-command', expectedPhase, command: phase.command,
      beforeHash: canonicalHash(this.current), installedIntent });
    this.preparedPhases.push({ ...expectedPhase, preparedArtifact: prepared });
    if (phase.operation === 'start_session' && !this.ownedIds.includes(phase.entityId)) this.ownedIds.push(phase.entityId);
    this.phaseIndex++; // A lost response can never authorize the same submission again.
    let body, responseStatus = null, responseHash = null, responseLength = null;
    await this.record({ phase: 'submission-attempt', mutationId: phase.mutationId, preparedArtifact: prepared });
    try {
    const response = await this.pages[actorSlot].request.post(`${DB}/rest/v1/rpc/${phase.operation}`, {
      headers: this.headers[actorSlot], data: { payload: phase.command }, timeout: 15000, maxRedirects: 0, maxRetries: 0,
    });
    responseStatus = response.status();
    const responseBytes = await response.body(); responseHash = sha(responseBytes); responseLength = responseBytes.length;
    check(responseStatus === 200 && responseLength <= 1048576, 'Mutation rejected or ambiguous; read-only reconciliation required');
    body = JSON.parse(responseBytes.toString('utf8'));
    check(body.mutation_id === phase.mutationId && body.entity_id === phase.entityId && body.organization_id === ORG && body.idempotent !== true, 'Unbound writer acknowledgement');
    await this.record({ phase: 'submission-response', mutationId: phase.mutationId, preparedArtifact: prepared,
      responseStatus, responseHash, responseLength, response: body });
    } catch {
      await this.record({ phase: 'submission-failure', mutationId: phase.mutationId, preparedArtifact: prepared,
        status: 'ambiguous-read-only-reconciliation-required', responseStatus, responseHash, responseLength });
      throw new Error('Mutation failed or ambiguous; no resend permitted');
    }
    const pending = { phase, generated, planInput, intent, installedIntent, body, prepared };
    if (defer) { this.pending = pending; return pending; }
    return this.finalizePhase(pending);
  }
  async finalizePhase({ phase, generated, planInput, intent, installedIntent, body, prepared, uiParity, pendingQueues }) {
    const after = await this.snapshot();
    const bound = bindGeneratedPhase(generated, body, after.protectedRows, phase.command);
    for (const key of ['eventId', 'auditActivityId', 'operationalActivityId']) {
      check(!this.generatedIds.has(bound[key]), 'Reused generated ID'); this.generatedIds.add(bound[key]);
    }
    this.bindings[phase.id] = bound;
    const expectedRaw = compareInstalledPhase(phase.protectedRows, after.protectedRows, this.bindings, phase.id, installedIntent);
    const expectedProtectedRows = canonicalProtectedRows(expectedRaw);
    const plan = intent ? finalizePhaseIntent(intent, { responseTime: body.server_time, databaseTime: after.appState.updated_at }) :
      planPhase({ ...phase.plan, before: this.current, serverTime: body.server_time });
    const receipt = { plan, after: after.appState, expectedProtectedRows, actualProtectedRows: canonicalProtectedRows(after.protectedRows) };
    this.current = after.appState; this.expectedProtected = expectedRaw;
    const observation = { id: phase.id, pairIndex: phase.pairIndex, role: phase.role, entityId: phase.entityId,
      actorId: phase.actorId, mutationId: phase.mutationId, auditId: phase.auditId, preparedArtifact: prepared,
      response: body, responseTime: body.server_time, databaseTime: after.appState.updated_at, ...after,
      ...(uiParity ? { uiParity, pendingQueues } : {}) };
    const observedArtifact = await this.record({ phase: 'observed-command', ...observation });
    this.observations.push({ ...observation, observedArtifact });
    return receipt;
  }
  async setup(index) {
    const pair = this.pkg.pairs[index];
    const first = await this.executePhase(index * 5);
    const second = await this.executePhase(index * 5 + 1);
    await this.assertPair(pair, false);
    return { ...pair, index, receipts: [first, second] };
  }
  async freezeIntent(pair, index) { return structuredClone(this.pkg.manifest.intents[index]); }
  async reloadOrigin() { await this.pages.A.reload({ waitUntil: 'domcontentloaded' }); }
  async saveObserver(pair, intent) {
    const phase = this.pkg.phases[pair.index * 5 + 2];
    check(canonicalHash(phase.command) === canonicalHash(intent.payload), 'Measured request differs from frozen intent');
    return this.executePhase(pair.index * 5 + 2, true);
  }
  async assertPair(pair, edited) {
    const parity = {};
    await Promise.all(Object.entries(this.pages).map(async ([slot, page]) => { parity[slot] = {};
      for (const suffix of ['A', 'B']) {
      const station = pair[`station${suffix}`];
      const rows = this.latestRows.sessions.filter(row => row.station_id === pair[`stationId${suffix}`] && row.status !== 'closed');
      check(rows.length === 1 && rows[0].id === pair[suffix === 'A' ? 'aId' : 'bId'], 'Authoritative station/session mismatch');
      const card = page.locator('article.station-card').filter({ has: page.getByRole('heading', { name: station, exact: true }) });
      await expect(card).toHaveCount(1);
      await expect(card).toContainText(suffix === 'A' ? pair.customerA : edited ? pair.customerBAfter : pair.customerBBefore);
      await expect(card.getByRole('button', { name: 'Manage', exact: true })).toBeEnabled();
      await card.getByRole('button', { name: 'Manage', exact: true }).click();
      const modal = page.getByRole('dialog', { name: station, exact: true });
      await modal.getByRole('button', { name: 'Edit Customer Details', exact: true }).click();
      const field = modal.getByLabel('Customer Name', { exact: true });
      await expect(field).toHaveValue(rows[0].customer_name ?? '');
      await expect(modal.getByRole('button', { name: 'Save Session Details', exact: true })).toBeEnabled();
      parity[slot][suffix] = { sessionId: rows[0].id, customerName: await field.inputValue(), station };
      await modal.getByRole('button', { name: 'Close', exact: true }).click();
      }
    }));
    return parity;
  }
  async queues() {
    for (const page of Object.values(this.pages)) {
      await expect(page.getByText(/^Synced(?:\s|$)/).first()).toBeVisible();
      await expect(page.locator('.remote-error-banner, .inline-sync-warning')).toHaveCount(0);
      await expect(page.getByText('Cached read-only mode', { exact: true })).toHaveCount(0);
    }
    const read = page => page.evaluate(() => JSON.parse(localStorage.getItem('game-parlour-management-system/pending-operations/v1') ?? '[]'));
    const result = { origin: await read(this.pages.A), observer: await read(this.pages.B) };
    check(canonicalHash(result) === canonicalHash({ origin: [], observer: [] }), 'Pending operational queue'); return result;
  }
  async convergeAndReconcile(pair, intent, results) {
    const rows = await this.read('A', 'sessions', { organization_id: `eq.${ORG}`, id: `in.(${pair.aId},${pair.bId})` });
    check(rows.length === 2, 'Missing authoritative pair');
    this.latestRows = { ...this.latestRows, sessions: rows };
    const parity = await this.assertPair(pair, true); const pendingQueues = await this.queues(); check(this.errors.length === 0, 'Browser error or unexpected app write');
    check(canonicalHash(parity) === canonicalHash(this.pkg.phases[pair.index * 5 + 2].uiParity), 'UI parity differs from prepared expectation');
    check(results[1] === this.pending, 'Wrong measured response');
    this.pending.uiParity = parity; this.pending.pendingQueues = pendingQueues;
    return { deferredDatabaseEvidence: true, pendingQueuesEmpty: true, acknowledged: true, errorPriorityViolation: false,
      mutationId: intent.mutationId, actorId: intent.actorId, entityId: intent.entityId,
      parity };
  }
  async finalizeMeasured() { const pending = this.pending; this.pending = null; return { receipts: [await this.finalizePhase(pending)] }; }
  async cleanupReconciledPair(pair) {
    return { receipts: [await this.executePhase(pair.index * 5 + 3), await this.executePhase(pair.index * 5 + 4)] };
  }
  async postflight({ failed }) {
    const state = await this.snapshot();
    this.finalSnapshot = state;
    await this.record({ phase: 'postflight', failed, ...state });
    if (failed) return { status: 'safety-unverified', ownedIds: this.ownedIds,
      residueIds: state.protectedRows.sessions.filter(row => this.ownedIds.includes(row.id) && row.status !== 'closed').map(row => row.id),
      appStateHash: canonicalHash(state.appState), protectedRowsHash: canonicalHash(state.protectedRows) };
    check(this.phaseIndex === 250 && this.errors.length === 0, 'Incomplete execution');
    const expectedProtectedRows = compareGeneratedProtected(this.pkg.finalProtectedRows, state.protectedRows, this.bindings);
    return { appState: state.appState, expectedProtectedRows, actualProtectedRows: canonicalProtectedRows(state.protectedRows) };
  }
}
