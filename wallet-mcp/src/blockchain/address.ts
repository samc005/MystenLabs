import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";
import { assertTestnet } from "../config.js";
import type { SuiNetwork } from "./client.js";

export function requireAddress(value: string): string {
  const normalized = normalizeSuiAddress(value);
  if (!isValidSuiAddress(normalized)) {
    throw new Error(`Not a valid Sui address: ${value}`);
  }
  return normalized;
}

export function configuredAddress(network: SuiNetwork): string {
  assertTestnet(network);
  const address = process.env.SUI_ADDRESS;
  if (!address) throw new Error("Set SUI_ADDRESS to the public testnet sender address.");
  return requireAddress(address);
}
