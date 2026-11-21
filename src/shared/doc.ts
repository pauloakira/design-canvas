import type { DesignDoc, FrameNode, InstanceNode, Page, SceneNode, TextNode } from './types.ts';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function uid(len = 10): string {
  let out = '';
  const bytes = new Uint8Array(len);
  globalThis.crypto.getRandomValues(bytes);
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function createDoc(name = 'Untitled'): DesignDoc {
  const pageId = 'p_' + uid(8);
  const now = Date.now();
  return {
    id: uid(12),
    name,
    schema: 1,
    createdAt: now,
    updatedAt: now,
    pageOrder: [pageId],
    pages: { [pageId]: { id: pageId, name: 'Page 1', children: [] } },
    nodes: {},
    variables: {},
    comments: {},
  };
}

export function isPageId(doc: DesignDoc, id: string): boolean {
  return Object.prototype.hasOwnProperty.call(doc.pages, id);
}

export function isFrameLike(n: SceneNode | undefined | null): n is FrameNode {
  return !!n && (n.type === 'frame' || n.type === 'component');
}

export function isContainer(n: SceneNode | undefined | null): n is FrameNode {
  return isFrameLike(n);
}

export function isAutoLayout(n: SceneNode | undefined | null): boolean {
  return isFrameLike(n) && !!n.layout && n.layout.mode !== 'none';
}

/** True if the node is laid out by its parent's flexbox. */
export function isInFlow(doc: DesignDoc, n: SceneNode): boolean {
  const p = doc.nodes[n.parentId];
  return !!p && isAutoLayout(p) && n.position !== 'absolute';
}

export function childIds(doc: DesignDoc, parentId: string): string[] {
  const p = doc.pages[parentId];
  if (p) return p.children;
  const n = doc.nodes[parentId];
  return isFrameLike(n) ? n.children : [];
}

/** Page id the node lives on. */
export function pageOf(doc: DesignDoc, id: string): string | null {
  let cur: string | undefined = id;
  let guard = 0;
  while (cur && guard++ < 10000) {
    if (isPageId(doc, cur)) return cur;
    const n: SceneNode | undefined = doc.nodes[cur];
    if (!n) return null;
    cur = n.parentId;
  }
  return null;
}

/** Ancestors from top-level node down to the node itself (pages excluded). */
export function pathOf(doc: DesignDoc, id: string): string[] {
  const out: string[] = [];
  let cur: string | undefined = id;
  let guard = 0;
  while (cur && doc.nodes[cur] && guard++ < 10000) {
    out.unshift(cur);
    cur = doc.nodes[cur].parentId;
  }
  return out;
}

export function isAncestor(doc: DesignDoc, ancestorId: string, id: string): boolean {
  let cur: string | undefined = doc.nodes[id]?.parentId;
  let guard = 0;
  while (cur && guard++ < 10000) {
    if (cur === ancestorId) return true;
    cur = doc.nodes[cur]?.parentId;
  }
  return false;
}

export function descendants(doc: DesignDoc, id: string, includeSelf = false): string[] {
  const out: string[] = includeSelf ? [id] : [];
  const stack = [...childIds(doc, id)].reverse();
  while (stack.length) {
    const cid = stack.pop()!;
    if (!doc.nodes[cid]) continue;
    out.push(cid);
    const kids = childIds(doc, cid);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return out;
}

/** Remove ids whose ancestor is also in the list (keeps top-most). */
export function topLevelOnly(doc: DesignDoc, ids: string[]): string[] {
  const set = new Set(ids);
  return ids.filter((id) => {
    let cur = doc.nodes[id]?.parentId;
    while (cur && doc.nodes[cur]) {
      if (set.has(cur)) return false;
      cur = doc.nodes[cur].parentId;
    }
    return true;
  });
}

/** Sort ids by document (paint) order. */
export function sortByDocOrder(doc: DesignDoc, ids: string[]): string[] {
  const order = new Map<string, number>();
  let i = 0;
  for (const pid of doc.pageOrder) {
    for (const id of descendants(doc, pid)) order.set(id, i++);
  }
  return [...ids].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

export function getText(n: SceneNode): string | undefined {
  return n.type === 'text' ? (n as TextNode).text : undefined;
}

/** Remove a node id from its parent's children (draft-safe). */
export function detachFromParent(doc: DesignDoc, id: string) {
  const n = doc.nodes[id];
  if (!n) return;
  const list = parentChildren(doc, n.parentId);
  if (!list) return;
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
}

export function parentChildren(doc: DesignDoc, parentId: string): string[] | null {
  const p: Page | undefined = doc.pages[parentId];
  if (p) return p.children;
  const n = doc.nodes[parentId];
  return isFrameLike(n) ? n.children : null;
}

/** Insert (draft-safe). index < 0 or undefined → append (on top). */
export function attachToParent(doc: DesignDoc, id: string, parentId: string, index?: number) {
  const list = parentChildren(doc, parentId);
  if (!list) throw new Error(`Parent ${parentId} cannot contain children`);
  const existing = list.indexOf(id);
  if (existing >= 0) list.splice(existing, 1);
  if (index === undefined || index < 0 || index > list.length) list.push(id);
  else list.splice(index, 0, id);
  doc.nodes[id].parentId = parentId;
}

/** Delete a node and all its descendants (draft-safe). */
export function deleteNode(doc: DesignDoc, id: string) {
  if (!doc.nodes[id]) return;
  const all = descendants(doc, id, true);
  detachFromParent(doc, id);
  for (const d of all) delete doc.nodes[d];
  // Instances whose main component is gone become orphans; keep them (rendered as placeholder).
}

/**
 * Deep-copies a subtree into plain objects with fresh ids. Returns the new
 * root id and a map of new nodes (not yet attached to any parent).
 */
export function cloneSubtree(
  doc: DesignDoc,
  id: string,
  idMap: Map<string, string> = new Map(),
): { rootId: string; nodes: Record<string, SceneNode> } {
  const nodes: Record<string, SceneNode> = {};
  const all = descendants(doc, id, true);
  for (const old of all) idMap.set(old, uid());
  for (const old of all) {
    const src = doc.nodes[old];
    // JSON copy (not structuredClone): works on immer draft proxies too.
    const copy = JSON.parse(JSON.stringify(src)) as SceneNode;
    copy.id = idMap.get(old)!;
    if (old !== id) copy.parentId = idMap.get(src.parentId) ?? src.parentId;
    if (isFrameLike(copy)) copy.children = copy.children.map((c) => idMap.get(c) ?? c);
    nodes[copy.id] = copy;
  }
  return { rootId: idMap.get(id)!, nodes };
}

/** Repairs parent/children inconsistencies. Returns ids of nodes/pages that changed. */
export function repairDoc(doc: DesignDoc): { nodes: Set<string>; pages: Set<string> } {
  const changedNodes = new Set<string>();
  const changedPages = new Set<string>();
  const seen = new Set<string>();
  const containers: Array<[string, string[]]> = [];
  for (const pid of doc.pageOrder) if (doc.pages[pid]) containers.push([pid, doc.pages[pid].children]);
  for (const n of Object.values(doc.nodes)) if (isFrameLike(n)) containers.push([n.id, n.children]);

  for (const [cid, kids] of containers) {
    const clean = kids.filter((k) => {
      const ok = !!doc.nodes[k] && doc.nodes[k].parentId === cid && !seen.has(k);
      if (ok) seen.add(k);
      return ok;
    });
    if (clean.length !== kids.length) {
      if (doc.pages[cid]) {
        doc.pages[cid] = { ...doc.pages[cid], children: clean };
        changedPages.add(cid);
      } else {
        doc.nodes[cid] = { ...(doc.nodes[cid] as FrameNode), children: clean };
        changedNodes.add(cid);
      }
    }
  }
  // Orphans: nodes not referenced by their parent.
  for (const n of Object.values(doc.nodes)) {
    if (seen.has(n.id)) continue;
    const parentIsPage = !!doc.pages[n.parentId];
    const parentNode = doc.nodes[n.parentId];
    if (parentIsPage) {
      doc.pages[n.parentId] = { ...doc.pages[n.parentId], children: [...doc.pages[n.parentId].children, n.id] };
      changedPages.add(n.parentId);
      seen.add(n.id);
    } else if (isFrameLike(parentNode)) {
      doc.nodes[parentNode.id] = { ...parentNode, children: [...parentNode.children, n.id] };
      changedNodes.add(parentNode.id);
      seen.add(n.id);
    } else {
      // Parent vanished: move to first page.
      const pid = doc.pageOrder[0];
      doc.nodes[n.id] = { ...n, parentId: pid };
      doc.pages[pid] = { ...doc.pages[pid], children: [...doc.pages[pid].children, n.id] };
      changedNodes.add(n.id);
      changedPages.add(pid);
      seen.add(n.id);
    }
  }
  return { nodes: changedNodes, pages: changedPages };
}

export function componentOf(doc: DesignDoc, inst: InstanceNode): FrameNode | null {
  const c = doc.nodes[inst.componentId];
  return c && c.type === 'component' ? (c as FrameNode) : null;
}

export function findNodes(
  doc: DesignDoc,
  pred: (n: SceneNode) => boolean,
  rootId?: string,
): SceneNode[] {
  const ids = rootId ? descendants(doc, rootId, true) : doc.pageOrder.flatMap((p) => descendants(doc, p));
  return ids.map((i) => doc.nodes[i]).filter((n) => n && pred(n));
}

/** Rightmost edge of all top-level nodes on a page (for placing new content). */
export function pageContentBounds(doc: DesignDoc, pageId: string) {
  const kids = doc.pages[pageId]?.children ?? [];
  if (!kids.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const k of kids) {
    const n = doc.nodes[k];
    if (!n) continue;
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  }
  return { minX, minY, maxX, maxY };
}

export function uniqueName(doc: DesignDoc, base: string): string {
  const names = new Set(Object.values(doc.nodes).map((n) => n.name));
  if (!names.has(base)) return base;
  let i = 2;
  while (names.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

export const DEFAULT_NAMES: Record<string, string> = {
  frame: 'Frame',
  component: 'Component',
  instance: 'Instance',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  text: 'Text',
  image: 'Image',
  svg: 'Vector',
};
