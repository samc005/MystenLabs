import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createSuiClient } from "../../blockchain/client.js";
import { requireAddress } from "../../blockchain/address.js";
import { resolveNetwork } from "../../config.js";
import { formatJson, resolveOwner } from "./toolUtils.js";

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function decodeBase64(value: string, field: string): Uint8Array {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
    throw new Error(`${field} must be valid base64.`);
  }
  return Uint8Array.from(bytes);
}

export function registerExtendedReadOnlyTools(server: McpServer): void {
  server.registerTool(
    "get_object",
    {
      description: "Read a Sui object's owner, type, version, digest, content, and display data.",
      inputSchema: z.object({ objectId: z.string().min(1).describe("Sui object ID.") }),
    },
    async ({ objectId }) => {
      try {
        const network = resolveNetwork();
        const result = await createSuiClient(network).getObject({
          objectId,
          include: { content: true, display: true, json: true, objectBcs: true, previousTransaction: true },
        });
        return { content: [{ type: "text", text: `Network: ${network}\n${formatJson(result)}` }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_objects",
    {
      description: "Read multiple Sui objects in one request.",
      inputSchema: z.object({
        objectIds: z.array(z.string().min(1)).min(1).max(50).describe("Sui object IDs."),
      }),
    },
    async ({ objectIds }) => {
      try {
        const network = resolveNetwork();
        const result = await createSuiClient(network).getObjects({
          objectIds,
          include: { content: true, display: true, json: true, previousTransaction: true },
        });
        return { content: [{ type: "text", text: `Network: ${network}\n${formatJson(result)}` }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "list_coins",
    {
      description: "List individual coin objects owned by an address, including balances and object IDs.",
      inputSchema: z.object({
        address: z.string().optional().describe("Owner address. Omit to use the local wallet."),
        coinType: z.string().optional().describe("Optional fully qualified coin type; defaults to SUI."),
        limit: z.number().int().min(1).max(50).optional().default(20),
      }),
    },
    async ({ address, coinType, limit }) => {
      try {
        const network = resolveNetwork();
        const owner = await resolveOwner(network, address);
        const result = await createSuiClient(network).listCoins({ owner, coinType, limit });
        return { content: [{ type: "text", text: `Network: ${network}\nOwner: ${owner}\n${formatJson(result)}` }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "list_dynamic_fields",
    {
      description: "List dynamic fields attached to a Sui object.",
      inputSchema: z.object({
        parentId: z.string().min(1).describe("Parent object ID."),
        limit: z.number().int().min(1).max(50).optional().default(20),
        includeValue: z.boolean().optional().default(false),
      }),
    },
    async ({ parentId, limit, includeValue }) => {
      try {
        const network = resolveNetwork();
        const result = await createSuiClient(network).listDynamicFields({
          parentId,
          limit,
          include: { value: includeValue },
        });
        return { content: [{ type: "text", text: `Network: ${network}\n${formatJson(result)}` }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  const dynamicFieldSchema = z.object({
    parentId: z.string().min(1).describe("Parent object ID."),
    nameType: z.string().min(1).describe("Move type of the dynamic field name."),
    nameBcsBase64: z.string().min(1).describe("BCS-encoded dynamic field name, base64-encoded."),
  });

  server.registerTool(
    "get_dynamic_field",
    {
      description: "Read a dynamic field value by its parent object and BCS-encoded name.",
      inputSchema: dynamicFieldSchema,
    },
    async ({ parentId, nameType, nameBcsBase64 }) => {
      try {
        const network = resolveNetwork();
        const result = await createSuiClient(network).getDynamicField({
          parentId,
          name: { type: nameType, bcs: decodeBase64(nameBcsBase64, "nameBcsBase64") },
        });
        return { content: [{ type: "text", text: `Network: ${network}\n${formatJson(result)}` }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_dynamic_object_field",
    {
      description: "Read the child object stored in a dynamic object field.",
      inputSchema: dynamicFieldSchema,
    },
    async ({ parentId, nameType, nameBcsBase64 }) => {
      try {
        const network = resolveNetwork();
        const result = await createSuiClient(network).getDynamicObjectField({
          parentId,
          name: { type: nameType, bcs: decodeBase64(nameBcsBase64, "nameBcsBase64") },
          include: { content: true, display: true, json: true, previousTransaction: true },
        });
        return { content: [{ type: "text", text: `Network: ${network}\n${formatJson(result)}` }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_chain_info",
    {
      description: "Read the network chain identifier, protocol configuration, system state, and reference gas price.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const network = resolveNetwork();
        const client = createSuiClient(network);
        const [chain, protocol, system, gas] = await Promise.all([
          client.getChainIdentifier(),
          client.getProtocolConfig(),
          client.getCurrentSystemState(),
          client.getReferenceGasPrice(),
        ]);
        return {
          content: [
            {
              type: "text",
              text: `Network: ${network}\n${formatJson({ chain, protocol, system, gas })}`,
            },
          ],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "list_events",
    {
      description: "Query recent Sui events by sender, event type, or emitting module.",
      inputSchema: z.object({
        sender: z.string().optional().describe("Filter by transaction sender address."),
        eventType: z.string().optional().describe("Filter by fully qualified Move event type."),
        emitModule: z.string().optional().describe("Filter by package::module."),
        limit: z.number().int().min(1).max(50).optional().default(20),
        order: z.enum(["ascending", "descending"]).optional().default("descending"),
      }).refine(
        ({ sender, eventType, emitModule }) => [sender, eventType, emitModule].filter(Boolean).length <= 1,
        "Provide at most one event filter.",
      ),
    },
    async ({ sender, eventType, emitModule, limit, order }) => {
      try {
        const network = resolveNetwork();
        const filter = sender
          ? { sender: requireAddress(sender) }
          : eventType
            ? { eventType }
            : emitModule
              ? { emitModule }
              : undefined;
        const result = await createSuiClient(network).listEvents({ filter, limit, order });
        return { content: [{ type: "text", text: `Network: ${network}\n${formatJson(result)}` }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_move_function",
    {
      description: "Inspect a Move function's visibility, entry status, parameters, and return types.",
      inputSchema: z.object({
        packageId: z.string().min(1).describe("Published package ID."),
        moduleName: z.string().min(1).describe("Move module name."),
        functionName: z.string().min(1).describe("Move function name."),
      }),
    },
    async ({ packageId, moduleName, functionName }) => {
      try {
        const network = resolveNetwork();
        const result = await createSuiClient(network).getMoveFunction({
          packageId,
          moduleName,
          name: functionName,
        });
        return { content: [{ type: "text", text: `Network: ${network}\n${formatJson(result)}` }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "resolve_name",
    {
      description: "Resolve a SuiNS name to an address, or an address to its default SuiNS name.",
      inputSchema: z.object({
        name: z.string().optional().describe("SuiNS name such as alice.sui."),
        address: z.string().optional().describe("Sui address to resolve to a SuiNS name."),
      }).refine(({ name, address }) => Boolean(name) !== Boolean(address), "Provide exactly one of name or address."),
    },
    async ({ name, address }) => {
      try {
        const network = resolveNetwork();
        const client = createSuiClient(network);
        const result = name
          ? await client.resolveNameServiceAddress({ name })
          : await client.defaultNameServiceName({ address: requireAddress(address!) });
        return { content: [{ type: "text", text: `Network: ${network}\n${formatJson(result)}` }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "resolve_mvr",
    {
      description: "Resolve Move Registry package or type names to canonical on-chain IDs.",
      inputSchema: z.object({
        packages: z.array(z.string().min(1)).max(50).optional(),
        types: z.array(z.string().min(1)).max(50).optional(),
      }).refine(({ packages, types }) => Boolean(packages?.length || types?.length), "Provide packages or types."),
    },
    async ({ packages, types }) => {
      try {
        const network = resolveNetwork();
        const result = await createSuiClient(network).mvr.resolve({ packages, types });
        return { content: [{ type: "text", text: `Network: ${network}\n${formatJson(result)}` }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
