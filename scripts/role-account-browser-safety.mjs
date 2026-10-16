import {setTimeout, clearTimeout} from 'node:timers';

export const SIGN_IN_STAGES = ['navigation', 'username-fill', 'password-fill', 'submit', 'dashboard', 'sync', 'authenticated-request-capture'];
export const SYNCED_LABEL = /^Synced(?:\s|$)/;

export function authStatusFromResponse(response, projectRef) {
  try {
    const url = new URL(response.url());
    if (url.origin !== `https://${projectRef}.supabase.co` || url.pathname !== '/auth/v1/token'
      || url.searchParams.get('grant_type') !== 'password' || response.request().method() !== 'POST') return null;
    const status = response.status();
    return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  } catch { return null; }
}

export async function runSignInStages(actions, diagnostic) {
  for (const stage of SIGN_IN_STAGES) {
    diagnostic.substage = stage;
    try { await actions[stage](); }
    catch (error) {
      diagnostic.outcome = 'failed';
      diagnostic.errorCode = error?.name === 'TimeoutError' ? 'timeout' : 'operation_failed';
      throw error;
    }
  }
  diagnostic.outcome = 'passed';
}

export async function closeBounded(resource, timeoutMs = 3000) {
  if (!resource) return {status: 'fulfilled', code: 'not_created'};
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => resource.close()),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('cleanup_timeout')), timeoutMs); })
    ]);
    return {status: 'fulfilled', code: 'closed'};
  } catch { return {status: 'rejected', code: 'close_failed_or_timed_out'}; }
  finally { clearTimeout(timer); }
}

export async function withBoundedContext(context, action, recordCleanup, timeoutMs = 3000) {
  let result, primary, failed = false;
  try { result = await action(context); }
  catch (error) { primary = error; failed = true; }
  const cleanup = await closeBounded(context, timeoutMs);
  recordCleanup(cleanup);
  if (failed) throw primary;
  if (cleanup.status !== 'fulfilled') throw new Error('Role verification context cleanup failed closed.');
  return result;
}

export async function closeBrowserResources(context, browser, timeoutMs = 3000) {
  const contextResult = await closeBounded(context, timeoutMs);
  const browserResult = await closeBounded(browser, timeoutMs);
  return [contextResult, browserResult];
}
