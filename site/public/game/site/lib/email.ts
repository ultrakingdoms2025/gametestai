/**
 * Transactional email sender for the site.
 * Uses Resend if RESEND_API_KEY is configured; falls back to a console log in dev.
 */

const FROM = process.env.EMAIL_FROM ?? 'noreply@aethernexus.games';
const RESEND_KEY = process.env.RESEND_API_KEY;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function appUrl(path = ''): string {
  const base =
    process.env.NEXT_PUBLIC_SITE_URL
    ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : null)
    ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
    ?? 'http://localhost:3000';
  return `${base.replace(/\/+$/, '')}${path}`;
}

async function sendEmail(opts: { to: string; subject: string; html: string; text: string }): Promise<void> {
  if (RESEND_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_KEY}`,
      },
      body: JSON.stringify({
        from: FROM,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Resend error ${res.status}: ${body}`);
    }
    return;
  }

  console.log(`[email]\nTo: ${opts.to}\nSubject: ${opts.subject}\n${opts.text}`);
}

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  const subject = 'Reset your Aether Nexus password';
  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 0">
      <h1 style="font-size:24px;margin-bottom:16px">Password reset</h1>
      <p>You requested a password reset for your Aether Nexus account.</p>
      <p>Click the link below to set a new password. The link expires in 1 hour.</p>
      <p style="margin:24px 0">
        <a href="${resetUrl}" style="background:#e0a82b;color:#000;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">
          Reset password
        </a>
      </p>
      <p style="color:#888;font-size:13px">
        If you didn't request this, ignore this email — your password is unchanged.
      </p>
    </div>
  `;

  await sendEmail({
    to,
    subject,
    html,
    text: `You requested a password reset for your Aether Nexus account.\n\nReset your password here: ${resetUrl}\n\nIf you didn't request this, you can ignore this email.`,
  });
}

export async function sendWelcomeEmail(to: string, handle: string): Promise<void> {
  const safeHandle = escapeHtml(handle);
  const accountUrl = appUrl('/account');
  const playUrl = appUrl('/play');
  const subject = 'Welcome to Aether Nexus';
  const html = `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px 0">
      <h1 style="font-size:24px;margin-bottom:16px">Welcome to Aether Nexus</h1>
      <p>Your account is ready, <strong>${safeHandle}</strong>.</p>
      <p>You can manage your profile, security settings, credits, and access from your account dashboard.</p>
      <p style="margin:24px 0">
        <a href="${accountUrl}" style="background:#e0a82b;color:#000;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;margin-right:8px;display:inline-block">
          Open account
        </a>
        <a href="${playUrl}" style="color:#e0a82b;text-decoration:none;font-weight:600;display:inline-block">
          Launch game
        </a>
      </p>
      <p style="color:#888;font-size:13px">
        If you did not create this account, please reset the password immediately or contact support.
      </p>
    </div>
  `;

  await sendEmail({
    to,
    subject,
    html,
    text: `Welcome to Aether Nexus, ${handle}.\n\nManage your account: ${accountUrl}\nLaunch the game: ${playUrl}`,
  });
}

export async function sendPurchaseConfirmationEmail(opts: {
  to: string;
  handle: string;
  type: 'access' | 'credits' | 'access+credits';
  amountCents: number;
  creditsAmount: number;
  orderId: string;
}): Promise<void> {
  const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const amount = formatter.format(Math.max(0, opts.amountCents) / 100);
  const safeHandle = escapeHtml(opts.handle);
  const accountUrl = appUrl('/account');

  const summary =
    opts.type === 'credits'
      ? `Credit purchase: ${opts.creditsAmount} credits`
      : opts.type === 'access+credits'
        ? `30 days of game access + ${opts.creditsAmount} credits`
        : '30 days of game access';

  const html = `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px 0">
      <h1 style="font-size:24px;margin-bottom:16px">Purchase confirmed</h1>
      <p>Thanks, <strong>${safeHandle}</strong>. Your Aether Nexus purchase has been recorded.</p>
      <div style="border:1px solid #2d3748;border-radius:8px;padding:16px;margin:24px 0">
        <p style="margin:0 0 8px"><strong>Order:</strong> ${escapeHtml(opts.orderId)}</p>
        <p style="margin:0 0 8px"><strong>Summary:</strong> ${escapeHtml(summary)}</p>
        <p style="margin:0"><strong>Total:</strong> ${escapeHtml(amount)}</p>
      </div>
      <p>You can review your credits, access status, and account details from your account page.</p>
      <p style="margin:24px 0">
        <a href="${accountUrl}" style="background:#e0a82b;color:#000;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">
          View account
        </a>
      </p>
    </div>
  `;

  await sendEmail({
    to: opts.to,
    subject: 'Your Aether Nexus purchase receipt',
    html,
    text: `Thanks, ${opts.handle}. Your purchase has been recorded.\n\nOrder: ${opts.orderId}\nSummary: ${summary}\nTotal: ${amount}\n\nView your account: ${accountUrl}`,
  });
}
