import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { DESIGN_GUIDE } from '../shared/guide.ts';
import { TOOLS, runTool, type ToolContext } from './tools.ts';
import type { DocStore } from './store.ts';
import type { Hub } from './hub.ts';

const PRETTY_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  'codex-mcp-client': 'Codex',
  codex: 'Codex',
  'claude-ai': 'Claude',
  cursor: 'Cursor',
  'cursor-vscode': 'Cursor',
  'design-canvas-bridge': 'MCP client',
};

export function prettyClientName(raw?: string): string {
  if (!raw) return 'MCP client';
  return PRETTY_NAMES[raw] ?? PRETTY_NAMES[raw.toLowerCase()] ?? raw;
}

function buildServer(store: DocStore, hub: Hub, getSession: () => string | undefined): McpServer {
  const server = new McpServer(
    { name: 'design-canvas', title: 'Design Canvas', version: '0.1.0' },
    { instructions: DESIGN_GUIDE, capabilities: { tools: {} } },
  );
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.shape,
        annotations: {
          title: tool.title,
          readOnlyHint: !!tool.readOnly,
          destructiveHint: !!tool.destructive,
          idempotentHint: !!tool.readOnly,
          openWorldHint: false,
        },
      },
      async (args: any) => {
        const sessionId = getSession();
        const clientInfo = server.server.getClientVersion();
        // Allow a bridge to forward the real client name.
        const forwarded = clientInfo?.name === 'design-canvas-bridge' ? (clientInfo as any).title || (clientInfo as any).forwardedName : undefined;
        const agent = prettyClientName(forwarded || clientInfo?.name);
        if (sessionId) hub.touchMcpClient({ sessionId, name: agent, version: clientInfo?.version, lastTool: tool.name });
        const ctx: ToolContext = { store, hub, agent };
        const docId = store.lastActiveDocId;
        hub.agentActivity(docId, { name: agent, tool: tool.name, status: 'start' });
        const res = await runTool(tool.name, args, ctx);
        if (res.isError) hub.agentActivity(docId, { name: agent, tool: tool.name, status: 'error', message: (res.content[0] as any)?.text });
        else hub.agentActivity(docId, { name: agent, tool: tool.name, status: 'end' });
        return res as any;
      },
    );
  }
  return server;
}

/** Express handlers for the Streamable HTTP MCP endpoint at /mcp. */
export function createMcpHandlers(store: DocStore, hub: Hub) {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const post = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      if (sessionId || !isInitializeRequest(req.body)) {
        // Unknown session (e.g. server restarted) → tell the client to re-initialize.
        res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found. Reconnect.' }, id: null });
        return;
      }
      let sid: string | undefined;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          sid = id;
          transports.set(id, transport!);
          const info = (req.body?.params?.clientInfo ?? {}) as { name?: string; version?: string; title?: string };
          const name = prettyClientName(info.name === 'design-canvas-bridge' ? info.title : info.name);
          hub.touchMcpClient({ sessionId: id, name, version: info.version });
        },
      });
      transport.onclose = () => {
        if (sid) {
          transports.delete(sid);
          hub.removeMcpClient(sid);
        }
      };
      const server = buildServer(store, hub, () => sid);
      await server.connect(transport);
    }
    await transport.handleRequest(req, res, req.body);
  };

  const getOrDelete = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(sessionId ? 404 : 400).send(sessionId ? 'Session not found' : 'Missing mcp-session-id');
      return;
    }
    await transport.handleRequest(req, res);
  };

  return { post, getOrDelete, transports };
}
