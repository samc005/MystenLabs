import { rejectNonLocal } from '@/lib/server/local-only';
import { executePrepared } from '@/lib/server/wallet-execution';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  try {
    const { id, approvalId } = await request.json();
    if (typeof id !== 'string' || typeof approvalId !== 'string') throw new Error('Transaction and passkey approval required.');
    const result = await executePrepared(id, approvalId);
    return Response.json(result, { status: result.isError ? 400 : 200 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Execution refused.' }, { status: 403 });
  }
}
