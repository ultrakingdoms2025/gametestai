import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { listAudit, verifyAuditChain, audit } from '@/lib/db';
import { z } from 'zod';

const qSchema = z.object({ page: z.coerce.number().int().min(0).default(0) });

export async function GET(req: NextRequest) {
  const { username } = await requireSession();
  const { page } = qSchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  const rows = await listAudit(page);
  return NextResponse.json({ rows });
}

export async function POST(req: NextRequest) {
  // Verify chain integrity endpoint
  const { username } = await requireSession();
  const result = await verifyAuditChain();
  await audit(username, 'audit.verify_chain', 'audit_log',
              result.valid ? 'chain_ok' : `chain_broken_at_seq_${result.brokenAt}`);
  return NextResponse.json(result);
}