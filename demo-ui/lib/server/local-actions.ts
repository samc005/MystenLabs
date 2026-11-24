// Chat actions the app handles itself (not wallet-mcp tools). None of them moves money on the
// server: owner actions are only described here and signed by the owner's wallet in the browser.

import { readVaultPolicy, type PolicyReader } from "@/lib/owner-tx";
import { createSuiClient } from "@/lib/sui";
import type { WalletAction } from "@/lib/wallet-policy";
import type { AccountContext } from "./account-context";
import { saveContact } from "./account-store";
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
    default:
      send({ type: "text", delta: "I can't do that yet." });
  }
}
