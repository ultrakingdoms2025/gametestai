import * as OTPAuth from 'otpauth';

const ISSUER = 'AetherNexus Admin';

export function generateTotpSecret(): string {
  const secret = new OTPAuth.Secret({ size: 20 });
  return secret.base32;
}

/** otpauth:// URI — feed this to a QR code generator for setup. */
export function totpUri(username: string, secretBase32: string): string {
  const totp = new OTPAuth.TOTP({
    issuer:    ISSUER,
    label:     username,
    digits:    6,
    period:    30,
    algorithm: 'SHA1',
    secret:    OTPAuth.Secret.fromBase32(secretBase32),
  });
  return totp.toString();
}

/**
 * Verify a 6-digit TOTP code.
 * window: 1 allows ±1 time step (30 s each side) to handle clock skew.
 */
export function verifyTotp(secretBase32: string, token: string): boolean {
  const totp = new OTPAuth.TOTP({
    digits:    6,
    period:    30,
    algorithm: 'SHA1',
    secret:    OTPAuth.Secret.fromBase32(secretBase32),
  });
  return totp.validate({ token, window: 1 }) !== null;
}