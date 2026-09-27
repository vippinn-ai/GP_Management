import { afterEach, describe, expect, it } from 'vitest';
import { roleCredentials } from '../../tests/e2e/staging/support/roleCredentials';
const keys = ['E2E_RECEPTIONIST_USER', 'E2E_RECEPTIONIST_PASSWORD', 'E2E_MANAGER_USER', 'E2E_MANAGER_PASSWORD', 'E2E_USER_A', 'E2E_PASSWORD_A'] as const;
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
afterEach(() => { for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; } });
describe('dedicated role credentials', () => {
  it('never falls back to generic admin credentials', () => {
    for (const key of keys) delete process.env[key];
    process.env.E2E_USER_A = 'admin'; process.env.E2E_PASSWORD_A = 'secret';
    expect(() => roleCredentials('receptionist')).toThrow();
    expect(() => roleCredentials('manager')).toThrow();
  });
  it('selects exact role without exposing or trimming password', () => {
    process.env.E2E_RECEPTIONIST_USER = 'rec'; process.env.E2E_RECEPTIONIST_PASSWORD = ' p ';
    process.env.E2E_MANAGER_USER = 'mgr'; process.env.E2E_MANAGER_PASSWORD = 'm';
    expect(roleCredentials('receptionist')).toEqual({ username: 'rec', password: ' p ' });
    expect(roleCredentials('manager')).toEqual({ username: 'mgr', password: 'm' });
    process.env.E2E_MANAGER_PASSWORD = '';
    expect(() => roleCredentials('manager')).toThrow();
  });
});
