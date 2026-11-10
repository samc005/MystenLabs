// Browser port of wallet-mcp/src/blockchain. Same SDK calls and the same
// text output as the MCP tools, without the Node-only file and path code.

import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { coinWithBalance, Transaction } from "@mysten/sui/transactions";
import {
  isValidSuiAddress,
  normalizeStructTag,
  normalizeSuiAddress,
  SUI_DECIMALS,
  SUI_TYPE_ARG,
} from "@mysten/sui/utils";

/** This demo only ever touches testnet. */
export const NETWORK = "testnet";
const FULLNODE_URL = "https://fullnode.testnet.sui.io:443";

export const FAUCET_PAGE_URL = "https://faucet.sui.io";

export interface TokenBalance {
  coinType: string;
  symbol: string;
  decimals: number;
  raw: bigint;
  formatted: string;
}

export interface TransferReceipt {
  digest: string;
  sender: string;
  recipient: string;
  amountMist: bigint;
  gasMist: bigint | null;
  explorerUrl: string;
  balanceChanges: { address: string; coinType: string; amount: string }[];
}

export function createSuiClient(): SuiGrpcClient {
  return new SuiGrpcClient({ network: NETWORK, baseUrl: FULLNODE_URL });
}

export function explorerTxUrl(digest: string): string {
  return `https://suiscan.xyz/${NETWORK}/tx/${digest}`;
}

export function explorerAddressUrl(address: string): string {
  return `https://suiscan.xyz/${NETWORK}/account/${address}`;
}

export function requireAddress(value: string): string {
  const normalized = normalizeSuiAddress(value.trim());
  if (!isValidSuiAddress(normalized)) {
    throw new Error(`Not a valid Sui address: ${value}`);
  }
  return normalized;
}

/** Converts a raw integer amount into a decimal string without floating-point loss. */
export function formatUnits(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function formatSui(mist: bigint): string {
  return formatUnits(mist, SUI_DECIMALS);
}

async function describeBalance(
  client: SuiGrpcClient,
  coinType: string,
  raw: bigint,
): Promise<TokenBalance> {
  if (normalizeStructTag(coinType) === normalizeStructTag(SUI_TYPE_ARG)) {
    return { coinType, symbol: "SUI", decimals: SUI_DECIMALS, raw, formatted: formatSui(raw) };
  }
  const { coinMetadata } = await client.getCoinMetadata({ coinType });
  const decimals = coinMetadata?.decimals ?? 0;
  const symbol = coinMetadata?.symbol ?? coinType.split("::").pop() ?? coinType;
  return { coinType, symbol, decimals, raw, formatted: formatUnits(raw, decimals) };
}

export async function getSuiBalance(client: SuiGrpcClient, owner: string): Promise<bigint> {
  const { balance } = await client.getBalance({ owner, coinType: SUI_TYPE_ARG });
  return BigInt(balance.balance);
}

/** Every coin type the address holds, SUI first, then by symbol. */
export async function getAllBalances(client: SuiGrpcClient, owner: string): Promise<TokenBalance[]> {
  const entries: { coinType: string; balance: string }[] = [];
  let page = await client.listBalances({ owner, limit: 50 });
  while (true) {
    entries.push(...page.balances);
    if (!page.hasNextPage) break;
    page = await client.listBalances({ owner, limit: 50, cursor: page.cursor });
  }
  const balances = await Promise.all(
    entries.map((entry) => describeBalance(client, entry.coinType, BigInt(entry.balance))),
  );
  const sui = normalizeStructTag(SUI_TYPE_ARG);
  return balances.sort((a, b) => {
    const aIsSui = normalizeStructTag(a.coinType) === sui;
    const bIsSui = normalizeStructTag(b.coinType) === sui;
    if (aIsSui !== bIsSui) return aIsSui ? -1 : 1;
    return a.symbol.localeCompare(b.symbol);
  });
}

export function formatBalanceReport(owner: string, balances: TokenBalance[]): string {
  const lines = [`Network: ${NETWORK}`, `Address: ${owner}`];
  if (balances.length === 0) {
    lines.push("No coins found.");
    return lines.join("\n");
  }
  lines.push("Balances:");
  for (const balance of balances) {
    lines.push(`  ${balance.formatted} ${balance.symbol}  (${balance.coinType})`);
  }
  return lines.join("\n");
}

function netGasMist(gas: { computationCost: string; storageCost: string; storageRebate: string }): bigint {
  return BigInt(gas.computationCost) + BigInt(gas.storageCost) - BigInt(gas.storageRebate);
}

/** Sends SUI from `signer` to `recipient` with coinWithBalance, as wallet-mcp does. */
export async function transferSui(input: {
  client: SuiGrpcClient;
  signer: Ed25519Keypair;
  recipient: string;
  amountMist: bigint;
}): Promise<TransferReceipt> {
  if (input.amountMist <= 0n) {
    throw new Error("Amount must be greater than 0.");
  }
  const sender = input.signer.toSuiAddress();
  const recipient = requireAddress(input.recipient);
  if (recipient === sender) {
    throw new Error("Recipient is the sender. Choose a different address.");
  }

  const balance = await getSuiBalance(input.client, sender);
  if (balance <= input.amountMist) {
    throw new Error(
      `Not enough SUI. Balance is ${formatSui(balance)} SUI, and the transfer of ${formatSui(input.amountMist)} SUI still needs a little left over for gas.`,
    );
  }

  const tx = new Transaction();
  tx.setSender(sender);
  tx.transferObjects([coinWithBalance({ balance: input.amountMist })(tx)], recipient);

  const submitted = await input.client.signAndExecuteTransaction({
    transaction: tx,
    signer: input.signer,
    include: { effects: true, balanceChanges: true },
  });
  if (submitted.$kind === "FailedTransaction") {
    throw new Error(submitted.FailedTransaction.status.error?.message ?? "Transaction failed.");
  }

  const settled = await input.client.waitForTransaction({
    result: submitted,
    include: { effects: true, balanceChanges: true },
    timeout: 60_000,
  });
  if (settled.$kind === "FailedTransaction") {
    throw new Error(settled.FailedTransaction.status.error?.message ?? "Transaction failed.");
  }

  const executed = settled.Transaction;
  const gas = executed.effects?.gasUsed;
  return {
    digest: executed.digest,
    sender,
    recipient,
    amountMist: input.amountMist,
    gasMist: gas ? netGasMist(gas) : null,
    explorerUrl: explorerTxUrl(executed.digest),
    balanceChanges: (executed.balanceChanges ?? []).map((change) => ({
      address: change.address,
      coinType: change.coinType,
      amount: change.amount,
    })),
  };
}

export function formatTransferReceipt(receipt: TransferReceipt): string {
  const lines = [
    `Sent ${formatSui(receipt.amountMist)} SUI`,
    `From: ${receipt.sender}`,
    `To: ${receipt.recipient}`,
    `Digest: ${receipt.digest}`,
    `Explorer: ${receipt.explorerUrl}`,
  ];
  if (receipt.gasMist !== null) {
    lines.push(`Gas: ${formatSui(receipt.gasMist)} SUI`);
  }
  if (receipt.balanceChanges.length > 0) {
    lines.push("Balance changes:");
    for (const change of receipt.balanceChanges) {
      lines.push(`  ${formatSui(BigInt(change.amount))} ${change.coinType}  ${change.address}`);
    }
  }
  return lines.join("\n");
}
