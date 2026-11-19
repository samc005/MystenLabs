// Never trust the browser's claim about which vault is "mine". Before an account is marked
// active, read the chain and confirm the vault is from OUR package, the claimed OwnerCap is
// held by this account's owner address, and this account's agent holds a current AgentCap.
// Without this, a client could register someone else's vault or a weaker look-alike package
// against its own agent key.

import {
  findAgentCap,
  ownerOf,
  vaultType,
  type ChainReader,
} from "../owner-tx";
import type { Account, AccountVault } from "./accounts";

export class AccountVerificationError extends Error {}

export async function verifyAccountVault(
  reader: ChainReader,
  input: {
    packageId: string;
    account: Pick<Account, "ownerAddress" | "agentAddress">;
    claim: { vaultId: string; ownerCapId: string };
  },
): Promise<AccountVault> {
  const { packageId, account, claim } = input;
  const fail = (message: string) => {
    throw new AccountVerificationError(message);
  };

  const [{ object: vault }, { object: ownerCap }] = await Promise.all([
    reader.getObject({ objectId: claim.vaultId, include: { json: true } }),
    reader.getObject({ objectId: claim.ownerCapId, include: { json: true } }),
  ]);

  if (vault.type !== vaultType(packageId, "Vault")) fail("That vault was not created by this app's vault package.");
  if (ownerCap.type !== vaultType(packageId, "OwnerCap")) fail("That is not an OwnerCap for this app's vault package.");
  if (ownerCap.json?.vault_id !== claim.vaultId) fail("That OwnerCap belongs to a different vault.");
  if (ownerOf(ownerCap) !== account.ownerAddress) fail("The OwnerCap is not held by this account's owner wallet.");

  const agentCap = await findAgentCap(
    reader,
    account.agentAddress,
    packageId,
    claim.vaultId,
    vault.json?.agent_version,
  );
  if (!agentCap) fail("This account's agent has not been authorized on that vault yet.");

  return { packageId, vaultId: claim.vaultId, ownerCapId: claim.ownerCapId, agentCapId: agentCap!.agentCapId };
}
