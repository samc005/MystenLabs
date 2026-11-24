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
  const [wallets, ownerCoins] = await Promise.all([
    listAccountWallets(account),
    getAllBalances(client, account.ownerAddress).catch(() => []),
  ]);
  const balance = (role: string) => wallets.find((wallet) => wallet.role === role)?.balanceMist ?? null;
  const owner = balance("owner");
  const vault = balance("vault");
  const total = owner != null && vault != null ? BigInt(owner) + BigInt(vault) : null;
  const others = ownerCoins.filter((coin) => coin.symbol !== "SUI" && coin.raw > 0n);

  const lines = [
    total != null ? `You have ${sui(total)} in total:` : "Here's what you have:",
    `• ${sui(owner)} in your wallet`,
    `• ${sui(vault)} in your vault (what Cipher can spend for you)`,
  ];
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
        : "• No trusted recipients yet, so every payment needs your approval",
    );
  } else {
    lines.push("• To any recipient");
  }
  lines.push("", "Anything outside these limits needs your approval first. You can change them in Account settings.");
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
