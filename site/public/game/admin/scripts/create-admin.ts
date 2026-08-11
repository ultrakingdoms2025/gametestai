/**
 * Non-interactive admin user creation.
 *
 *   npx tsx scripts/create-admin.ts <username> <password>
 *
 * Generates a TOTP secret, creates the admin user, and prints the
 * authenticator URI / QR code to stdout. Add the printed key to your
 * authenticator app before you lose it.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
config();

import bcrypt from 'bcryptjs';
import * as QRCode from 'qrcode';
import { initSchema, createAdminUser, findAdminByUsername } from '../lib/db';
import { encrypt } from '../lib/encrypt';
import { generateTotpSecret, totpUri } from '../lib/totp';

async function main() {
  const [, , username, password] = process.argv;

  if (!username || !password) {
    console.error('Usage: npx tsx scripts/create-admin.ts <username> <password>');
    process.exit(1);
  }
  if (password.length < 12) {
    console.error('Password must be at least 12 characters');
    process.exit(1);
  }

  console.log('\n=== AetherNexus Admin Setup ===\n');

  console.log('Initialising database schema…');
  await initSchema();
  console.log('Schema ready.\n');

  const existing = await findAdminByUsername(username);
  if (existing) {
    console.error(`Admin "${username}" already exists.`);
    process.exit(1);
  }

  const passwordHash  = await bcrypt.hash(password, 12);
  const totpSecret    = generateTotpSecret();
  const totpSecretEnc = encrypt(totpSecret);
  const uri           = totpUri(username, totpSecret);

  const adminId = await createAdminUser(username, passwordHash, totpSecretEnc);

  console.log(`✓ Admin user created (id: ${adminId})`);
  console.log('\n─── TOTP Setup ─────────────────────────────────────────');
  console.log('Add this key to your authenticator app (Google Auth, Authy, etc.)\n');
  console.log('Manual entry key (base32):');
  console.log(' ', totpSecret);
  console.log('\nURI (scan or paste into authenticator):');
  console.log(' ', uri);

  console.log('\nQR code:\n');
  const qr = await QRCode.toString(uri, { type: 'terminal', small: true });
  console.log(qr);

  console.log('────────────────────────────────────────────────────────');
  console.log('You can now start the server and sign in at /login.\n');

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
