import { signerHost, signerPort, signerTimeoutMs, signerToken, signResponse } from "./protocol.js";
import type { signRequest } from "./protocol.js";
import type { z } from "zod";

export async function requestSignature(input: z.infer<typeof signRequest>): Promise<string> {
  const token = signerToken.safeParse(process.env.SUI_SIGNER_TOKEN);
  if (!token.success) throw new Error("Configure SUI_SIGNER_TOKEN to use the testnet signer.");
  const response = await fetch(`http://${signerHost}:${signerPort()}/sign`, {
    method: "POST",
    headers: { authorization: `Bearer ${token.data}`, "content-type": "application/json" },
    body: JSON.stringify(input),
    redirect: "error",
    signal: AbortSignal.timeout(signerTimeoutMs),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const code = typeof result === "object" && result && "error" in result ? result.error : response.status;
    throw new Error(`Signer rejected proposal ${input.proposalId}: ${code}`);
  }
  const signed = signResponse.parse(result);
  if (signed.proposalId !== input.proposalId) throw new Error("Signer returned the wrong proposal ID.");
  return signed.signature;
}
