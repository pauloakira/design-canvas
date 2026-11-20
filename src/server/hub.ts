import type { WebSocket } from 'ws';
import type { DocPatch } from '../shared/types.ts';
import { uid } from '../shared/doc.ts';
import type { DocStore, PatchEvent } from './store.ts';

interface Client {
  id: string;
  ws: WebSocket;
  docId: string | null;
  name: string;
  color: string;
  selection: string[];
  pageId: string | null;
  lastActive: number;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface McpClientInfo {
  sessionId: string;
  name: string;
  version?: string;
  connectedAt: number;
  lastSeen: number;
  lastTool?: string;
}

const COLORS = ['#f97316', '#22c55e', '#3b82f6', '#a855f7', '#ec4899', '#14b8a6', '#eab308'];

export class Hub {
  private clients = new Map<string, Client>();
  private pending = new Map<string, Pending>();
  mcpClients = new Map<string, McpClientInfo>();

  constructor(private store: DocStore) {
    store.on('patch', (e: PatchEvent) => {
      for (const c of this.clients.values()) {
        if (c.docId !== e.docId) continue;
        if (e.origin.kind === 'user' && e.origin.clientId === c.id) continue;
        this.send(c, { t: 'patch', patch: e.patch, version: e.version, origin: e.origin });
      }
    });
  }

  handleConnection(ws: WebSocket) {
    const client: Client = {
      id: uid(8),
      ws,
      docId: null,
      name: 'Guest',
      color: COLORS[this.clients.size % COLORS.length],
      selection: [],
      pageId: null,
      lastActive: Date.now(),
    };
    this.clients.set(client.id, client);
    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      try {
        this.onMessage(client, msg);
      } catch (err: any) {
        this.send(client, { t: 'error', message: err?.message ?? String(err), seq: msg?.seq });
      }
    });
    ws.on('close', () => {
      const docId = client.docId;
      this.clients.delete(client.id);
      if (docId) this.broadcastPresence(docId);
    });
    this.send(client, { t: 'hello', clientId: client.id, mcpClients: [...this.mcpClients.values()] });
  }

  private onMessage(c: Client, msg: any) {
    switch (msg.t) {
      case 'join': {
        const entry = this.store.get(msg.docId);
        const prevDoc = c.docId;
        c.docId = msg.docId;
        c.name = typeof msg.name === 'string' ? msg.name.slice(0, 40) : c.name;
        c.lastActive = Date.now();
        this.store.lastActiveDocId = msg.docId;
        this.send(c, { t: 'snapshot', doc: entry.doc, version: entry.version, clientId: c.id, color: c.color });
        if (prevDoc && prevDoc !== msg.docId) this.broadcastPresence(prevDoc);
        this.broadcastPresence(msg.docId);
        break;
      }
      case 'patch': {
        if (!c.docId) throw new Error('Not joined');
        c.lastActive = Date.now();
        const { applied, version } = this.store.applyPatch(c.docId, msg.patch as DocPatch, {
          kind: 'user',
          clientId: c.id,
          name: c.name,
        });
        this.send(c, { t: 'ack', seq: msg.seq, applied, version });
        break;
      }
      case 'presence': {
        c.selection = Array.isArray(msg.selection) ? msg.selection.slice(0, 500) : [];
        c.pageId = msg.pageId ?? null;
        if (msg.active) {
          c.lastActive = Date.now();
          if (c.docId) this.store.lastActiveDocId = c.docId;
        }
        if (c.docId) this.broadcastPresence(c.docId);
        break;
      }
      case 'response': {
        const p = this.pending.get(msg.reqId);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.reqId);
        if (msg.ok) p.resolve(msg.data);
        else p.reject(new Error(msg.error ?? 'Editor request failed'));
        break;
      }
      case 'ping':
        this.send(c, { t: 'pong' });
        break;
    }
  }

  private send(c: Client, msg: unknown) {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
  }

  broadcast(docId: string | null, msg: unknown) {
    for (const c of this.clients.values()) if (!docId || c.docId === docId) this.send(c, msg);
  }

  private broadcastPresence(docId: string) {
    const peers = [...this.clients.values()]
      .filter((c) => c.docId === docId)
      .map((c) => ({ id: c.id, name: c.name, color: c.color, selection: c.selection, pageId: c.pageId }));
    this.broadcast(docId, { t: 'presence', peers });
  }

  /** The editor client most recently active on a document. */
  activeClient(docId?: string | null): Client | null {
    let best: Client | null = null;
    for (const c of this.clients.values()) {
      if (!c.docId) continue;
      if (docId && c.docId !== docId) continue;
      if (!best || c.lastActive > best.lastActive) best = c;
    }
    return best;
  }

  selection(docId?: string | null): { docId: string; pageId: string | null; ids: string[] } | null {
    const c = this.activeClient(docId);
    if (!c || !c.docId) return null;
    return { docId: c.docId, pageId: c.pageId, ids: c.selection };
  }

  editorOpen(docId: string): boolean {
    return !!this.activeClient(docId);
  }

  /** Ask an open editor to do something only a browser can (screenshots, HTML import). */
  request<T = any>(docId: string, kind: string, payload: unknown, timeoutMs = 20000): Promise<T> {
    const c = this.activeClient(docId);
    if (!c) {
      return Promise.reject(
        new Error(`No editor has document ${docId} open. Open it in Design Canvas (the browser editor) and try again.`),
      );
    }
    const reqId = uid(10);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`Editor did not respond to "${kind}" in time`));
      }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      this.send(c, { t: 'request', reqId, kind, payload });
    });
  }

  touchMcpClient(info: Omit<McpClientInfo, 'connectedAt' | 'lastSeen'> & { lastTool?: string }) {
    const existing = this.mcpClients.get(info.sessionId);
    const now = Date.now();
    // Sessions are rarely closed explicitly; forget ones idle for over 2 hours.
    for (const [k, v] of this.mcpClients) if (now - v.lastSeen > 2 * 3600_000) this.mcpClients.delete(k);
    this.mcpClients.set(info.sessionId, {
      ...existing,
      ...info,
      connectedAt: existing?.connectedAt ?? now,
      lastSeen: now,
    } as McpClientInfo);
    this.broadcast(null, { t: 'mcp-clients', clients: [...this.mcpClients.values()] });
  }

  removeMcpClient(sessionId: string) {
    if (this.mcpClients.delete(sessionId)) this.broadcast(null, { t: 'mcp-clients', clients: [...this.mcpClients.values()] });
  }

  agentActivity(docId: string | null, payload: { name: string; tool: string; status: 'start' | 'end' | 'error'; message?: string }) {
    this.broadcast(docId, { t: 'agent', ...payload, at: Date.now() });
  }
}
