import { getState, loadSnapshot, onAck, onRemotePatch, setSender, setState, toast, type McpClientInfo } from './store.ts';
import { handleEditorRequest } from './editor/requests.ts';
import { revealNodes, zoomToNodes } from './editor/viewport.ts';
import { openThread } from './canvas/Comments.tsx';
import { announceFigmaResult } from './editor/figma.ts';
import type { DocPatch, Origin } from '../shared/types.ts';

/** Toast when someone else (an agent or a teammate) comments. */
function announceComments(patch: DocPatch, origin: Origin) {
  if (!patch.comments || origin.kind === 'system') return;
  for (const t of Object.values(patch.comments)) {
    if (!t) continue;
    const last = t.messages[t.messages.length - 1];
    if (!last || Date.now() - last.createdAt > 10000) continue;
    const who = origin.kind === 'agent' ? origin.name : last.author;
    const verb = t.messages.length === 1 ? 'commented' : 'replied';
    toast(`${who} ${verb} on #${t.number}: ${last.text.slice(0, 80)}${last.text.length > 80 ? '…' : ''}`, {
      kind: 'agent',
      ms: 8000,
      action: { label: 'View', run: () => openThread(t.id) },
    });
  }
}

let ws: WebSocket | null = null;
let currentDoc: string | null = null;
let retry = 0;
let closedByUs = false;
let presenceTimer: ReturnType<typeof setTimeout> | null = null;

export function connect(docId: string) {
  currentDoc = docId;
  closedByUs = false;
  open();
}

export function disconnect() {
  closedByUs = true;
  currentDoc = null;
  setSender(null);
  ws?.close();
  ws = null;
}

function open() {
  if (!currentDoc) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/ws`);
  ws = sock;
  sock.onopen = () => {
    retry = 0;
    sock.send(JSON.stringify({ t: 'join', docId: currentDoc, name: userName() }));
    setSender((patch, seq) => {
      if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ t: 'patch', seq, patch }));
    });
  };
  sock.onmessage = (ev) => {
    let msg: any;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handle(msg);
  };
  sock.onclose = () => {
    if (ws === sock) {
      setSender(null);
      setState({ connected: false });
    }
    if (!closedByUs && ws === sock) {
      const delay = Math.min(5000, 300 * 2 ** retry++);
      setTimeout(open, delay);
    }
  };
}

function handle(msg: any) {
  switch (msg.t) {
    case 'hello':
      if (msg.mcpClients) setState({ mcpClients: msg.mcpClients as McpClientInfo[] });
      break;
    case 'snapshot':
      loadSnapshot(msg.doc, msg.clientId);
      sendPresence(true);
      break;
    case 'ack':
      onAck(msg.seq, msg.applied);
      break;
    case 'patch':
      onRemotePatch(msg.patch, msg.origin);
      announceComments(msg.patch, msg.origin);
      break;
    case 'presence':
      setState({ peers: (msg.peers ?? []).filter((p: any) => p.id !== getState().clientId) });
      break;
    case 'mcp-clients':
      setState({ mcpClients: msg.clients ?? [] });
      break;
    case 'agent':
      setState({ agentStatus: { name: msg.name, tool: msg.tool, status: msg.status, at: msg.at } });
      if (msg.status === 'error' && msg.message) toast(`${msg.name}: ${String(msg.message).slice(0, 160)}`, { kind: 'error' });
      break;
    case 'select':
      setState({ selection: msg.ids.filter((id: string) => getState().doc?.nodes[id]) });
      if (msg.zoom) requestAnimationFrame(() => zoomToNodes(msg.ids));
      break;
    case 'reveal':
      revealNodes(msg.ids, msg.agent);
      break;
    case 'request':
      handleEditorRequest(msg.kind, msg.payload)
        .then((data) => ws?.send(JSON.stringify({ t: 'response', reqId: msg.reqId, ok: true, data })))
        .catch((err) => ws?.send(JSON.stringify({ t: 'response', reqId: msg.reqId, ok: false, error: String(err?.message ?? err) })));
      break;
    case 'figma-result':
      announceFigmaResult(msg);
      break;
    case 'error':
      console.warn('[sync]', msg.message);
      break;
  }
}

export function sendPresence(active = false) {
  if (presenceTimer) clearTimeout(presenceTimer);
  presenceTimer = setTimeout(() => {
    const s = getState();
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'presence', selection: s.selection, pageId: s.pageId, active }));
  }, 60);
}

export function getUserName(): string {
  return userName();
}

export function setUserName(name: string) {
  const n = name.trim().slice(0, 40);
  if (!n) return;
  try {
    localStorage.setItem('dc:name', n);
  } catch {
    /* ignore */
  }
  // Rejoin so collaborators see the new name.
  if (ws?.readyState === WebSocket.OPEN && currentDoc) ws.send(JSON.stringify({ t: 'join', docId: currentDoc, name: n }));
}

function userName(): string {
  try {
    let n = localStorage.getItem('dc:name');
    if (!n) {
      n = 'Designer ' + Math.floor(Math.random() * 900 + 100);
      localStorage.setItem('dc:name', n);
    }
    return n;
  } catch {
    return 'Designer';
  }
}
