// Asks the isolated signer daemon to mint a fresh agent key for a new account. Only the public
// address comes back. The secret never leaves the signer, which is the same trust boundary
// that already protects the single-wallet setup.

const SIGNER_HOST = "127.0.0.1";
const TIMEOUT_MS = 5_000;

export async function provisionAgentAddress(): Promise<string> {
  const token = process.env.SUI_SIGNER_TOKEN ?? "";
  if (!/^[a-f0-9]{64}$/.test(token)) {
    throw new Error("Set SUI_SIGNER_TOKEN (the same value the signer uses) to create accounts.");
  }
  const port = process.env.SUI_SIGNER_PORT ?? "38435";
  let response: Response;
  try {
    response = await fetch(`http://${SIGNER_HOST}:${port}/provision`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Error(`The signer is not reachable on ${SIGNER_HOST}:${port}. Start it with npm run signer in wallet-mcp.`);
  }
  const body = (await response.json().catch(() => ({}))) as { address?: unknown; error?: unknown };
  if (!response.ok) {
    throw new Error(`The signer refused to create an agent key (${String(body.error ?? response.status)}).`);
  }
  if (typeof body.address !== "string" || !/^0x[0-9a-f]{64}$/.test(body.address)) {
    throw new Error("The signer returned an invalid agent address.");
  }
  return body.address;
}
