import { describe, it, expect, afterEach } from 'vitest';
import { isAllowedAdminEmail } from './adminAllowlist';

/**
 * The marketplace admin allowlist.
 *
 * This module exists because the check it replaces treated an EMPTY allowlist as
 * "allow everybody" — a bootstrap-safe default that, with neither env var set in
 * production, let any signed-in user create, edit and delete catalogue items and
 * set the buy/sell prices of the credit economy.
 *
 * The first two tests are the security fix. The rest pin behaviour that was
 * already correct, so the fix cannot quietly take it away.
 */

const KEYS = ['ADMIN_EMAILS', 'MARKETPLACE_ADMIN_EMAILS'] as const;
type Key = (typeof KEYS)[number];

const SAVED: Record<string, string | undefined> = Object.fromEntries(
  KEYS.map((k) => [k, process.env[k]])
);

function setEnv(values: Partial<Record<Key, string | undefined>>) {
  for (const key of KEYS) {
    const next = values[key];
    if (next === undefined) delete process.env[key];
    else process.env[key] = next;
  }
}

afterEach(() => {
  for (const key of KEYS) {
    const original = SAVED[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

describe('isAllowedAdminEmail', () => {
  it('denies everyone when no allowlist is configured', () => {
    setEnv({ ADMIN_EMAILS: undefined, MARKETPLACE_ADMIN_EMAILS: undefined });
    expect(isAllowedAdminEmail('anyone@example.com')).toBe(false);
  });

  it('denies everyone when the allowlist is present but holds no addresses', () => {
    setEnv({ ADMIN_EMAILS: '   ', MARKETPLACE_ADMIN_EMAILS: ',;\n' });
    expect(isAllowedAdminEmail('anyone@example.com')).toBe(false);
  });

  it('allows an address on the list', () => {
    setEnv({ ADMIN_EMAILS: 'owner@example.com' });
    expect(isAllowedAdminEmail('owner@example.com')).toBe(true);
  });

  it('denies an address that is not on the list', () => {
    setEnv({ ADMIN_EMAILS: 'owner@example.com' });
    expect(isAllowedAdminEmail('intruder@example.com')).toBe(false);
  });

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    setEnv({ ADMIN_EMAILS: '  Owner@Example.COM  ' });
    expect(isAllowedAdminEmail('owner@example.com')).toBe(true);
    expect(isAllowedAdminEmail('  OWNER@EXAMPLE.com ')).toBe(true);
  });

  it('denies null, undefined, empty and blank', () => {
    setEnv({ ADMIN_EMAILS: 'owner@example.com' });
    expect(isAllowedAdminEmail(null)).toBe(false);
    expect(isAllowedAdminEmail(undefined)).toBe(false);
    expect(isAllowedAdminEmail('')).toBe(false);
    expect(isAllowedAdminEmail('   ')).toBe(false);
  });

  it('merges both environment variables', () => {
    setEnv({ ADMIN_EMAILS: 'a@example.com', MARKETPLACE_ADMIN_EMAILS: 'b@example.com' });
    expect(isAllowedAdminEmail('a@example.com')).toBe(true);
    expect(isAllowedAdminEmail('b@example.com')).toBe(true);
    expect(isAllowedAdminEmail('c@example.com')).toBe(false);
  });

  it('splits on commas, semicolons and newlines', () => {
    setEnv({ ADMIN_EMAILS: 'a@example.com, b@example.com;c@example.com\nd@example.com' });
    for (const who of ['a', 'b', 'c', 'd']) {
      expect(isAllowedAdminEmail(`${who}@example.com`)).toBe(true);
    }
    expect(isAllowedAdminEmail('e@example.com')).toBe(false);
  });

  it('reads the environment on every call, so a change needs no module reload', () => {
    setEnv({ ADMIN_EMAILS: 'first@example.com' });
    expect(isAllowedAdminEmail('second@example.com')).toBe(false);

    setEnv({ ADMIN_EMAILS: 'second@example.com' });
    expect(isAllowedAdminEmail('second@example.com')).toBe(true);
    expect(isAllowedAdminEmail('first@example.com')).toBe(false);
  });

  it('does not treat a substring or a lookalike domain as a match', () => {
    setEnv({ ADMIN_EMAILS: 'owner@example.com' });
    expect(isAllowedAdminEmail('owner@example.com.evil.net')).toBe(false);
    expect(isAllowedAdminEmail('notowner@example.com')).toBe(false);
    expect(isAllowedAdminEmail('owner@example.co')).toBe(false);
  });
});
