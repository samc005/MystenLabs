import { normalizeStructTag, SUI_TYPE_ARG } from "@mysten/sui/utils";
// Read-only demo readiness checks. Never signs, funds, or grants permissions.
import { createSuiClient } from '../blockchain/client.js';
import { getVaultStatus } from '../blockchain/vault.js';
import { quoteSwap } from '../blockchain/swap.js';
import { vaultConfig } from '../config.js';
import { requireAddress } from '../blockchain/address.js';

async function main() {
  const address = requireAddress(process.env.SUI_ADDRESS ?? '');
  const client = createSuiClient('testnet');
  const config = vaultConfig();
  let blocked = false;
  const check = (label: string, ok: boolean, detail = '') => {
    console.log(`${ok ? 'READY' : 'BLOCKED'}: ${label}${detail ? ' — ' + detail : ''}`);
    if (!ok) blocked = true;
  };
  const [{object:cap},{object:vault},{balance},status] = await Promise.all([
    client.getObject({objectId:config.agentCapId,include:{json:true}}),
    client.getObject({objectId:config.vaultId,include:{json:true}}),
    client.getBalance({owner:address,coinType:'0x2::sui::SUI'}),
    getVaultStatus(client,config),
  ]);
  const owner = cap.owner.AddressOwner ?? cap.owner.ConsensusAddressOwner?.owner;
  check('AgentCap belongs to signer',owner === address);
  check('AgentCap targets configured vault',cap.json?.vault_id === config.vaultId);
  check('AgentCap has current authorization version',String(cap.json?.version) === String(vault.json?.agent_version));
  check('Agent has testnet gas',BigInt(balance.balance)>0n,`${balance.balance} MIST`);
  check('Vault unpaused',!status.paused);
  check('Vault can fund minimum native stake',status.balanceMist>=1_000_000_000n,`${status.balanceMist} MIST; minimum stake is 1 SUI before reserve constraints`);
  check('At least one validator allowed',status.allowedValidators.length>0,`${status.allowedValidators.length} validators`);
  const suiSleeve = status.trading.find(c=>normalizeStructTag(c.coinType) === normalizeStructTag(SUI_TYPE_ARG))?.raw ?? 0n;
  check('Trading sleeve can fund 0.001 SUI example',suiSleeve>=1_000_000n,`${suiSleeve} MIST`);
  try {
    const quote = await quoteSwap(client,'SUI','tUSDC','0.001');
    check('Testnet mock pool quote',quote.amountOut>0n,`${quote.amountOut} output raw units (${quote.dex})`);
  } catch (error) { check('Testnet mock pool quote',false,String(error)); }
  console.log('A READY checklist is not a confirmed live stake or swap. Owner policies and simulation still apply.');
  if (blocked) process.exitCode=1;
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Preflight failed');process.exitCode=1;});
