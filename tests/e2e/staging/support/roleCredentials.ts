import type { StagingCredentials } from './app';

export function roleCredentials(role: 'receptionist' | 'manager'): StagingCredentials {
  const prefix = `E2E_${role.toUpperCase()}`;
  const username = process.env[`${prefix}_USER`]?.trim();
  const password = process.env[`${prefix}_PASSWORD`];
  if (!username || !password?.trim()) throw new Error('Missing dedicated staging role credentials.');
  return { username, password };
}
