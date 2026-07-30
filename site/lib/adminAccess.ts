import { auth } from './auth';
import { getUserById } from './db';

function parseEmails(value: string | undefined): Set<string> {
  return new Set(
    String(value ?? '')
      .split(/[,\n;]+/g)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

const ADMIN_EMAILS = new Set([
  ...parseEmails(process.env.MARKETPLACE_ADMIN_EMAILS),
  ...parseEmails(process.env.ADMIN_EMAILS),
]);

export function isMarketplaceAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  // Bootstrap-safe default: when no allowlist is configured, any signed-in user
  // can access marketplace admin. Once env values are present, strict allowlist
  // checks apply.
  if (ADMIN_EMAILS.size === 0) return true;
  return ADMIN_EMAILS.has(email.trim().toLowerCase());
}

export async function requireMarketplaceAdmin() {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) return null;
  const user = await getUserById(session.user.id);
  if (!user) return null;
  if (!isMarketplaceAdminEmail(user.email)) return null;
  return { session, user };
}
