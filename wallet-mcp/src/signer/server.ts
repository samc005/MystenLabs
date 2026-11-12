import { timingSafeEqual } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { bcs } from "@mysten/sui/bcs";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  approvalRecord,
  maxRequestBytes,
  signerTimeoutMs,
  signerToken,
  signRequest,
} from "./protocol.js";

class Refusal extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

async function readRequest(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    signal.throwIfAborted();
    size += chunk.length;
    if (size > maxRequestBytes) throw new Refusal(413, "request_too_large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Refusal(400, "invalid_json");
  }
}

export function createSignerServer(options: {
  token: string;
  stateDir: string;
  chainIdentifier: string;
  keypair: Ed25519Keypair;
  getCurrentEpoch: (signal: AbortSignal) => Promise<bigint>;
}) {
  const token = Buffer.from(`Bearer ${signerToken.parse(options.token)}`);
  const address = options.keypair.toSuiAddress();

  async function sign(request: IncomingMessage, signal: AbortSignal) {
    if (request.method !== "POST" || request.url !== "/sign") {
      throw new Refusal(404, "unknown_endpoint");
    }
    const authorization = Buffer.from(request.headers.authorization ?? "");
    if (authorization.length !== token.length || !timingSafeEqual(authorization, token)) {
      throw new Refusal(401, "unauthorized");
    }
    if (request.headers["content-type"] !== "application/json") {
      throw new Refusal(415, "expected_json");
    }
    const body = await readRequest(request, signal);
    if (typeof body === "object" && body !== null && "network" in body && body.network !== "testnet") {
      throw new Refusal(403, "wrong_network");
    }
    const parsed = signRequest.safeParse(body);
    if (!parsed.success) throw new Refusal(400, "invalid_signing_request");

    const { proposalId, transactionBytes, policyDecision } = parsed.data;
    const rawApproval = await readFile(join(options.stateDir, "approvals", `${proposalId}.json`), {
      encoding: "utf8",
      signal,
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new Refusal(403, "approval_required");
      throw error;
    });
    let stored: unknown;
    try {
      stored = JSON.parse(rawApproval);
    } catch {
      throw new Refusal(403, "approval_mismatch");
    }
    const approval = approvalRecord.safeParse(stored);
    if (
      !approval.success ||
      approval.data.proposalId !== proposalId ||
      approval.data.transactionBytes !== transactionBytes ||
      approval.data.policyDecision.id !== policyDecision.id
    ) {
      throw new Refusal(403, "approval_mismatch");
    }
    if (approval.data.expiresAtMs <= Date.now()) throw new Refusal(403, "approval_expired");

    const bytes = Buffer.from(transactionBytes, "base64");
    if (bytes.toString("base64") !== transactionBytes) {
      throw new Refusal(400, "invalid_transaction_bytes");
    }
    let expiration;
    try {
      const data = bcs.TransactionData.parse(bytes);
      if (!bytes.equals(bcs.TransactionData.serialize(data).toBytes())) throw new Error();
      const { kind, sender, gasData } = data.V1;
      expiration = data.V1.expiration.ValidDuring;
      if (
        !kind.ProgrammableTransaction ||
        sender !== address ||
        gasData.owner !== address ||
        expiration?.chain !== options.chainIdentifier ||
        expiration.minEpoch === null ||
        expiration.maxEpoch === null
      ) {
        throw new Refusal(403, "transaction_outside_signer_scope");
      }
    } catch (error) {
      if (error instanceof Refusal) throw error;
      throw new Refusal(400, "invalid_transaction_bytes");
    }

    const epoch = await options.getCurrentEpoch(signal);
    const minEpoch = BigInt(expiration.minEpoch);
    const maxEpoch = BigInt(expiration.maxEpoch);
    if (minEpoch > epoch || maxEpoch < epoch || maxEpoch > minEpoch + 1n) {
      throw new Refusal(403, "transaction_outside_epoch_window");
    }

    // Claim before signing. An interrupted request needs a new approval, and
    // concurrent requests or daemon restarts cannot reuse the same proposal ID.
    signal.throwIfAborted();
    if (approval.data.expiresAtMs <= Date.now()) throw new Refusal(403, "approval_expired");
    await mkdir(join(options.stateDir, "consumed", proposalId), { mode: 0o700 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") throw new Refusal(409, "proposal_already_consumed");
        throw error;
      },
    );
    signal.throwIfAborted();
    if (approval.data.expiresAtMs <= Date.now()) throw new Refusal(403, "approval_expired");
    const { signature } = await options.keypair.signTransaction(bytes);
    return { proposalId, signature };
  }

  return createServer({ headersTimeout: signerTimeoutMs, requestTimeout: signerTimeoutMs },
    (request: IncomingMessage, response: ServerResponse) => {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
        response.destroy();
      }, signerTimeoutMs);
      response.once("close", () => {
        clearTimeout(timer);
        controller.abort();
      });
      function send(status: number, body: unknown) {
        if (response.destroyed) return;
        response.writeHead(status, { "content-type": "application/json", connection: "close" });
        response.end(JSON.stringify(body));
      }
      void sign(request, controller.signal).then(
        (result) => send(200, result),
        (error: unknown) => {
          if (error instanceof Refusal) send(error.status, { error: error.code });
          else send(500, { error: "signer_failure" });
        },
      );
    },
  );
}
