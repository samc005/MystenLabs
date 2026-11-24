// Chat actions the app handles itself (not wallet-mcp tools). None of them moves money on the
// server: owner actions are only described here and signed by the owner's wallet in the browser.

import { readVaultPolicy, type PolicyReader } from "@/lib/owner-tx";
import { parseToMist } from "@mysten/sui/utils";
import { createSuiClient, formatSui, getSuiBalance } from "@/lib/sui";
import { listAccountWallets } from "./wallet-mcp";
import type { WalletAction } from "@/lib/wallet-policy";
import type { AccountContext } from "./account-context";
import { createRequest, saveContact } from "./account-store";
import type { ChatEvent } from "./agent";

type Send = (event: ChatEvent) => void;

async function isTrusted(account: AccountContext, address: string): Promise<boolean> {
  try {
    const policy = await readVaultPolicy(createSuiClient() as unknown as PolicyReader, account.vaultId);
    return policy.allowedRecipients.includes(address);
  } catch {
    return false;
  }
}

async function vaultBalance(account: AccountContext): Promise<bigint | null> {
  try {
    const vault = (await listAccountWallets(account)).find((wallet) => wallet.role === "vault");
    return vault?.balanceMist ? BigInt(vault.balanceMist) : null;
  } catch {
    return null;
  }
}

/**
 * When a payment fails only because the vault is short, offer a top-up for the difference.
 * The owner's wallet signs it; nothing moves unless they do.
 */
export function topUpFor(errorText: string): { amountMist: string; text: string } | null {
  const match = errorText.match(/vault only holds ([0-9.]+) SUI[^0-9]+requested ([0-9.]+) SUI/);
  if (!match) return null;
  const shortfall = parseToMist(match[2]!) - parseToMist(match[1]!);
  if (shortfall <= 0n) return null;
  return {
    amountMist: shortfall.toString(),
    text: `Your vault has ${match[1]} SUI, but that payment needs ${match[2]} SUI. Want to move ${formatSui(shortfall)} SUI from your wallet into your vault? Then ask me again.`,
  };
}

export async function handleLocalAction(action: WalletAction, account: AccountContext, send: Send): Promise<void> {
  const args = action.args as Record<string, string>;
  switch (action.tool) {
    case "save_contact": {
      const contact = await saveContact(account.accountId, args.name, args.address);
      if (await isTrusted(account, contact.address)) {
        send({ type: "text", delta: `Saved ${contact.name} (${contact.address}). They're already a trusted recipient, so you can pay them right away.` });
        return;
      }
      send({
        type: "text",
        delta: `Saved ${contact.name} (${contact.address}). Want Cipher to be able to pay them directly? Make them a trusted recipient below. Your wallet signs it.`,
      });
      send({ type: "owner_action", action: { kind: "trust", address: contact.address, name: contact.name } });
      return;
    }
    case "owner_deposit":
    case "owner_withdraw": {
      const amountMist = parseToMist(args.amount);
      if (amountMist <= 0n) {
        send({ type: "text", delta: "The amount has to be more than zero." });
        return;
      }
      const deposit = action.tool === "owner_deposit";
      // A friendly early check. The chain enforces the real limit either way.
      const available = deposit
        ? await getSuiBalance(createSuiClient(), account.ownerAddress).catch(() => null)
        : await vaultBalance(account);
      if (available !== null && available < amountMist) {
        send({
          type: "text",
          delta: deposit
            ? `Your wallet only has ${formatSui(available)} SUI, so it can't move ${args.amount} SUI (it also needs a little for the fee).`
            : `Your vault only has ${formatSui(available)} SUI, so you can withdraw up to that.`,
        });
        return;
      }
      send({
        type: "text",
        delta: deposit
          ? `Sure. Sign below to move ${args.amount} SUI from your wallet into your vault.`
          : `Sure. Sign below to move ${args.amount} SUI from your vault back to your wallet.`,
      });
      send({ type: "owner_action", action: { kind: deposit ? "deposit" : "withdraw", amountMist: amountMist.toString() } });
      return;
    }
    case "payment_request": {
      const amountMist = parseToMist(args.amount);
      if (amountMist <= 0n) {
        send({ type: "text", delta: "The amount has to be more than zero." });
        return;
      }
      const request = await createRequest(account.accountId, {
        amountMist: amountMist.toString(),
        from: args.from ?? null,
        note: action.note ?? null,
        receiver: account.ownerAddress,
      });
      const who = request.from ? ` to ${request.from}` : "";
      send({
        type: "text",
        delta: `Here's your request for ${args.amount} SUI${request.note ? ` for ${request.note}` : ""}. Send the QR code or link${who}; any Sui wallet like Slush can pay it in one tap. It goes to your wallet, and I'll mark it paid when it arrives.`,
      });
      send({ type: "payment_request", request });
      return;
    }
    default:
      send({ type: "text", delta: "I can't do that yet." });
  }
}
