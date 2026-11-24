// Recent transactions for an account, read from the chain (Sui GraphQL), not from our own logs.
// That way the list also shows what happened outside this app: faucet top-ups, Slush transfers,
// owner CLI commands. The chain is the source of truth.
//
// Later, these same normalized entries are what the per-user memory / RAG index will ingest.

const GRAPHQL_URL = "https://graphql.testnet.sui.io/graphql";
const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const PER_ADDRESS = 20;

export type ActivityKind =
  | "payment"
  | "sent"
  | "received"
  | "deposit"
  | "withdraw"
  | "stake"
  | "swap"
  | "settings"
  | "setup"
  | "other";

export interface ActivityEntry {
  digest: string;
  timestamp: string | null;
  kind: ActivityKind;
  title: string;
  /** Amount in MIST as a decimal string, unsigned. Null when there is no meaningful single amount. */
  amountMist: string | null;
  direction: "in" | "out" | "none";
  counterparty: { address: string; label: string | null } | null;
  /** Who started it, from the account's point of view. */
  by: "you" | "cipher" | "someone else";
  success: boolean;
  /** The user's own note ("pizza"), if they added one. Stored by the app, not on the chain. */
  note?: string | null;
}

export interface RawTransaction {
  digest: string;
  sender: { address: string } | null;
  effects: {
    status: string;
    timestamp: string | null;
    gasEffects?: { gasSummary?: { computationCost: string; storageCost: string; storageRebate: string } | null } | null;
    balanceChanges: { nodes: { owner: { address: string } | null; amount: string; coinType: { repr: string } | null }[] };
  } | null;
  kind: {
    __typename: string;
    commands?: { nodes: { __typename: string; function?: { name: string; module: { name: string } } | null }[] };
  } | null;
}

const QUERY = `query Activity($address: SuiAddress!, $last: Int!, $before: String) {
  transactions(last: $last, before: $before, filter: { affectedAddress: $address }) {
    pageInfo { hasPreviousPage startCursor }
    nodes {
      digest
      sender { address }
      effects {
        status
        timestamp
        gasEffects { gasSummary { computationCost storageCost storageRebate } }
        balanceChanges { nodes { owner { address } amount coinType { repr } } }
      }
      kind {
        __typename
        ... on ProgrammableTransaction {
          commands { nodes { __typename ... on MoveCallCommand { function { name module { name } } } } }
        }
      }
    }
  }
}`;

async function fetchForAddress(address: string, fetchImpl: typeof fetch, pages = 1): Promise<RawTransaction[]> {
  const found: RawTransaction[] = [];
  let before: string | null = null;
  for (let page = 0; page < pages; page += 1) {
    const response = await fetchImpl(GRAPHQL_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { address, last: pages > 1 ? 50 : PER_ADDRESS, before } }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json()) as {
      data?: { transactions?: { nodes?: RawTransaction[]; pageInfo?: { hasPreviousPage: boolean; startCursor: string | null } } };
      errors?: { message: string }[];
    };
    if (!response.ok || body.errors?.length) throw new Error(body.errors?.[0]?.message ?? `GraphQL ${response.status}`);
    found.push(...(body.data?.transactions?.nodes ?? []));
    const info = body.data?.transactions?.pageInfo;
    if (!info?.hasPreviousPage || !info.startCursor) break;
    before = info.startCursor;
  }
  return found;
}

const PAYMENT = /^spend/;
const STAKE = /stake/;
const SWAP = /swap|trade/;
const SETUP = /^(create|create_secure|issue_agent_cap)$/;

function gasMist(tx: RawTransaction): bigint {
  const gas = tx.effects?.gasEffects?.gasSummary;
  if (!gas) return 0n;
  return BigInt(gas.computationCost) + BigInt(gas.storageCost) - BigInt(gas.storageRebate);
}

/** Turns one chain transaction into something a person can read. Pure, so it is unit-tested. */
export function describeTransaction(
  tx: RawTransaction,
  account: { ownerAddress: string; agentAddress: string; vaultId: string },
  labels: Record<string, string> = {},
): ActivityEntry {
  const ours = new Set([account.ownerAddress, account.agentAddress]);
  const sender = tx.sender?.address ?? "";
  const by: ActivityEntry["by"] =
    sender === account.ownerAddress ? "you" : sender === account.agentAddress ? "cipher" : "someone else";
  const functions = (tx.kind?.commands?.nodes ?? [])
    .map((command) => command.function?.name)
    .filter((name): name is string => typeof name === "string");
  const suiChanges = (tx.effects?.balanceChanges.nodes ?? [])
    .filter((change) => change.owner && change.coinType?.repr === SUI)
    .map((change) => ({ address: change.owner!.address, amount: BigInt(change.amount) }));
  const oursNet = suiChanges.filter((c) => ours.has(c.address)).reduce((sum, c) => sum + c.amount, 0n);
  const theirs = suiChanges.filter((c) => !ours.has(c.address));
  const theirsIn = theirs.filter((c) => c.amount > 0n);
  const label = (address: string) =>
    labels[address] ?? (address === account.ownerAddress ? "You" : address === account.agentAddress ? "Cipher" : null);
  const counterpartyOf = (address: string | undefined) => (address ? { address, label: label(address) } : null);
  const sumIn = theirsIn.reduce((sum, c) => sum + c.amount, 0n);
  const gas = by === "someone else" ? 0n : gasMist(tx);

  const base = {
    digest: tx.digest,
    timestamp: tx.effects?.timestamp ?? null,
    by,
    success: tx.effects?.status === "SUCCESS",
  };

  if (functions.some((f) => PAYMENT.test(f))) {
    return { ...base, kind: "payment", title: "Payment from vault", amountMist: sumIn > 0n ? sumIn.toString() : null, direction: "out", counterparty: counterpartyOf(theirsIn[0]?.address) };
  }
  if (functions.some((f) => SWAP.test(f))) {
    return { ...base, kind: "swap", title: "Swap", amountMist: null, direction: "none", counterparty: null };
  }
  if (functions.some((f) => STAKE.test(f))) {
    const staked = -oursNet - gas;
    return { ...base, kind: "stake", title: "Stake", amountMist: staked > 0n ? staked.toString() : null, direction: "none", counterparty: null };
  }
  if (functions.some((f) => SETUP.test(f))) {
    return { ...base, kind: "setup", title: "Vault setup", amountMist: null, direction: "none", counterparty: null };
  }
  if (functions.includes("deposit")) {
    const amount = -oursNet - gas;
    return { ...base, kind: "deposit", title: "Added to vault", amountMist: amount > 0n ? amount.toString() : null, direction: "none", counterparty: null };
  }
  if (functions.some((f) => f.startsWith("withdraw"))) {
    const amount = oursNet + gas;
    return { ...base, kind: "withdraw", title: "Withdrew from vault", amountMist: amount > 0n ? amount.toString() : null, direction: "in", counterparty: null };
  }
  if (functions.length > 0 && functions.every((f) => /^(set_|allow_|disallow_|block_|unblock_|cancel|approve|reject|rotate|pause)/.test(f))) {
    return { ...base, kind: "settings", title: "Changed vault rules", amountMist: null, direction: "none", counterparty: null };
  }
  if (by === "someone else" && oursNet > 0n) {
    return { ...base, kind: "received", title: "Received", amountMist: oursNet.toString(), direction: "in", counterparty: counterpartyOf(sender) };
  }
  if (by !== "someone else" && sumIn > 0n) {
    return { ...base, kind: "sent", title: "Sent", amountMist: sumIn.toString(), direction: "out", counterparty: counterpartyOf(theirsIn[0]?.address) };
  }
  return {
    ...base,
    kind: "other",
    title: functions[0] ? functions[0].replaceAll("_", " ") : "Transaction",
    amountMist: null,
    direction: "none",
    counterparty: null,
  };
}

/** The account's most recent transactions, newest first, across its owner wallet and Cipher's key. */
export async function recentActivity(
  account: { ownerAddress: string; agentAddress: string; vaultId: string },
  options: {
    limit?: number;
    labels?: Record<string, string>;
    notes?: Record<string, string>;
    fetchImpl?: typeof fetch;
    /** Pages of 50 per address to read. 1 (the default) reads the most recent 20. */
    pages?: number;
  } = {},
): Promise<ActivityEntry[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const pages = await Promise.all([
    fetchForAddress(account.ownerAddress, fetchImpl, options.pages ?? 1),
    fetchForAddress(account.agentAddress, fetchImpl, options.pages ?? 1),
  ]);
  const byDigest = new Map<string, RawTransaction>();
  for (const tx of pages.flat()) byDigest.set(tx.digest, tx);
  return [...byDigest.values()]
    .map((tx) => ({ ...describeTransaction(tx, account, options.labels), note: options.notes?.[tx.digest] ?? null }))
    .sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""))
    .slice(0, options.limit ?? 15);
}

/** Trusted contacts from server config, keyed by address, for friendly names. */
export function contactLabels(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  try {
    const contacts = JSON.parse(env.WALLET_CONTACTS_JSON ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(contacts).flatMap(([name, address]) =>
        typeof address === "string" && /^0x[0-9a-fA-F]{64}$/.test(address) ? [[address.toLowerCase(), name]] : [],
      ),
    );
  } catch {
    return {};
  }
}
