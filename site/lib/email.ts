/**
 * Transactional email sender for the site.
 * Uses Resend if RESEND_API_KEY is configured; falls back to a console log in dev.
 */

const FROM = process.env.EMAIL_FROM ?? 'noreply@aethernexus.games';
const RESEND_KEY = process.env.RESEND_API_KEY;

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

  if (RESEND_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_KEY}`,
      },
      body: JSON.stringify({ from: FROM, to, subject, html }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Resend error ${res.status}: ${body}`);
    }
  } else {
    // Dev fallback — log to console
    console.log(`[email] To: ${to}\nSubject: ${subject}\nReset URL: ${resetUrl}`);
  }
}
