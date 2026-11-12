import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import "dotenv/config";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT ?? 3000);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const mcp = new Client({ name: "wallet-web", version: "1.0.0" });
let connected = false;

async function connectMcp(): Promise<void> {
  if (connected) return;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(packageRoot, "build", "index.js")],
    cwd: packageRoot,
    env: {
      ...getDefaultEnvironment(),
      SUI_NETWORK: process.env.SUI_NETWORK ?? "testnet",
      SUI_ADDRESS: process.env.SUI_ADDRESS ?? "",
      SUI_SIGNER_PORT: process.env.SUI_SIGNER_PORT ?? "38435",
      SUI_SIGNER_TOKEN: process.env.SUI_SIGNER_TOKEN ?? "",
      SUI_ENABLE_DIRECT_TRANSFER: process.env.SUI_ENABLE_DIRECT_TRANSFER ?? "",
    },
  });
  await mcp.connect(transport);
  connected = true;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function chat(message: string): Promise<string> {
  await connectMcp();
  const { tools } = await mcp.listTools();
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: message }];
  const anthropicTools: Anthropic.Tool[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  }));

  for (let round = 0; round < 8; round += 1) {
    const result = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5",
      max_tokens: 1200,
      system:
        "You are a Sui testnet wallet assistant. Use wallet tools when useful. " +
        "Never claim a transaction succeeded unless the tool confirms it.",
      messages,
      tools: anthropicTools,
    });
    messages.push({ role: "assistant", content: result.content });

    const toolUses = result.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    if (toolUses.length === 0) {
      return result.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n");
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      const toolResult = await mcp.callTool({
        name: toolUse.name,
        arguments: toolUse.input as Record<string, unknown>,
      });
      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: JSON.stringify(toolResult),
        is_error: Boolean(toolResult.isError),
      });
    }
    messages.push({ role: "user", content: toolResults });
    if (result.stop_reason !== "tool_use") break;
  }

  throw new Error("Claude reached the tool-call limit without completing a response.");
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("Missing ANTHROPIC_API_KEY. Put it in wallet-mcp/.env.");
  }
  const html = await readFile(join(packageRoot, "web", "index.html"), "utf8");
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(html);
        return;
      }
      if (request.method === "POST" && request.url === "/api/chat") {
        const body = JSON.parse(await readBody(request)) as { message?: unknown };
        if (typeof body.message !== "string" || body.message.trim() === "") {
          sendJson(response, 400, { error: "message is required" });
          return;
        }
        sendJson(response, 200, { reply: await chat(body.message) });
        return;
      }
      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: message });
    }
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Wallet web UI: http://127.0.0.1:${port}`);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
