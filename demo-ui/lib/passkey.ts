"use client";

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

export type PasskeyStatus = {
  registered: boolean;
  credentialCount: number;
  revoked: boolean;
  recoveryPending?: boolean;
};

async function json<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) throw new Error(body.error ?? `Passkey request failed (${response.status}).`);
  return body;
}

export async function getPasskeyStatus(): Promise<PasskeyStatus> {
  return json<PasskeyStatus>("/api/passkey/status", { method: "GET", headers: {} });
}

export async function registerPasskey(recoveryToken?: string): Promise<void> {
  const status = await getPasskeyStatus();
  const approval = status.registered
    ? await approveProposal(await hashProposal({ action: "register-passkey", network: "testnet" }))
    : undefined;
  const { challengeId, options } = await json<{ challengeId: string; options: Parameters<typeof startRegistration>[0]["optionsJSON"] }>(
    "/api/passkey/register/options",
    { method: "POST", body: JSON.stringify({ approvalId: approval?.approvalId, recoveryToken }) },
  );
  const response = await startRegistration({ optionsJSON: options });
  await json("/api/passkey/register/verify", {
    method: "POST",
    body: JSON.stringify({ challengeId, response }),
  });
}

export async function approveProposal(proposalHash: string): Promise<{ approvalId: string }> {
  const { challengeId, options } = await json<{ challengeId: string; options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>(
    "/api/passkey/auth/options",
    { method: "POST", body: JSON.stringify({ proposalHash }) },
  );
  const response = await startAuthentication({ optionsJSON: options });
  const result = await json<{ approvalId: string; proposalHash: string }>("/api/passkey/auth/verify", {
    method: "POST",
    body: JSON.stringify({ challengeId, response }),
  });
  if (result.proposalHash !== proposalHash) throw new Error("Passkey approval was bound to different action data.");
  return { approvalId: result.approvalId };
}

export async function setPasskeyRevoked(approvalId: string, proposalHash: string, revoked: boolean): Promise<void> {
  await json("/api/passkey/control", {
    method: "POST",
    body: JSON.stringify({ approvalId, proposalHash, revoked }),
  });
}

export async function hashProposal(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type RegisteredPasskey = { id: string; label: string; createdAt: string };
export async function listPasskeys(): Promise<RegisteredPasskey[]> {
  const { approvalId } = await approveProposal(await hashProposal({ action: "list-passkeys" }));
  const result = await json<{ credentials: RegisteredPasskey[] }>("/api/passkey/credentials",
    { method: "POST", body: JSON.stringify({ action: "list", approvalId }) });
  return result.credentials;
}
export async function removePasskey(id: string): Promise<void> {
  const { approvalId } = await approveProposal(await hashProposal({ action: "remove-passkey", id }));
  await json("/api/passkey/credentials", { method: "POST", body: JSON.stringify({ action: "remove", id, approvalId }) });
}
export async function recoverPasskeys(code: string): Promise<string> {
  const result = await json<{ recoveryToken: string }>("/api/passkey/recover", { method: "POST", body: JSON.stringify({ code }) });
  return result.recoveryToken;
}
