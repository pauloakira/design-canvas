/** Comment threads (Figma-style review comments). Draft-safe helpers. */
import type { CommentThread, DesignDoc } from './types.ts';
import { descendants, pageOf, uid } from './doc.ts';
import { absolutePosition } from './ops.ts';

export interface NewThread {
  pageId: string;
  nodeId?: string;
  /** Offset inside the node (or page coords without a node). */
  x: number;
  y: number;
  pageX: number;
  pageY: number;
  text: string;
  author: string;
  authorKind?: 'user' | 'agent';
}

function comments(doc: DesignDoc): Record<string, CommentThread> {
  return (doc.comments ??= {});
}

export function addThread(doc: DesignDoc, t: NewThread): CommentThread {
  const text = t.text.trim();
  if (!text) throw new Error('Comment text is empty');
  if (!doc.pages[t.pageId]) throw new Error(`Page "${t.pageId}" not found`);
  const all = Object.values(comments(doc));
  const now = Date.now();
  const thread: CommentThread = {
    id: 'c_' + uid(8),
    number: all.reduce((m, c) => Math.max(m, c.number), 0) + 1,
    pageId: t.pageId,
    ...(t.nodeId && doc.nodes[t.nodeId] ? { nodeId: t.nodeId } : {}),
    x: round(t.x),
    y: round(t.y),
    pageX: round(t.pageX),
    pageY: round(t.pageY),
    messages: [{ id: 'm_' + uid(8), author: t.author, ...(t.authorKind === 'agent' ? { authorKind: 'agent' as const } : {}), text, createdAt: now }],
    createdAt: now,
  };
  comments(doc)[thread.id] = thread;
  return thread;
}

export function replyToThread(doc: DesignDoc, threadId: string, text: string, author: string, authorKind?: 'user' | 'agent'): CommentThread {
  const t = comments(doc)[threadId];
  if (!t) throw new Error(`Comment thread "${threadId}" not found`);
  if (!text.trim()) throw new Error('Reply text is empty');
  t.messages.push({ id: 'm_' + uid(8), author, ...(authorKind === 'agent' ? { authorKind } : {}), text: text.trim(), createdAt: Date.now() });
  return t;
}

export function setResolved(doc: DesignDoc, threadId: string, resolved: boolean, by?: string) {
  const t = comments(doc)[threadId];
  if (!t) throw new Error(`Comment thread "${threadId}" not found`);
  if (resolved) {
    t.resolved = true;
    if (by) t.resolvedBy = by;
  } else {
    delete t.resolved;
    delete t.resolvedBy;
  }
}

export function deleteThread(doc: DesignDoc, threadId: string) {
  delete comments(doc)[threadId];
}

export function editMessage(doc: DesignDoc, threadId: string, messageId: string, text: string) {
  const m = comments(doc)[threadId]?.messages.find((x) => x.id === messageId);
  if (!m) throw new Error('Message not found');
  m.text = text.trim();
  m.editedAt = Date.now();
}

/** Delete one message; deleting the first one deletes the whole thread. */
export function deleteMessage(doc: DesignDoc, threadId: string, messageId: string) {
  const t = comments(doc)[threadId];
  if (!t) return;
  if (t.messages[0]?.id === messageId) delete comments(doc)[threadId];
  else t.messages = t.messages.filter((m) => m.id !== messageId);
}

/** Approximate page position of a pin (server side; the editor measures the DOM). */
export function threadPagePosition(doc: DesignDoc, t: CommentThread): { x: number; y: number } {
  if (t.nodeId && doc.nodes[t.nodeId]) {
    const p = absolutePosition(doc, t.nodeId);
    return { x: p.x + t.x, y: p.y + t.y };
  }
  return { x: t.pageX, y: t.pageY };
}

/** Threads attached to a node or anything inside it. */
export function threadsForNode(doc: DesignDoc, nodeId: string, includeResolved = false): CommentThread[] {
  const ids = new Set(descendants(doc, nodeId, true));
  return Object.values(doc.comments ?? {})
    .filter((t) => t.nodeId && ids.has(t.nodeId) && (includeResolved || !t.resolved))
    .sort((a, b) => a.number - b.number);
}

/** Keep threads consistent after structural edits (page deleted → threads go too). */
export function cleanupThreads(doc: DesignDoc) {
  for (const t of Object.values(comments(doc))) {
    if (!doc.pages[t.pageId]) delete comments(doc)[t.id];
    else if (t.nodeId && doc.nodes[t.nodeId] && pageOf(doc, t.nodeId) !== t.pageId) t.pageId = pageOf(doc, t.nodeId)!;
  }
}

function round(n: number) {
  return Math.round(n * 100) / 100;
}
