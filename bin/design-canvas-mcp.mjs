#!/usr/bin/env node
/**
 * stdio ⇄ HTTP bridge for MCP clients that only speak stdio.
 *
 *   node bin/design-canvas-mcp.mjs [--url http://localhost:4410/mcp] [--name "Codex"]
 *
 * The Design Canvas server must be running (`npm start` or `npm run dev`).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const url = arg('url', process.env.DESIGN_CANVAS_MCP_URL ?? `http://localhost:${process.env.DESIGN_CANVAS_PORT ?? 4410}/mcp`);
const forcedName = arg('name', undefined);

let client = null;
let connecting = null;
let instructions;

async function connect(clientName) {
  if (client) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    const c = new Client({ name: 'design-canvas-bridge', version: '0.1.0', title: forcedName ?? clientName ?? 'MCP client' });
    await c.connect(new StreamableHTTPClientTransport(new URL(url)));
    instructions = c.getInstructions();
    client = c;
    c.onclose = () => {
      client = null;
    };
    return c;
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

// Fetch the server instructions up front (best effort) so the client gets the design guide.
try {
  await Promise.race([connect(forcedName), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
} catch {
  client = null;
}

const server = new Server({ name: 'design-canvas', version: '0.1.0' }, { capabilities: { tools: {} }, instructions });

const withRetry = async (fn) => {
  const name = server.getClientVersion()?.name;
  try {
    return await fn(await connect(name));
  } catch (err) {
    // Server restarted → session lost. Reconnect once.
    client = null;
    try {
      return await fn(await connect(name));
    } catch (err2) {
      throw new Error(
        `Cannot reach Design Canvas at ${url}. Start it with \`npm start\` (or \`npm run dev\`) in the design-canvas folder. (${err2?.message ?? err2})`,
      );
    }
  }
};

server.setRequestHandler(ListToolsRequestSchema, async () => withRetry((c) => c.listTools()));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    return await withRetry((c) => c.callTool({ name: req.params.name, arguments: req.params.arguments ?? {} }));
  } catch (err) {
    return { content: [{ type: 'text', text: String(err?.message ?? err) }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
