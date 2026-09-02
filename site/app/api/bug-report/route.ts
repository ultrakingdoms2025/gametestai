import { NextResponse, NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { RATE_LIMITS, clientIp, consumeRateLimit, tooManyRequests } from '@/lib/rateLimit';

/**
 * The in-game bug reporter.
 *
 * ── What it was ──────────────────────────────────────────────────────────
 *
 * An unauthenticated open mail relay. No session, no limit: anyone who found
 * the path could POST 4,000 characters of anything and have this domain deliver
 * it, as often as they liked, to a fixed inbox. Two costs, and the second is the
 * one that lasts — the inbox is unusable while it is happening, and the sending
 * domain's reputation is spent, so the password-reset mail that matters stops
 * being delivered.
 *
 * ── What it is now ───────────────────────────────────────────────────────
 *
 * A session is required. The reporter is opened from inside the game, which is
 * behind the paywall and behind the launch cookie, so every legitimate caller
 * already has one — this costs no real reporter anything. And the report
 * carries the signed-in address rather than a `handle` field out of the body,
 * so a report can actually be replied to and cannot be attributed to someone
 * else.
 */

const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.EMAIL_FROM ?? 'noreply@aethernexus.games';
const BUG_REPORT_TO = 'markc@cayc.io';

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });
  }

  const verdict = await consumeRateLimit(
    'bug-report',
    [
      { namespace: 'user', value: session.user.id },
      { namespace: 'ip', value: clientIp(request) },
    ],
    RATE_LIMITS.bugReport
  );
  if (!verdict.allowed) {
    return tooManyRequests(verdict, 'Too many bug reports. Try again shortly.');
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 });
  }

  const description = String(body.description ?? '').trim();
  if (!description) {
    return NextResponse.json({ error: 'Description is required.' }, { status: 400 });
  }

  const world    = String(body.world    ?? 'unknown').slice(0, 64);
  const position = String(body.position ?? 'unknown').slice(0, 128);
  /* The handle the client sent is kept for context, but the SESSION's address
   * is what identifies the reporter. A body field alone let one player file a
   * report under another's name, and left every report unanswerable. */
  const claimedHandle = String(body.handle ?? '').slice(0, 64);
  const account  = String(session.user.email ?? session.user.id).slice(0, 200);
  const handle   = claimedHandle ? `${claimedHandle} <${account}>` : account;
  const safeDesc = description.slice(0, 4000);

  const subject = `[Bug Report] ${world} — ${handle}`;

  const htmlBody = `
    <div style="font-family:sans-serif;max-width:640px;margin:0 auto;padding:32px 0;color:#cfe6f2;background:#0a0f1a">
      <h1 style="font-size:22px;margin-bottom:4px;color:#52e9ff">Aether Nexus — Bug Report</h1>
      <p style="margin:0 0 24px;color:#7f9db0;font-size:13px">Submitted in-game via F12</p>
      <table style="border-collapse:collapse;width:100%;margin-bottom:24px">
        <tr><td style="padding:6px 12px;border:1px solid #1e3040;font-weight:600;width:100px;color:#ffb44a">Player</td>
            <td style="padding:6px 12px;border:1px solid #1e3040">${escapeHtml(handle)}</td></tr>
        <tr><td style="padding:6px 12px;border:1px solid #1e3040;font-weight:600;color:#ffb44a">World</td>
            <td style="padding:6px 12px;border:1px solid #1e3040">${escapeHtml(world)}</td></tr>
        <tr><td style="padding:6px 12px;border:1px solid #1e3040;font-weight:600;color:#ffb44a">Position</td>
            <td style="padding:6px 12px;border:1px solid #1e3040"><code>${escapeHtml(position)}</code></td></tr>
      </table>
      <h2 style="font-size:16px;margin-bottom:8px;color:#52e9ff">Description</h2>
      <div style="background:#0d1926;border:1px solid #1e3040;border-radius:6px;padding:16px;white-space:pre-wrap;font-size:14px;line-height:1.6">
        ${escapeHtml(safeDesc).replace(/\n/g, '<br>')}
      </div>
      <p style="margin-top:24px;color:#7f9db0;font-size:12px">Aether Nexus · In-game bug reporter</p>
    </div>
  `;

  const textBody = [
    'AETHER NEXUS — BUG REPORT',
    '',
    `Player:   ${handle}`,
    `World:    ${world}`,
    `Position: ${position}`,
    '',
    'Description:',
    safeDesc,
    '',
    '---',
    'Submitted via F12 in-game bug reporter.',
  ].join('\n');

  if (RESEND_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_KEY}`,
      },
      body: JSON.stringify({ from: FROM, to: BUG_REPORT_TO, subject, html: htmlBody, text: textBody }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error(`[bug-report] Resend error ${res.status}: ${errBody}`);
      return NextResponse.json({ error: 'Email delivery failed. Please try again.' }, { status: 502 });
    }
  } else {
    // Dev fallback — log instead of sending
    console.log(`[bug-report]\nTo: ${BUG_REPORT_TO}\nSubject: ${subject}\n${textBody}`);
  }

  return NextResponse.json({ ok: true });
}
