import { accountErrorResponse, requireAccount } from "@/lib/server/account-context";
import { deleteContact, read, saveContact } from "@/lib/server/account-store";
import { rejectNonLocal } from "@/lib/server/local-only";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The signed-in account's own contacts. */
export async function GET(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  try {
    const account = await requireAccount(request);
    return Response.json({ contacts: await read(account.accountId, "contacts") });
  } catch (error) {
    return accountErrorResponse(error) ?? Response.json({ error: "Could not load contacts." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  try {
    const account = await requireAccount(request);
    const body = (await request.json().catch(() => ({}))) as { name?: unknown; address?: unknown };
    if (typeof body.name !== "string" || typeof body.address !== "string") throw new Error("Send a name and an address.");
    return Response.json({ contact: await saveContact(account.accountId, body.name, body.address.trim()) });
  } catch (error) {
    return accountErrorResponse(error) ?? Response.json({ error: (error as Error).message }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  try {
    const account = await requireAccount(request);
    const name = new URL(request.url).searchParams.get("name") ?? "";
    await deleteContact(account.accountId, name);
    return Response.json({ ok: true });
  } catch (error) {
    return accountErrorResponse(error) ?? Response.json({ error: (error as Error).message }, { status: 400 });
  }
}
