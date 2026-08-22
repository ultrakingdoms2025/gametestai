import { auth } from './auth';
import { getUserById } from './db';
import { adminAllowlist, isAllowedAdminEmail } from './adminAllowlist';

/**
 * Marketplace admin authorisation.
 *
 * The allowlist decision lives in `./adminAllowlist`, which imports nothing, so
 * it can be tested without loading next-auth and `pg`. See that file for why an
 * unconfigured allowlist now denies everyone rather than allowing them.
 */

// The operator needs to know why the panel is shut; the caller must not. One
// line per process, so a scripted probe cannot flood the log.
let warnedUnconfigured = false;

function warnIfUnconfigured(): void {
  if (warnedUnconfigured || adminAllowlist().size > 0) return;
  warnedUnconfigured = true;
  console.warn(
    '[adminAccess] Marketplace admin is disabled because no allowlist is set. ' +
      'Set ADMIN_EMAILS (or MARKETPLACE_ADMIN_EMAILS) to a comma-separated list ' +
      'of administrator addresses to enable it.'
  );
}

export function isMarketplaceAdminEmail(email: string | null | undefined): boolean {
  return isAllowedAdminEmail(email);
}

export async function requireMarketplaceAdmin() {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) return null;
  const user = await getUserById(session.user.id);
  if (!user) return null;
  if (!isAllowedAdminEmail(user.email)) {
    warnIfUnconfigured();
    return null;
  }
  return { session, user };
}
