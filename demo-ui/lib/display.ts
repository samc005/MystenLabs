// Turns the wallet tools' plain-text output into readable pieces without dropping information:
// full addresses become short, labeled chips (the full value stays in the tooltip and copy button),
// transaction digests become receipt links, and explorer URLs become links.

import { explorerAddressUrl, explorerTxUrl } from "./sui";

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "address"; address: string; label: string | null }
  | { kind: "receipt"; digest: string }
  | { kind: "link"; url: string };

export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

const ADDRESS = /0x[0-9a-fA-F]{64}/g;
const URL_PATTERN = /https:\/\/suiscan\.xyz\/[^\s)]+/g;
/** Base58 transaction digests are 43 or 44 characters. */
const DIGEST_LINE = /^(\s*)Digest:\s*([1-9A-HJ-NP-Za-km-z]{43,44})\s*$/;
const EXPLORER_LINE = /^\s*Explorer:\s*https:\/\/\S+\s*$/;

/** Splits one line into text, address, and link segments. */
function segmentLine(line: string, labels: Record<string, string>): Segment[] {
  const segments: Segment[] = [];
  const pattern = new RegExp(`${ADDRESS.source}|${URL_PATTERN.source}`, "g");
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) segments.push({ kind: "text", text: line.slice(last, index) });
    const value = match[0];
    if (value.startsWith("0x")) {
      const address = value.toLowerCase();
      segments.push({ kind: "address", address, label: labels[address] ?? null });
    } else {
      segments.push({ kind: "link", url: value });
    }
    last = index + value.length;
  }
  if (last < line.length) segments.push({ kind: "text", text: line.slice(last) });
  return segments;
}

/**
 * One segment list per line. A "Digest:" line becomes a receipt link, and the "Explorer:" line that
 * repeats the same transaction is folded into it.
 */
export function formatToolText(text: string, labels: Record<string, string> = {}): Segment[][] {
  const lines = text.split("\n");
  const hasDigest = lines.some((line) => DIGEST_LINE.test(line));
  const out: Segment[][] = [];
  for (const line of lines) {
    const digest = line.match(DIGEST_LINE);
    if (digest) {
      out.push([{ kind: "text", text: `${digest[1]}Receipt: ` }, { kind: "receipt", digest: digest[2] }]);
      continue;
    }
    if (hasDigest && EXPLORER_LINE.test(line)) continue;
    out.push(segmentLine(line, labels));
  }
  return out;
}

export function addressUrl(address: string): string {
  return explorerAddressUrl(address);
}

export function receiptUrl(digest: string): string {
  return explorerTxUrl(digest);
}

/** Friendly names for the account's own addresses plus trusted contacts. Keys are lowercase. */
export function accountLabels(input: {
  ownerAddress?: string;
  agentAddress?: string;
  vaultId?: string;
  contacts?: Record<string, string>;
}): Record<string, string> {
  const labels: Record<string, string> = { ...(input.contacts ?? {}) };
  if (input.ownerAddress) labels[input.ownerAddress.toLowerCase()] = "Your wallet";
  if (input.agentAddress) labels[input.agentAddress.toLowerCase()] = "Cipher";
  if (input.vaultId) labels[input.vaultId.toLowerCase()] = "Your vault";
  return labels;
}

/** Readable names for the wallet tools shown in chat. */
export const TOOL_LABELS: Record<string, string> = {
  get_balance: "Checked balance",
  vault_status: "Checked vault",
  list_validators: "Listed validators",
  vault_spend: "Prepared a payment",
  propose_spend: "Requested owner approval",
  vault_stake: "Prepared a stake",
  swap_quote: "Got a swap quote",
  propose_trade: "Proposed a swap",
  vault_swap: "Prepared a swap",
  vault_spend_approved: "Prepared an approved payment",
  history: "Looked up history",
};
