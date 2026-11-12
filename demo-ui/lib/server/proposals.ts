import { randomUUID } from "node:crypto";
// Server side of the trade-approval flow.
//
// Reading: proposals are plain JSON files written by wallet-mcp's propose_trade tool.
// Deciding: approve and reject run wallet-mcp's owner script. The owner key is read by
// that script from the Sui CLI keystore. It is never in this app's code, never sent to
// the browser, and never passed to the MCP server that Cipher talks to.

import { spawn } from "node:child_process";
import { readFile, readdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { PROPOSAL_ID, isSpendProposal, type Proposal } from "@/lib/proposals";
import { walletMcpDir } from "./wallet-mcp";

function proposalsDir(): string {
  return process.env.SUI_PROPOSALS_DIR ?? path.join(walletMcpDir(), ".proposals");
}

/** Mirrors wallet-mcp: an unapproved proposal past its deadline reads as expired. */
function withEffectiveStatus(p: Proposal, now = Date.now()): Proposal {
  if (p.status === "pending" && now > p.approvalDeadlineMs) return { ...p, status: "expired" };
  if (p.status === "approved" && p.intentExpiryMs && now > p.intentExpiryMs) return { ...p, status: "expired" };
  return p;
}

export async function readProposal(id: string): Promise<Proposal | undefined> {
  if (!PROPOSAL_ID.test(id)) return undefined;
  try {
    const raw = await readFile(path.join(proposalsDir(), `${id}.json`), "utf8");
    return withEffectiveStatus(JSON.parse(raw) as Proposal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function listProposals(limit = 20): Promise<Proposal[]> {
  let names: string[];
  try {
    names = await readdir(proposalsDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const found = await Promise.all(
    names.filter((n) => n.endsWith(".json") && PROPOSAL_ID.test(n.slice(0, -5))).map((n) => readProposal(n.slice(0, -5))),
  );
  return found
    .filter((p): p is Proposal => p !== undefined)
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, limit);
}

/** One decision at a time per proposal, so a double click cannot sign twice. */
const deciding = new Set<string>();

export type DecisionResult = { ok: true; proposal: Proposal; output: string } | { ok: false; status: number; error: string };

export async function decideProposal(id: string, action: "approve" | "reject"): Promise<DecisionResult> {
  if (!PROPOSAL_ID.test(id)) return { ok: false, status: 400, error: "Not a proposal ID." };
  const before = await readProposal(id);
  if (!before) return { ok: false, status: 404, error: `No proposal ${id}.` };
  if (before.status !== "pending") {
    return { ok: false, status: 409, error: `This proposal is ${before.status}, so it can no longer be ${action}d.` };
  }
  if (deciding.has(id)) return { ok: false, status: 409, error: "A decision on this proposal is already in progress." };
  deciding.add(id);
  try {
    // Only an explicit, fixed command is ever run: the id has been validated above.
    const { ANTHROPIC_API_KEY: _key, ...env } = process.env;
    const child = spawn("npm", ["run", "-s", "owner", "--", action, id], {
      cwd: walletMcpDir(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    const timeout = setTimeout(() => child.kill("SIGTERM"), 120_000);
    const code = await new Promise<number | null>((resolve) => {
      child.on("error", (error) => {
        output += error.message;
        resolve(1);
      });
      child.on("close", resolve);
    });
    clearTimeout(timeout);

    if (code !== 0) {
      const message = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("npm warn"))
        .slice(-4)
        .join(" ");
      return { ok: false, status: 500, error: message || `The owner script failed (exit ${code}).` };
    }
    const proposal = await readProposal(id);
    if (!proposal) return { ok: false, status: 500, error: "The proposal disappeared after the decision." };
    return { ok: true, proposal, output };
  } finally {
    deciding.delete(id);
  }
}

/** Record UI status only after the signer submission has checkpoint confirmation. */
export async function recordProposalExecution(id: string, kind: "swap" | "payment", digest: string): Promise<void> {
  const proposal = await readProposal(id);
  if (!proposal || (kind === "payment") !== isSpendProposal(proposal)) throw new Error("Proposal type mismatch.");
  const updated = { ...proposal, status: "executed",
    ...(kind === "payment" ? { spendDigest: digest } : { swapDigest: digest }),
  };
  const target = path.join(proposalsDir(), id + ".json");
  const temporary = target + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(updated, null, 2), { mode: 0o600, flag: "wx" });
  await rename(temporary, target);
}
