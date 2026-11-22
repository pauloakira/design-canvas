import { create } from 'zustand';
import { produce } from 'immer';
import type { DesignDoc, DocPatch, Origin } from '../shared/types.ts';
import { applyPatch, diffDocs, invertPatch, isEmptyPatch, mergePatches } from '../shared/patch.ts';
import { isPageId, pageOf } from '../shared/doc.ts';

export type Tool = 'move' | 'hand' | 'frame' | 'rect' | 'ellipse' | 'text' | 'image' | 'comment';

export interface DraftComment {
  pageId: string;
  nodeId?: string;
  x: number;
  y: number;
  pageX: number;
  pageY: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface Peer {
  id: string;
  name: string;
  color: string;
  selection: string[];
  pageId: string | null;
}

export interface McpClientInfo {
  sessionId: string;
  name: string;
  version?: string;
  connectedAt: number;
  lastSeen: number;
  lastTool?: string;
}

export interface Guide {
  axis: 'x' | 'y';
  pos: number;
  from: number;
  to: number;
}

export interface OverlayState {
  guides: Guide[];
  marquee: { x: number; y: number; width: number; height: number } | null;
  indicator: { x1: number; y1: number; x2: number; y2: number } | null;
  ghost: { x: number; y: number; width: number; height: number } | null;
  dropTarget: string | null;
  measure: boolean;
}

export interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
  kind?: 'info' | 'error' | 'agent';
}

interface HistoryEntry {
  undo: DocPatch;
  redo: DocPatch;
  selBefore: string[];
  selAfter: string[];
  key?: string;
  at: number;
}

export interface EditorState {
  docId: string | null;
  doc: DesignDoc | null;
  connected: boolean;
  clientId: string | null;
  pageId: string;
  selection: string[];
  hoverId: string | null;
  tool: Tool;
  viewport: Viewport;
  editingTextId: string | null;
  leftTab: 'layers' | 'assets' | 'tokens' | 'comments';
  openThreadId: string | null;
  draftComment: DraftComment | null;
  showComments: boolean;
  showResolved: boolean;
  rightTab: 'design' | 'code' | 'ai';
  peers: Peer[];
  mcpClients: McpClientInfo[];
  flash: Record<string, { at: number; agent: string }>;
  agentStatus: { name: string; tool: string; status: string; at: number } | null;
  overlay: OverlayState;
  toasts: Toast[];
  dialog: null | 'connect' | 'settings' | 'shortcuts';
  /** Tab to open in the Connect dialog. */
  connectTab: null | 'claude' | 'codex' | 'other' | 'figma';
  contextMenu: { x: number; y: number } | null;
  layoutTick: number;
  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];
}

export const emptyOverlay: OverlayState = { guides: [], marquee: null, indicator: null, ghost: null, dropTarget: null, measure: false };

export const useEditor = create<EditorState>(() => ({
  docId: null,
  doc: null,
  connected: false,
  clientId: null,
  pageId: '',
  selection: [],
  hoverId: null,
  tool: 'move',
  viewport: { x: 0, y: 0, zoom: 1 },
  editingTextId: null,
  leftTab: 'layers',
  openThreadId: null,
  draftComment: null,
  showComments: true,
  showResolved: false,
  rightTab: 'design',
  peers: [],
  mcpClients: [],
  flash: {},
  agentStatus: null,
  overlay: emptyOverlay,
  toasts: [],
  dialog: null,
  connectTab: null,
  contextMenu: null,
  layoutTick: 0,
  undoStack: [],
  redoStack: [],
}));

export const getState = useEditor.getState;
export const setState = useEditor.setState;

// ---------------------------------------------------------------------------
// Sync (optimistic local edits rebased on top of the server order)
// ---------------------------------------------------------------------------

type Sender = (patch: DocPatch, seq: number) => void;
let sender: Sender | null = null;
let seqCounter = 0;
let serverDoc: DesignDoc | null = null;
let pending: Array<{ seq: number; patch: DocPatch }> = [];

export function setSender(s: Sender | null) {
  sender = s;
}

export function loadSnapshot(doc: DesignDoc, clientId: string) {
  serverDoc = doc;
  const prev = getState();
  // Re-send anything that was pending before a reconnect.
  const local = pending.reduce((d, p) => applyPatch(d, p.patch), doc);
  const resend = pending;
  pending = [];
  const pageId = prev.docId === doc.id && doc.pages[prev.pageId] ? prev.pageId : doc.pageOrder[0];
  setState({
    doc: local,
    docId: doc.id,
    clientId,
    pageId,
    selection: prev.docId === doc.id ? prev.selection.filter((id) => local.nodes[id]) : [],
    connected: true,
  });
  for (const p of resend) sendPatch(p.patch);
}

function sendPatch(patch: DocPatch) {
  const seq = ++seqCounter;
  pending.push({ seq, patch });
  sender?.(patch, seq);
}

export function onAck(seq: number, applied: DocPatch) {
  const i = pending.findIndex((p) => p.seq === seq);
  const sent = i >= 0 ? pending[i].patch : null;
  if (i >= 0) pending.splice(i, 1);
  if (!serverDoc) return;
  serverDoc = applyPatch(serverDoc, applied);
  // If the server changed more than we sent (structural repairs), rebase.
  const extra =
    !sent ||
    Object.keys(applied.nodes ?? {}).some((k) => !(sent.nodes && k in sent.nodes)) ||
    Object.keys(applied.pages ?? {}).some((k) => !(sent.pages && k in sent.pages));
  if (extra) {
    const local = pending.reduce((d, p) => applyPatch(d, p.patch), serverDoc);
    setState({ doc: local });
  }
}

export function onRemotePatch(patch: DocPatch, origin: Origin) {
  if (!serverDoc) return;
  serverDoc = applyPatch(serverDoc, patch);
  const local = pending.reduce((d, p) => applyPatch(d, p.patch), serverDoc);
  const s = getState();
  const selection = s.selection.filter((id) => local.nodes[id]);
  const pageId = local.pages[s.pageId] ? s.pageId : local.pageOrder[0];
  const update: Partial<EditorState> = { doc: local, selection, pageId };
  if (origin.kind === 'agent' && patch.nodes) {
    const flash = { ...s.flash };
    const now = Date.now();
    for (const [id, n] of Object.entries(patch.nodes)) if (n && isPageId(local, n.parentId)) flash[id] = { at: now, agent: origin.name };
    // Also flash the top-most changed ancestors on the current page.
    for (const id of Object.keys(patch.nodes)) {
      if (local.nodes[id] && pageOf(local, id) === pageId) flash[id] = { at: now, agent: origin.name };
    }
    update.flash = flash;
  }
  setState(update);
}

// ---------------------------------------------------------------------------
// Commits & history
// ---------------------------------------------------------------------------

export interface CommitOptions {
  /** false → not undoable (e.g. layout measurements). */
  history?: boolean;
  /** Consecutive commits with the same key within 1.2s merge into one undo step. */
  key?: string;
  selectionAfter?: string[];
}

export function commit(recipe: (d: DesignDoc) => void, opts: CommitOptions = {}): DocPatch | null {
  const s = getState();
  if (!s.doc) return null;
  const before = s.doc;
  const next = produce(before, (d) => {
    recipe(d as DesignDoc);
  });
  if (next === before) {
    if (opts.selectionAfter) setState({ selection: opts.selectionAfter });
    return null;
  }
  const patch = diffDocs(before, next);
  if (isEmptyPatch(patch)) return null;
  const update: Partial<EditorState> = { doc: next };
  const selAfter = (opts.selectionAfter ?? s.selection).filter((id) => next.nodes[id]);
  update.selection = selAfter;
  if (opts.history !== false) {
    const undo = invertPatch(before, patch);
    const last = s.undoStack[s.undoStack.length - 1];
    const now = Date.now();
    if (opts.key && last && last.key === opts.key && now - last.at < 1200) {
      const merged: HistoryEntry = {
        ...last,
        undo: mergePatches(undo, last.undo),
        redo: mergePatches(last.redo, patch),
        selAfter,
        at: now,
      };
      update.undoStack = [...s.undoStack.slice(0, -1), merged];
    } else {
      update.undoStack = [...s.undoStack.slice(-199), { undo, redo: patch, selBefore: s.selection, selAfter, key: opts.key, at: now }];
    }
    update.redoStack = [];
  }
  setState(update);
  sendPatch(patch);
  return patch;
}

/** Apply a raw patch locally (no history) and sync it. */
function applyLocal(patch: DocPatch, selection: string[]) {
  const s = getState();
  if (!s.doc) return;
  const next = applyPatch(s.doc, patch);
  setState({ doc: next, selection: selection.filter((id) => next.nodes[id]) });
  sendPatch(patch);
}

export function undo() {
  const s = getState();
  const e = s.undoStack[s.undoStack.length - 1];
  if (!e || !s.doc) return;
  setState({ undoStack: s.undoStack.slice(0, -1), redoStack: [...s.redoStack, e], editingTextId: null });
  applyLocal(e.undo, e.selBefore);
}

export function redo() {
  const s = getState();
  const e = s.redoStack[s.redoStack.length - 1];
  if (!e || !s.doc) return;
  setState({ redoStack: s.redoStack.slice(0, -1), undoStack: [...s.undoStack, e] });
  applyLocal(e.redo, e.selAfter);
}

/** Group several commits (e.g. a drag) into one undo step. */
let txnKeyCounter = 0;
export function newGestureKey(prefix = 'gesture') {
  return `${prefix}-${++txnKeyCounter}`;
}

// ---------------------------------------------------------------------------
// Misc state helpers
// ---------------------------------------------------------------------------

export function setSelection(ids: string[]) {
  const s = getState();
  if (s.selection.length === ids.length && s.selection.every((v, i) => v === ids[i])) return;
  setState({ selection: ids, editingTextId: s.editingTextId && ids.includes(s.editingTextId) ? s.editingTextId : null });
}

export function setTool(tool: Tool) {
  setState((s) => ({ tool, editingTextId: null, draftComment: tool === 'comment' ? s.draftComment : null }));
}

let toastId = 0;
export function toast(text: string, opts: Partial<Omit<Toast, 'id' | 'text'>> & { ms?: number } = {}) {
  const id = ++toastId;
  setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, action: opts.action, kind: opts.kind }] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), opts.ms ?? 4000);
}

export function setOverlay(o: Partial<OverlayState>) {
  setState((s) => ({ overlay: { ...s.overlay, ...o } }));
}

export function resetEditor() {
  pending = [];
  serverDoc = null;
  setState({
    doc: null,
    docId: null,
    selection: [],
    hoverId: null,
    editingTextId: null,
    undoStack: [],
    redoStack: [],
    flash: {},
    overlay: emptyOverlay,
    connected: false,
    openThreadId: null,
    draftComment: null,
  });
}
