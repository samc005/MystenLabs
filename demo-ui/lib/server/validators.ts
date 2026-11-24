// Testnet validators, for the Settings picker and for naming approved validators in chat.
// Read-only, from the network's GraphQL endpoint (the gRPC client does not expose the validator
// set). Cached briefly: the set changes only at epoch boundaries.

import { normalizeSuiAddress } from "@mysten/sui/utils";

export interface Validator {
  name: string;
  address: string;
  commissionPercent: number;
  stakeMist: string;
}

const QUERY = `query Validators($after: String) {
  epoch { validatorSet { activeValidators(first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { contents { json } }
  } } }
}`;

type Json = { metadata?: { name?: string; sui_address?: string }; commission_rate?: string; staking_pool?: { sui_balance?: string } };

let cache: { at: number; validators: Validator[] } | null = null;

export async function listValidators(fetchImpl: typeof fetch = fetch): Promise<Validator[]> {
  if (cache && Date.now() - cache.at < 10 * 60_000) return cache.validators;
  const validators: Validator[] = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const response = await fetchImpl("https://graphql.testnet.sui.io/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { after } }),
    });
    const body = (await response.json()) as {
      data?: { epoch?: { validatorSet?: { activeValidators?: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { contents?: { json?: Json } }[] } } } };
      errors?: { message: string }[];
    };
    if (!response.ok || body.errors?.length) throw new Error("Could not load validators.");
    const connection = body.data?.epoch?.validatorSet?.activeValidators;
    if (!connection) break;
    for (const node of connection.nodes) {
      const v = node.contents?.json;
      if (!v?.metadata?.sui_address) continue;
      validators.push({
        name: (v.metadata.name ?? "unnamed").trim().slice(0, 60),
        address: normalizeSuiAddress(v.metadata.sui_address),
        commissionPercent: Number(v.commission_rate ?? 0) / 100,
        stakeMist: v.staking_pool?.sui_balance ?? "0",
      });
    }
    if (!connection.pageInfo.hasNextPage) break;
    after = connection.pageInfo.endCursor;
  }
  validators.sort((a, b) => (BigInt(b.stakeMist) > BigInt(a.stakeMist) ? 1 : BigInt(b.stakeMist) < BigInt(a.stakeMist) ? -1 : 0));
  cache = { at: Date.now(), validators };
  return validators;
}

/** Name -> address for the validators this vault allows, so chat can say "stake 1 SUI with Mysten 1". */
export async function validatorNamesFor(allowed: string[]): Promise<Record<string, string>> {
  if (allowed.length === 0) return {};
  const known = await listValidators().catch(() => [] as Validator[]);
  const names: Record<string, string> = {};
  for (const address of allowed) {
    const validator = known.find((v) => v.address === address);
    if (validator && /^[A-Za-z0-9][A-Za-z0-9 ._'-]{0,59}$/.test(validator.name)) names[validator.name] = address;
  }
  return names;
}
