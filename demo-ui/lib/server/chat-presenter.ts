// Turns wallet results into chat replies a person would write. Presentation only: the numbers come
// from the chain (or the wallet tool's own output), never from the model, and nothing here can act.

import { formatSui, getAllBalances, createSuiClient } from "@/lib/sui";
import { readVaultPolicy, type PolicyReader } from "@/lib/owner-tx";
import type { AccountContext } from "./account-context";
import { listAccountWallets } from "./wallet-mcp";

const sui = (mist: bigint | string | null | undefined) => (mist == null ? "?" : `${formatSui(BigInt(mist))} SUI`);

/** "Your money": the owner wallet and the vault. Cipher's gas key is a side note, not your balance. */
export async function presentBalance(account: AccountContext): Promise<string> {
  const client = createSuiClient();
  const [wallets, ownerCoins, policy] = await Promise.all([
    listAccountWallets(account),
    getAllBalances(client, account.ownerAddress).catch(() => []),
    readVaultPolicy(client as unknown as PolicyReader, account.vaultId).catch(() => null),
  ]);
  const balance = (role: string) => wallets.find((wallet) => wallet.role === role)?.balanceMist ?? null;
  const owner = balance("owner");
  const vault = balance("vault");
  const staked = policy?.stake?.stakedMist ?? 0n;
  const trading = policy?.tradingSuiMist ?? 0n;
  const total = owner != null && vault != null ? BigInt(owner) + BigInt(vault) + staked + trading : null;
  const others = ownerCoins.filter((coin) => coin.symbol !== "SUI" && coin.raw > 0n);

  const lines = [
    total != null ? `You have ${sui(total)} in total:` : "Here's what you have:",
    `• ${sui(owner)} in your wallet`,
    `• ${sui(vault)} in your vault (what Cipher can spend for you)`,
  ];
  if (staked > 0n) lines.push(`• ${sui(staked)} staked from your vault, earning rewards`);
  if (trading > 0n) lines.push(`• ${sui(trading)} set aside in your vault for swaps`);
  for (const coin of others) lines.push(`• ${coin.formatted} ${coin.symbol} in your wallet`);
  lines.push("", `Cipher also keeps ${sui(balance("agent"))} to pay network fees.`);
  return lines.join("\n");
}

/** The vault's rules in plain words, read from the chain. */
export async function presentVault(account: AccountContext): Promise<string> {
  const client = createSuiClient();
  const [wallets, policy] = await Promise.all([
    listAccountWallets(account),
    readVaultPolicy(client as unknown as PolicyReader, account.vaultId),
  ]);
  const vault = wallets.find((wallet) => wallet.role === "vault")?.balanceMist ?? null;
  const lines = [`Your vault has ${sui(vault)}. Cipher can spend from it within these limits:`];
  lines.push(`• Up to ${sui(policy.perTxLimitMist)} per payment`);
  if (policy.spend) lines.push(`• Up to ${sui(policy.spend.dailyCapMist)} per epoch (about a day)`);
  if (policy.calendar) {
    lines.push(`• Up to ${sui(policy.calendar.dayCapMist)} per day and ${sui(policy.calendar.weekCapMist)} per week`);
  }
  if (policy.spend?.enforceRecipients) {
    lines.push(
      policy.allowedRecipients.length
        ? `• Only to your trusted recipients: ${policy.allowedRecipients.join(", ")}`
        : "• No trusted recipients yet, so Cipher can't pay anyone directly",
    );
  } else if (policy.agent) {
    lines.push('• Cipher can\'t pay anyone yet: turn on "Only pay trusted recipients directly" in Account settings');
  } else {
    lines.push("• To any recipient");
  }
  if (policy.agent?.staking) {
    lines.push(`• Staking is on: ${sui(policy.stake?.stakedMist ?? 0n)} staked of up to ${sui(policy.stake?.maxStakedMist ?? 0n)}`);
  }
  if (policy.agent?.trading) lines.push(`• Swaps are on: ${sui(policy.tradingSuiMist ?? 0n)} in your trading balance`);
  lines.push("", "Payments outside these limits aren't sent. You can change them in Account settings.");
  return lines.join("\n");
}

/** Wallet tool text with the technical noise removed. Every amount and address is kept. */
export function cleanToolText(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*(Network|Package):/.test(line))
    .map((line) => line.replace(/\s*\(0x[0-9a-fA-F]+::\w+::\w+\)/g, ""))
    .join("\n")
    .trim();
}

const FULL_ADDRESS = "(0x[0-9a-fA-F]{64})";
const AMOUNT = "([0-9][0-9.,]* SUI)";

/**
 * Wallet refusals are written for the AI model ("call propose_spend…"). Rewrite the ones we know
 * into plain words with what to do next, and drop any sentence that names internal tools.
 */
export function friendlyRefusal(text: string, labels: Record<string, string> = {}): string {
  const cleaned = cleanToolText(text).replace(/^Error:\s*/i, "");
  const who = (address: string) => labels[address.toLowerCase()] ?? `${address.slice(0, 6)}…${address.slice(-4)}`;
  const rules: [RegExp, (match: RegExpMatchArray) => string][] = [
    [/Mandatory on-chain payment policy is not configured/, () => 'Cipher can\'t pay anyone yet. Turn on "Only pay trusted recipients directly" in Account settings, then try again.'],
    [/Payments are disabled/, () => "Payments are turned off for Cipher. You can turn them back on in Account settings."],
    [new RegExp(`${FULL_ADDRESS} is not on the vault's recipient allowlist`), (m) => `${who(m[1]!)} isn't a trusted recipient yet. Trust them in Account settings → Contacts, then try again.`],
    [new RegExp(`${FULL_ADDRESS} is blocked`), (m) => `${who(m[1]!)} is blocked, so Cipher won't pay them.`],
    [new RegExp(`is over the per-spend limit of ${AMOUNT}`), (m) => `That's over your per-payment limit of ${m[1]}. You can change it in Account settings.`],
    [new RegExp(`per-spend limit\\. Requested ${AMOUNT}, limit is ${AMOUNT}`), (m) => `That's over your per-payment limit of ${m[2]}. You can change it in Account settings.`],
    [new RegExp(`more than the ${AMOUNT} left of this epoch's spending cap`), (m) => `That's more than the ${m[1]} left in today's spending limit.`],
    [/vault is paused/, () => "Your vault is paused, so nothing can go out right now."],
    [/Validator \S+ is not on the vault's allowlist/, () => "That validator isn't one you approved. Add it in Account settings → What Cipher can do."],
    [new RegExp(`at least ${AMOUNT} per stake`), (m) => `Sui's minimum stake is ${m[1]}.`],
    [new RegExp(`stake limit: ${AMOUNT} is already staked and the owner allows at most ${AMOUNT}`), (m) => `You already have ${m[1]} staked, and your limit is ${m[2]}. You can raise it in Account settings.`],
    [/already has (\d+) staking positions/, (m) => `You already have ${m[1]} stakes, the most you allow. You can raise it in Account settings.`],
    [new RegExp(`leave less than the ${AMOUNT} the owner wants kept liquid`), (m) => `That would leave less than the ${m[1]} you keep unstaked in your vault.`],
    [/trading sleeve holds ([^,]+),/, (m) => `Your trading balance only has ${m[1]}. Move more into it in Account settings → What Cipher can do.`],
  ];
  for (const [pattern, say] of rules) {
    const match = cleaned.match(pattern);
    if (match) return say(match);
  }
  const kept = cleaned
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !/\b[a-z]+_[a-z_]+\b|npm run|\bcall\b|propos/i.test(sentence));
  return kept.join(" ").trim() || "The wallet refused it.";
}

/** A friendly lead-in for each kind of result. */
export function leadFor(tool: string, prepared: boolean): string | null {
  if (prepared) return "Here's the transaction. I simulated it and nothing has been sent. Review it below and approve it if it looks right.";
  if (tool === "propose_trade") {
    return "That swap is outside the swap rule you set, so I can't run it. Check the limits and the trading balance in Settings → What Cipher can do, then ask again.";
  }
  if (tool === "propose_spend") return "I've asked for your approval. Approve or reject it below.";
  if (tool === "swap_quote") return "Here's the current quote:";
  if (tool === "list_validators") return "Here are the validators you can stake with:";
  return null;
}
