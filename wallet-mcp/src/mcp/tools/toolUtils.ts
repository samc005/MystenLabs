import { requireAddress, configuredAddress } from "../../blockchain/address.js";
import { type SuiNetwork } from "../../blockchain/client.js";

export async function resolveOwner(network: SuiNetwork, address?: string): Promise<string> {
  return address ? requireAddress(address) : configuredAddress(network);
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint") return item.toString();
    if (item instanceof Uint8Array) return Buffer.from(item).toString("base64");
    return item;
  }, 2);
}
