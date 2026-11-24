// Proof that the signed-in user controls the wallet they want to link as their owner wallet.
//
// Without this, anyone could claim someone else's address and squat on it ("that wallet already
// belongs to another account"). The server issues a one-time message bound to the Google user and
// the address; the wallet signs it; the server verifies the signature against that address.
// zkLogin owners need no message: their address is derived server-side from their verified sign-in.

import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import { createSuiClient } from "@/lib/sui";
import { randomToken } from "./google-oauth";
import { seal, unseal, type SessionUser } from "./session";

const CHALLENGE_TTL_MS = 10 * 60 * 1000;

export type OwnerKind = "zklogin" | "wallet" | "browser";

export function isOwnerKind(value: unknown): value is OwnerKind {
  return value === "zklogin" || value === "wallet" || value === "browser";
}

export function linkMessage(input: { email: string; address: string; code: string }): string {
  return [
    "Link this wallet to your Cipher account.",
    "",
    `Account: ${input.email}`,
    `Wallet: ${input.address}`,
    `Code: ${input.code}`,
    "",
    "Signing this does not send a transaction or spend anything.",
  ].join("\n");
}

/** A message to sign plus a sealed token that remembers who it was issued to. */
export function issueLinkChallenge(user: SessionUser, address: string): { message: string; token: string } {
  const code = randomToken(12);
  const message = linkMessage({ email: user.email, address, code });
  return { message, token: seal({ purpose: "link-wallet", sub: user.sub, address, message }, CHALLENGE_TTL_MS) };
}

export class OwnerProofError extends Error {}

/**
 * Checks that `ownerAddress` belongs to this user. Throws OwnerProofError with a readable message
 * otherwise. `verify` is injectable for tests.
 */
export async function assertOwnerControl(
  user: SessionUser,
  input: { ownerAddress: string; ownerKind: OwnerKind; proof?: { token?: unknown; signature?: unknown } },
  verify: (message: Uint8Array, signature: string, address: string) => Promise<unknown> = (message, signature, address) =>
    verifyPersonalMessageSignature(message, signature, { address, client: createSuiClient() }),
): Promise<void> {
  if (input.ownerKind === "zklogin") {
    if (!user.zkAddress) throw new OwnerProofError("Your wallet session expired. Sign in with Google again.");
    if (user.zkAddress !== input.ownerAddress) throw new OwnerProofError("That is not your sign-in wallet.");
    return;
  }
  const token = typeof input.proof?.token === "string" ? input.proof.token : undefined;
  const signature = typeof input.proof?.signature === "string" ? input.proof.signature : undefined;
  const challenge = unseal(token);
  if (
    !challenge ||
    !signature ||
    challenge.purpose !== "link-wallet" ||
    challenge.sub !== user.sub ||
    challenge.address !== input.ownerAddress ||
    typeof challenge.message !== "string"
  ) {
    throw new OwnerProofError("Sign the link message with your wallet first.");
  }
  try {
    await verify(new TextEncoder().encode(challenge.message), signature, input.ownerAddress);
  } catch {
    throw new OwnerProofError("The wallet signature did not match that address.");
  }
}
