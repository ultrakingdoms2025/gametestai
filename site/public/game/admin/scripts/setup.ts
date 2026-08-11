/**
 * Run once to initialise the database schema and create the first admin user.
 *
 *   npx tsx scripts/setup.ts
 *
 * Requires POSTGRES_URL, ENCRYPTION_KEY, HMAC_SECRET, SESSION_SECRET in .env.local
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
config(); // also load .env as fallback
import bcrypt from 'bcryptjs';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import * as QRCode from 'qrcode';
import { initSchema, createAdminUser, findAdminByUsername } from '../lib/db';
import { encrypt } from '../lib/encrypt';
import { generateTotpSecret, totpUri } from '../lib/totp';

const rl = readline.createInterface({ input, output });

async function main() {
  console.log('\n=== AetherNexus Admin Setup ===\n');

  console.log('Initialising database schema…');
  await initSchema();
  console.log('Schema ready.\n');

  const username = (await rl.question('Admin username: ')).trim();
  if (!username) { console.error('Username required'); process.exit(1); }

  const existing = await findAdminByUsername(username);
  if (existing) { console.error(`Admin "${username}" already exists.`); process.exit(1); }

  const password  = (await rl.question('Password (min 12 chars): ')).trim();
  if (password.length < 12) { console.error('Password too short'); process.exit(1); }

  const confirm  = (await rl.question('Confirm password: ')).trim();
  if (password !== confirm) { console.error('Passwords do not match'); process.exit(1); }

  const passwordHash = await bcrypt.hash(password, 12);
  const totpSecret   = generateTotpSecret();
  const totpSecretEnc = encrypt(totpSecret);
  const uri           = totpUri(username, totpSecret);

  console.log('\n─── TOTP Setup ────────────────────────────────────────');
  console.log('Scan this QR code in your authenticator app:\n');

  const qr = await QRCode.toString(uri, { type: 'terminal', small: true });
  console.log(qr);
  console.log('\nManual entry key (base32):');
  console.log(' ', totpSecret);
  console.log('\nURI:', uri);
  console.log('────────────────────────────────────────────────────────\n');

  await rl.question('Press Enter once you have added the account to your authenticator… ');

  const { verifyTotp } = await import('../lib/totp');
  const code = (await rl.question('Enter the 6-digit code to confirm: ')).trim();
  if (!verifyTotp(totpSecret, code)) {
    console.error('TOTP code incorrect. Re-run setup and try again.');
    process.exit(1);
  }

  const adminId = await createAdminUser(username, passwordHash, totpSecretEnc);
  console.log(`\n✓ Admin user created (id: ${adminId})`);
  console.log('You can now start the server and sign in at /login.\n');

  rl.close();
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });