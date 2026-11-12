import { z } from "zod";

export const signerHost = "127.0.0.1";
export const defaultSignerPort = 38435;
export const signerTimeoutMs = 5_000;
export const maxRequestBytes = 192 * 1024;

export function signerPort(value = process.env.SUI_SIGNER_PORT): number {
  return z.coerce.number().int().min(1).max(65535).parse(value ?? defaultSignerPort);
}

export const signerToken = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const transactionBytes = z.string().min(4).max(180_000).regex(/^[A-Za-z0-9+/]+={0,2}$/);

export const signRequest = z.strictObject({
  network: z.literal("testnet"),
  proposalId: identifier,
  transactionBytes,
  policyDecision: z.strictObject({ id: identifier, allowed: z.literal(true) }),
});

export const approvalRecord = signRequest.extend({
  expiresAtMs: z.number().int().positive(),
});

export const signResponse = z.strictObject({
  proposalId: identifier,
  signature: z.string().min(1),
});
