import { NextRequest, NextResponse } from 'next/server';
import { createHmac, randomBytes } from 'node:crypto';
import { toDataURL } from 'qrcode';
import { auth } from '@/lib/auth';
import { getUserById, setTotpSecret } from '@/lib/db';

// Minimal TOTP (RFC 6238) without external libs
function base32Encode(buf: Buffer): string {
  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0, output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += CHARS[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += CHARS[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input: string): Buffer {
  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const output: number[] = [];
  for (const char of input.toUpperCase().replace(/=+$/, '')) {
    const idx = CHARS.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { output.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(output);
}

function totp(secret: string, window = 0): string {
  const key = base32Decode(secret);
  const counter = Math.floor(Date.now() / 30000) + window;
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24 | hmac[offset + 1] << 16 | hmac[offset + 2] << 8 | hmac[offset + 3]) % 1000000;
  return code.toString().padStart(6, '0');
}

function verifyTotp(secret: string, token: string): boolean {
  for (let w = -1; w <= 1; w++) {
    if (totp(secret, w) === token) return true;
  }
  return false;
}

function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  const secret = generateTotpSecret();
  const user = await getUserById(session.user.id);
  if (!user) return NextResponse.json({ error: 'User not found.' }, { status: 404 });

  const otpauth = `otpauth://totp/Aether%20Nexus:${encodeURIComponent(user.email)}?secret=${secret}&issuer=Aether%20Nexus`;
  const qrDataUrl = await toDataURL(otpauth);

  // Store secret temporarily — user confirms with a code before we mark totp_enabled=true
  await setTotpSecret(session.user.id, secret, false);

  return NextResponse.json({ secret, qrDataUrl });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  const { code } = await req.json();
  if (!code || typeof code !== 'string') {
    return NextResponse.json({ error: 'Code is required.' }, { status: 400 });
  }

  const user = await getUserById(session.user.id);
  if (!user?.totp_secret) return NextResponse.json({ error: 'Setup not started.' }, { status: 400 });

  const valid = verifyTotp(user.totp_secret, code.trim());
  if (!valid) return NextResponse.json({ error: 'Invalid code. Try again.' }, { status: 400 });

  await setTotpSecret(session.user.id, user.totp_secret, true);
  return NextResponse.json({ ok: true });
}
