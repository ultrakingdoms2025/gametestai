import { NextResponse, NextRequest } from 'next/server';

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
  const handle   = String(body.handle   ?? 'anonymous').slice(0, 64);
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
