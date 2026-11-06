import { test } from '@playwright/test';
import path from 'node:path';
import { U1BrowserDatabaseAdapter, loadBrowserPackage } from '../../../scripts/u1-browser-database-adapter.mjs';
import { runBaselinePairs, U1_IDENTITY, U1_LIMITS } from '../../../scripts/u1-playwright-runner.mjs';
import { canonicalHash } from '../../../scripts/u1-data-reconciler.mjs';
import { createProtectedReader } from '../../../scripts/u1-protected-reader.mjs';

test('50 baseline reload-versus-unrelated-mutation pairs preserve parity and write availability', async ({ browser, page }) => {
  // --list is offline. Actual execution refuses missing admission before navigation.
  const pkg = loadBrowserPackage(process.env.U1_PACKAGE_FILE, process.env.U1_APPROVED_PACKAGE_SHA256);
  if (pkg.evidenceMode !== 'u1-supervised-numbered-v1') throw new Error('Supervised U1 evidence mode required before staging access');
  const protectedReader = createProtectedReader({ executable: pkg.readTool.path, executableSha256: pkg.readTool.sha256,
    password: process.env.U1_STAGING_DB_PASSWORD, user: process.env.U1_STAGING_DB_USER,
    sslRootCert: process.env.U1_STAGING_SSL_ROOT_CERT,
    scope: { sessionIds: pkg.pairs.flatMap(pair => [pair.aId, pair.bId]),
      customerIds: [...new Set(pkg.phases.map(phase => phase.generated.customerId).filter(Boolean))],
      customerNames: [...new Set(pkg.phases.map(phase => phase.command.payload.customer?.name).filter(Boolean))],
      auditIds: pkg.phases.map(phase => phase.auditId), mutationIds: pkg.phases.map(phase => phase.mutationId) } });
  const credentials = Object.fromEntries(['A', 'B'].map(slot => {
    const username = process.env[`U1_USER_${slot}`]; const password = process.env[`U1_PASSWORD_${slot}`];
    if (!username || !password) throw new Error('Missing staging-only QA credentials');
    return [slot, { username, password }];
  }));
  const observerContext = await browser.newContext({ locale: 'en-IN', timezoneId: 'Asia/Calcutta', serviceWorkers: 'block' });
  observerContext.setDefaultTimeout(U1_LIMITS.actionTimeout);
  observerContext.setDefaultNavigationTimeout(U1_LIMITS.navigationTimeout);
  const observer = await observerContext.newPage();
  try {
    const adapter = new U1BrowserDatabaseAdapter({ origin: page, observer, package: pkg, credentials, protectedReader,
      evidenceDirectory: path.resolve('test-artifacts', 'u1-evidence', pkg.manifest.runId) });
    await runBaselinePairs(adapter, { manifest: pkg.manifest, manifestHash: canonicalHash(pkg.manifest),
      discovery: [U1_IDENTITY], limits: U1_LIMITS });
  } finally { await observerContext.close(); }
});
