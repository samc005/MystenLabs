import { SuiGraphQLClient } from "@mysten/sui/graphql";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { formatUnits } from "./balance.js";
import type { SuiNetwork } from "./client.js";

export interface ValidatorInfo {
  name: string;
  address: string;
  /** Percent of rewards the validator keeps. */
  commissionPercent: number;
  /** Total SUI staked with this validator, in MIST. */
  stakeMist: bigint;
  /** Share of the network's voting power, in basis points (out of 10,000). */
  votingPowerBps: number;
}

const GRAPHQL_URLS: Partial<Record<SuiNetwork, string>> = {
  testnet: "https://graphql.testnet.sui.io/graphql",
  mainnet: "https://graphql.mainnet.sui.io/graphql",
  devnet: "https://graphql.devnet.sui.io/graphql",
};

const QUERY = `
  query Validators($after: String) {
    epoch {
      epochId
      validatorSet {
        activeValidators(first: 50, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { contents { json } }
        }
      }
    }
  }
`;

type ValidatorJson = {
  metadata?: { name?: string; sui_address?: string };
  voting_power?: string;
  commission_rate?: string;
  staking_pool?: { sui_balance?: string };
};

type QueryResult = {
  epoch?: {
    epochId?: number | string;
    validatorSet?: {
      activeValidators?: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: { contents?: { json?: ValidatorJson } }[];
      };
    };
  };
};

/**
 * Read-only validator list from the network's GraphQL endpoint. (The public fullnodes no
 * longer serve JSON-RPC, and the gRPC client does not expose the validator set.)
 * Nothing here signs anything.
 */
export async function listValidators(network: SuiNetwork): Promise<{ epoch: string; validators: ValidatorInfo[] }> {
  const url = GRAPHQL_URLS[network];
  if (!url) throw new Error(`No GraphQL endpoint known for ${network}.`);
  const graphql = new SuiGraphQLClient({ url, network });

  const validators: ValidatorInfo[] = [];
  let epoch = "unknown";
  let after: string | null = null;
  do {
    const result: { data?: QueryResult | null; errors?: { message: string }[] } = await graphql.query<
      QueryResult,
      { after: string | null }
    >({ query: QUERY, variables: { after } });
    if (result.errors?.length) throw new Error(`Validator query failed: ${result.errors[0]!.message}`);
    const connection = result.data?.epoch?.validatorSet?.activeValidators;
    if (!connection) break;
    epoch = String(result.data?.epoch?.epochId ?? epoch);
    for (const node of connection.nodes) {
      const v = node.contents?.json;
      if (!v?.metadata?.sui_address) continue;
      validators.push({
        name: v.metadata.name ?? "unnamed",
        address: normalizeSuiAddress(v.metadata.sui_address),
        commissionPercent: Number(v.commission_rate ?? 0) / 100,
        stakeMist: BigInt(v.staking_pool?.sui_balance ?? "0"),
        votingPowerBps: Number(v.voting_power ?? 0),
      });
    }
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);

  validators.sort((a, b) => (a.stakeMist === b.stakeMist ? 0 : a.stakeMist > b.stakeMist ? -1 : 1));
  return { epoch, validators };
}

export function formatValidators(
  epoch: string,
  validators: ValidatorInfo[],
  allowed: string[],
  limit = 15,
): string {
  const allowedSet = new Set(allowed.map((a) => normalizeSuiAddress(a)));
  const lines = [
    `Epoch ${epoch}. ${validators.length} active validators; showing the ${Math.min(limit, validators.length)} with the most stake.`,
    `"[allowed]" means the vault owner has already allowed the agent to stake there. Lower commission keeps more rewards for the vault.`,
  ];
  for (const v of validators.slice(0, limit)) {
    lines.push(
      `- ${v.name}${allowedSet.has(v.address) ? " [allowed]" : ""}: ${v.address} | commission ${v.commissionPercent}% | ${formatUnits(v.stakeMist, 9)} SUI staked | voting power ${(v.votingPowerBps / 100).toFixed(2)}%`,
    );
  }
  for (const address of allowedSet) {
    if (!validators.some((v) => v.address === address)) {
      lines.push(`- (allowed but not currently active) ${address}`);
    }
  }
  return lines.join("\n");
}
