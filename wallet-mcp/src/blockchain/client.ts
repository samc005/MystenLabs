import { SuiGrpcClient } from "@mysten/sui/grpc";

export type SuiNetwork = "testnet" | "mainnet" | "devnet" | "localnet";

const FULLNODE_URLS: Record<SuiNetwork, string> = {
  testnet: "https://fullnode.testnet.sui.io:443",
  mainnet: "https://fullnode.mainnet.sui.io:443",
  devnet: "https://fullnode.devnet.sui.io:443",
  localnet: "http://127.0.0.1:9000",
};

export function isSuiNetwork(value: string): value is SuiNetwork {
  return value in FULLNODE_URLS;
}

export function fullnodeUrl(network: SuiNetwork): string {
  return FULLNODE_URLS[network];
}

export function createSuiClient(network: SuiNetwork = "testnet"): SuiGrpcClient {
  return new SuiGrpcClient({ network, baseUrl: FULLNODE_URLS[network] });
}
