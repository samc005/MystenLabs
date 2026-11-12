import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { proposalsDir } from "../config.js";

/**
 * A trade the agent has proposed in chat, waiting for the owner.
 *
 *   pending  -> the owner has not decided yet (expires after APPROVAL_WINDOW_MS)
 *   approved -> the owner signed create_intent; the agent may now run it
 *   executed -> the agent ran the swap
 *   rejected / expired / failed -> terminal
 *
 * The status here is only for display and bookkeeping. What actually authorizes a swap
 * is the on-chain Intent that approving creates: with no intent, the contract aborts.
 */
export type ProposalStatus = "pending" | "approved" | "rejected" | "expired" | "executed" | "failed";

export interface Proposal {
  id: string;
  status: ProposalStatus;
  createdAtMs: number;
  /** After this the owner can no longer approve. */
  approvalDeadlineMs: number;
  dex: string;
  inType: string;
  outType: string;
  inSymbol: string;
  outSymbol: string;
  inDecimals: number;
  outDecimals: number;
  /** All amounts are raw integers in each coin's smallest unit, as decimal strings. */
  amountIn: string;
  quotedOut: string;
  minOut: string;
  slippageBps: number;
  /** How long the on-chain intent stays valid once approved. */
  intentTtlMs: number;
  intentId?: string;
  intentExpiryMs?: number;
  approvalDigest?: string;
  swapDigest?: string;
  amountOut?: string;
  error?: string;
}

/** How long the owner has to approve a proposal. */
export const APPROVAL_WINDOW_MS = 10 * 60 * 1000;
/** How long an approved trade can be executed on-chain. */
export const INTENT_TTL_MS = 5 * 60 * 1000;

const ID_PATTERN = /^prop_[0-9a-f]{10}$/;

export function isProposalId(value: string): boolean {
  return ID_PATTERN.test(value);
}

function fileFor(id: string): string {
  if (!isProposalId(id)) throw new Error(`Not a proposal ID: ${id}`);
  return join(proposalsDir(), `${id}.json`);
}

/** A pending proposal past its deadline reads as expired, even if nothing rewrote the file. */
function withEffectiveStatus(proposal: Proposal, now = Date.now()): Proposal {
  if (proposal.status === "pending" && now > proposal.approvalDeadlineMs) {
    return { ...proposal, status: "expired" };
  }
  if (proposal.status === "approved" && proposal.intentExpiryMs && now > proposal.intentExpiryMs) {
    return { ...proposal, status: "expired" };
  }
  return proposal;
}

async function write(proposal: Proposal): Promise<void> {
  await mkdir(proposalsDir(), { recursive: true });
  const target = fileFor(proposal.id);
  const temp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, `${JSON.stringify(proposal, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, target);
}

export async function createProposal(
  fields: Omit<Proposal, "id" | "status" | "createdAtMs" | "approvalDeadlineMs" | "intentTtlMs">,
): Promise<Proposal> {
  const now = Date.now();
  const proposal: Proposal = {
    ...fields,
    id: `prop_${randomBytes(5).toString("hex")}`,
    status: "pending",
    createdAtMs: now,
    approvalDeadlineMs: now + APPROVAL_WINDOW_MS,
    intentTtlMs: INTENT_TTL_MS,
  };
  await write(proposal);
  return proposal;
}

export async function getProposal(id: string): Promise<Proposal | undefined> {
  try {
    return withEffectiveStatus(JSON.parse(await readFile(fileFor(id), "utf8")) as Proposal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function requireProposal(id: string): Promise<Proposal> {
  const proposal = await getProposal(id);
  if (!proposal) throw new Error(`No proposal ${id}.`);
  return proposal;
}

/** Newest first. */
export async function listProposals(limit = 20): Promise<Proposal[]> {
  let names: string[];
  try {
    names = await readdir(proposalsDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const proposals = await Promise.all(
    names
      .filter((name) => name.endsWith(".json") && isProposalId(name.slice(0, -5)))
      .map((name) => getProposal(name.slice(0, -5))),
  );
  return proposals
    .filter((p): p is Proposal => p !== undefined)
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, limit);
}

export async function updateProposal(id: string, patch: Partial<Proposal>): Promise<Proposal> {
  const current = await requireProposal(id);
  const next: Proposal = { ...current, ...patch, id: current.id };
  await write(next);
  return next;
}

function fmt(raw: string, decimals: number, symbol: string): string {
  const value = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${value / base}${fraction ? `.${fraction}` : ""} ${symbol}`;
}

export function describeProposal(p: Proposal): string {
  const lines = [
    `Proposal ID: ${p.id}`,
    `Status: ${p.status}`,
    `Sell: ${fmt(p.amountIn, p.inDecimals, p.inSymbol)}`,
    `Receive: at least ${fmt(p.minOut, p.outDecimals, p.outSymbol)} (quoted ${fmt(p.quotedOut, p.outDecimals, p.outSymbol)}, ${p.slippageBps / 100}% slippage allowed)`,
    `Venue: ${p.dex}`,
  ];
  if (p.status === "pending") {
    lines.push(`Approval window closes: ${new Date(p.approvalDeadlineMs).toISOString()}`);
  }
  if (p.intentId) lines.push(`On-chain intent: ${p.intentId}`);
  if (p.swapDigest) lines.push(`Swap digest: ${p.swapDigest}`);
  if (p.amountOut) lines.push(`Received: ${fmt(p.amountOut, p.outDecimals, p.outSymbol)}`);
  if (p.error) lines.push(`Error: ${p.error}`);
  return lines.join("\n");
}
