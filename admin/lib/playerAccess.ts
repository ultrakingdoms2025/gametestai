const ACCESS_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export type PlayerAccessSnapshot = {
  grantedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
  hasActiveAccess: boolean;
  isExpired: boolean;
  isRevoked: boolean;
  daysRemaining: number;
  statusLabel: 'Active' | 'Expired' | 'Revoked' | 'None';
};

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function computePlayerAccessSnapshot(player: {
  access_granted_at?: unknown;
  access_revoked_at?: unknown;
}): PlayerAccessSnapshot {
  const grantedAt = parseDate(player.access_granted_at);
  const revokedAt = parseDate(player.access_revoked_at);

  if (!grantedAt) {
    return {
      grantedAt: null,
      revokedAt,
      expiresAt: null,
      hasActiveAccess: false,
      isExpired: false,
      isRevoked: !!revokedAt,
      daysRemaining: 0,
      statusLabel: revokedAt ? 'Revoked' : 'None',
    };
  }

  const expiresAt = new Date(grantedAt.getTime() + ACCESS_WINDOW_DAYS * DAY_MS);
  const isRevoked = !!revokedAt;
  const isExpired = !isRevoked && Date.now() >= expiresAt.getTime();
  const hasActiveAccess = !isRevoked && !isExpired;
  const daysRemaining = hasActiveAccess
    ? Math.ceil((expiresAt.getTime() - Date.now()) / DAY_MS)
    : 0;

  return {
    grantedAt,
    revokedAt,
    expiresAt,
    hasActiveAccess,
    isExpired,
    isRevoked,
    daysRemaining,
    statusLabel: isRevoked ? 'Revoked' : isExpired ? 'Expired' : 'Active',
  };
}

export function grantedAtForRemainingDays(daysRemaining: number): Date {
  return new Date(Date.now() - ((ACCESS_WINDOW_DAYS - daysRemaining) * DAY_MS));
}
