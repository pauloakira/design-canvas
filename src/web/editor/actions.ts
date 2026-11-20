import type { DesignDoc, FrameNode, SceneNode } from '../../shared/types.ts';
import {
  cloneSubtree,
  descendants,
  isAutoLayout,
  isFrameLike,
  isPageId,
  parentChildren,
  sortByDocOrder,
  topLevelOnly,
  uniqueName,
} from '../../shared/doc.ts';
import {
  createComponent,
  createInstance,
  createNodes,
  deleteNodes,
  detachInstance,
  duplicateNodes,
  unwrapFrame,
  wrapInFrame,
} from '../../shared/ops.ts';
import { generateCode } from '../../shared/codegen.ts';
import { commit, getState, setSelection, setState, toast } from '../store.ts';
import { measure, toWorld, viewportSize, zoomToNodes, type Rect } from './viewport.ts';
import { captureScreenshot } from './screenshot.ts';

const CLIP_MARK = 'design-canvas/nodes';

export function selected(): string[] {
  const s = getState();
  return s.doc ? s.selection.filter((id) => s.doc!.nodes[id]) : [];
}

/** Rect of a node relative to its parent (from the DOM), falling back to doc values. */
export function parentRelativeRect(id: string): Rect {
  const doc = getState().doc!;
  const n = doc.nodes[id];
  const r = measure(id);
  if (!r) return { x: n.x, y: n.y, width: n.width, height: n.height };
  if (isPageId(doc, n.parentId)) return { x: n.x, y: n.y, width: r.width, height: r.height };
  const pr = measure(n.parentId);
  if (!pr) return { x: n.x, y: n.y, width: r.width, height: r.height };
  return { x: r.x - pr.x, y: r.y - pr.y, width: r.width, height: r.height };
}

export function deleteSelection() {
  const ids = selected();
  if (!ids.length) return;
  const doc = getState().doc!;
  const parent = doc.nodes[ids[0]].parentId;
  commit((d) => deleteNodes(d, ids), { selectionAfter: isPageId(doc, parent) ? [] : [] });
}

export function duplicateSelection() {
  const ids = selected();
  if (!ids.length) return;
  let out: string[] = [];
  commit(
    (d) => {
      out = duplicateNodes(d, ids, { x: 20, y: 20 });
    },
    {},
  );
  setSelection(out);
}

export function selectAll() {
  const s = getState();
  if (!s.doc) return;
  const sel = selected();
  const parentId = sel.length ? s.doc.nodes[sel[0]].parentId : s.pageId;
  setSelection([...(parentChildren(s.doc, parentId) ?? [])].filter((id) => s.doc!.nodes[id]?.visible !== false && !s.doc!.nodes[id]?.locked));
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

interface ClipPayload {
  kind: typeof CLIP_MARK;
  rootIds: string[];
  nodes: Record<string, SceneNode>;
  parents: Record<string, string>;
}

function serializeSelection(): ClipPayload | null {
  const s = getState();
  const doc = s.doc;
  if (!doc) return null;
  const ids = sortByDocOrder(doc, topLevelOnly(doc, selected()));
  if (!ids.length) return null;
  const nodes: Record<string, SceneNode> = {};
  const parents: Record<string, string> = {};
  for (const id of ids) {
    parents[id] = doc.nodes[id].parentId;
    for (const d of descendants(doc, id, true)) nodes[d] = doc.nodes[d];
    // Include main components of instances so paste across docs works.
    for (const d of descendants(doc, id, true)) {
      const n = doc.nodes[d];
      if (n.type === 'instance' && doc.nodes[n.componentId] && !nodes[n.componentId]) {
        for (const c of descendants(doc, n.componentId, true)) nodes[c] = doc.nodes[c];
      }
    }
  }
  return { kind: CLIP_MARK, rootIds: ids, nodes, parents };
}

let memoryClipboard: ClipPayload | null = null;

export async function copySelection() {
  const p = serializeSelection();
  if (!p) return;
  memoryClipboard = p;
  try {
    await navigator.clipboard.writeText(JSON.stringify(p));
  } catch {
    /* memory clipboard still works */
  }
  toast(`Copied ${p.rootIds.length} layer${p.rootIds.length > 1 ? 's' : ''}`);
}

export async function cutSelection() {
  await copySelection();
  deleteSelection();
}

export function pastePayload(p: ClipPayload) {
  const s = getState();
  const doc = s.doc!;
  const sel = selected();
  // Paste target: selected container, else the original parent if on this page, else the page.
  let target = s.pageId;
  if (sel.length === 1 && isFrameLike(doc.nodes[sel[0]]) && !p.rootIds.includes(sel[0])) target = sel[0];
  else if (sel.length) target = doc.nodes[sel[0]].parentId;
  else if (p.rootIds.length && doc.nodes[p.parents[p.rootIds[0]]] && isFrameLike(doc.nodes[p.parents[p.rootIds[0]]])) target = p.parents[p.rootIds[0]];
  const newIds: string[] = [];
  commit((d) => {
    // Temporary doc view containing the clipboard nodes to reuse cloneSubtree.
    const tmp: DesignDoc = { ...d, nodes: { ...p.nodes } } as DesignDoc;
    const idMap = new Map<string, string>();
    // Ensure referenced components exist in this doc.
    for (const n of Object.values(p.nodes)) {
      if (n.type === 'component' && !d.nodes[n.id] && !p.rootIds.includes(n.id)) {
        const { rootId, nodes } = cloneSubtree(tmp, n.id, new Map());
        Object.assign(d.nodes, nodes);
        d.nodes[rootId].parentId = s.pageId;
        d.nodes[rootId].x = -400;
        d.pages[s.pageId].children.unshift(rootId);
        idMap.set(n.id, rootId);
      }
    }
    for (const rid of p.rootIds) {
      const { rootId, nodes } = cloneSubtree(tmp, rid, new Map());
      for (const nn of Object.values(nodes)) {
        if (nn.type === 'instance' && idMap.has(nn.componentId)) nn.componentId = idMap.get(nn.componentId)!;
      }
      Object.assign(d.nodes, nodes);
      const root = d.nodes[rootId];
      root.parentId = target;
      const sameParent = p.parents[rid] === target;
      if (sameParent && !isAutoLayout(d.nodes[target])) {
        root.x += 20;
        root.y += 20;
      } else if (isPageId(d, target) && !sameParent) {
        const { width, height } = viewportSize();
        const c = toWorld(width / 2, height / 2);
        root.x = Math.round(c.x - root.width / 2);
        root.y = Math.round(c.y - root.height / 2);
      }
      if (isPageId(d, target)) {
        if (root.widthMode === 'fill') root.widthMode = 'fixed';
        if (root.heightMode === 'fill') root.heightMode = 'fixed';
      }
      parentChildren(d, target)!.push(rootId);
      newIds.push(rootId);
    }
  });
  setSelection(newIds);
}

export async function pasteFromEvent(e: ClipboardEvent) {
  const dt = e.clipboardData;
  if (!dt) return;
  const files = Array.from(dt.files).filter((f) => f.type.startsWith('image/'));
  if (files.length) {
    e.preventDefault();
    for (const f of files) await insertImageFile(f);
    return;
  }
  const textData = dt.getData('text/plain');
  if (textData) {
    e.preventDefault();
    pasteText(textData);
    return;
  }
  if (memoryClipboard) pastePayload(memoryClipboard);
}

export function pasteText(textData: string) {
  try {
    const p = JSON.parse(textData);
    if (p?.kind === CLIP_MARK) {
      pastePayload(p);
      return;
    }
  } catch {
    /* not ours */
  }
  const t = textData.trim();
  const { width, height } = viewportSize();
  const c = toWorld(width / 2, height / 2);
  const s = getState();
  const sel = selected();
  const parent = sel.length === 1 && isFrameLike(s.doc!.nodes[sel[0]]) ? sel[0] : s.pageId;
  let ids: string[] = [];
  if (/^<svg[\s>]/i.test(t)) {
    const vb = t.match(/viewBox="[\d.\s-]*?([\d.]+)\s+([\d.]+)"/);
    const w = vb ? parseFloat(vb[1]) : 24;
    const h = vb ? parseFloat(vb[2]) : 24;
    commit((d) => {
      ids = createNodes(d, [{ type: 'svg', name: 'Vector', svg: t, width: w, height: h, x: Math.round(c.x - w / 2), y: Math.round(c.y - h / 2) }], parent).ids;
    });
  } else {
    commit((d) => {
      ids = createNodes(d, [{ type: 'text', text: t.slice(0, 5000), x: Math.round(c.x), y: Math.round(c.y), ...(t.length > 60 ? { width: 400 } : {}) }], parent).ids;
    });
  }
  setSelection(ids);
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

export function groupSelection(withLayout = false) {
  const ids = selected();
  if (!ids.length) return;
  const doc = getState().doc!;
  const parent = doc.nodes[ids[0]].parentId;
  const siblings = ids.filter((id) => doc.nodes[id].parentId === parent);
  const rects: Record<string, Rect> = {};
  for (const id of siblings) rects[id] = parentRelativeRect(id);
  let fid: string | null = null;
  commit((d) => {
    let layout: FrameNode['layout'] | undefined;
    if (withLayout) {
      // Guess direction from geometry.
      const rs = siblings.map((id) => rects[id]);
      const spreadX = Math.max(...rs.map((r) => r.x)) - Math.min(...rs.map((r) => r.x));
      const spreadY = Math.max(...rs.map((r) => r.y)) - Math.min(...rs.map((r) => r.y));
      layout = { mode: spreadX > spreadY ? 'row' : 'column', gap: 8, padding: [0, 0, 0, 0], align: 'start' };
    }
    fid = wrapInFrame(d, siblings, { name: withLayout ? uniqueName(d, 'Frame') : uniqueName(d, 'Group'), rects, layout });
  });
  if (fid) setSelection([fid]);
}

export function ungroupSelection() {
  const ids = selected();
  const doc = getState().doc!;
  const frames = ids.filter((id) => doc.nodes[id]?.type === 'frame');
  if (!frames.length) return;
  let kids: string[] = [];
  commit((d) => {
    for (const f of frames) kids.push(...unwrapFrame(d, f));
  });
  setSelection(kids);
}

/** Shift+A: add auto layout to a frame, or wrap the selection in an auto-layout frame. */
export function addAutoLayout() {
  const ids = selected();
  if (!ids.length) return;
  const doc = getState().doc!;
  const n = doc.nodes[ids[0]];
  if (ids.length === 1 && isFrameLike(n)) {
    if (n.layout && n.layout.mode !== 'none') {
      commit((d) => {
        (d.nodes[n.id] as FrameNode).layout = { ...(d.nodes[n.id] as FrameNode).layout!, mode: 'none' };
      });
      return;
    }
    // Infer direction from children positions.
    const kids = n.children.map((c) => doc.nodes[c]).filter(Boolean);
    const spreadX = kids.length ? Math.max(...kids.map((k) => k.x)) - Math.min(...kids.map((k) => k.x)) : 0;
    const spreadY = kids.length ? Math.max(...kids.map((k) => k.y)) - Math.min(...kids.map((k) => k.y)) : 0;
    const mode = spreadX > spreadY ? 'row' : 'column';
    commit((d) => {
      const f = d.nodes[n.id] as FrameNode;
      const axis = mode === 'row' ? 'x' : 'y';
      f.children.sort((a, b) => d.nodes[a][axis] - d.nodes[b][axis]);
      const minX = Math.min(...kids.map((k) => k.x), 0);
      const minY = Math.min(...kids.map((k) => k.y), 0);
      const pad = kids.length ? Math.max(0, Math.round(Math.min(...kids.map((k) => (mode === 'row' ? k.y : k.x))))) : 16;
      f.layout = { mode, gap: 10, padding: [pad, pad, pad, pad], align: 'start' };
      void minX;
      void minY;
      if (kids.length) {
        f.widthMode = 'hug';
        f.heightMode = 'hug';
      }
    });
    return;
  }
  groupSelection(true);
}

export function makeComponent() {
  const ids = selected();
  if (ids.length !== 1) {
    if (ids.length > 1) {
      groupSelection(false);
      return makeComponent();
    }
    return;
  }
  let cid = '';
  commit((d) => {
    cid = createComponent(d, ids[0]);
  });
  setSelection([cid]);
  toast('Created component. Find it in Assets.');
}

export function detachSelection() {
  const ids = selected().filter((id) => getState().doc!.nodes[id]?.type === 'instance');
  if (!ids.length) return;
  commit((d) => {
    for (const id of ids) detachInstance(d, id);
  });
}

export function insertInstance(componentId: string, at?: { x: number; y: number }, parentId?: string) {
  const s = getState();
  const comp = s.doc!.nodes[componentId];
  if (!comp) return;
  const { width, height } = viewportSize();
  const c = at ?? toWorld(width / 2, height / 2);
  let id = '';
  const sel = selected();
  const parent = parentId ?? (sel.length === 1 && isFrameLike(s.doc!.nodes[sel[0]]) && sel[0] !== componentId ? sel[0] : s.pageId);
  try {
    commit((d) => {
      id = createInstance(d, componentId, parent, { x: Math.round(c.x - (at ? 0 : comp.width / 2)), y: Math.round(c.y - (at ? 0 : comp.height / 2)) });
    });
    setSelection([id]);
  } catch (e: any) {
    toast(e.message, { kind: 'error' });
  }
}

export function goToMainComponent(instanceId: string) {
  const s = getState();
  const n = s.doc?.nodes[instanceId];
  if (!n || n.type !== 'instance') return;
  const comp = s.doc!.nodes[n.componentId];
  if (!comp) return;
  let p = comp.parentId;
  while (s.doc!.nodes[p]) p = s.doc!.nodes[p].parentId;
  setState({ pageId: p, selection: [comp.id] });
  requestAnimationFrame(() => zoomToNodes([comp.id]));
}

// ---------------------------------------------------------------------------
// Ordering / visibility / nudge
// ---------------------------------------------------------------------------

export function reorder(kind: 'forward' | 'backward' | 'front' | 'back') {
  const ids = selected();
  if (!ids.length) return;
  commit((d) => {
    for (const id of kind === 'forward' || kind === 'front' ? [...ids].reverse() : ids) {
      const list = parentChildren(d, d.nodes[id].parentId);
      if (!list) continue;
      const i = list.indexOf(id);
      list.splice(i, 1);
      const j = kind === 'forward' ? Math.min(list.length, i + 1) : kind === 'backward' ? Math.max(0, i - 1) : kind === 'front' ? list.length : 0;
      list.splice(j, 0, id);
    }
  });
}

export function toggleVisible(ids = selected()) {
  if (!ids.length) return;
  const doc = getState().doc!;
  const hide = ids.some((id) => doc.nodes[id]?.visible !== false);
  commit((d) => {
    for (const id of ids) {
      if (hide) d.nodes[id].visible = false;
      else delete d.nodes[id].visible;
    }
  });
}

export function toggleLocked(ids = selected()) {
  if (!ids.length) return;
  const doc = getState().doc!;
  const lock = ids.some((id) => !doc.nodes[id]?.locked);
  commit((d) => {
    for (const id of ids) {
      if (lock) d.nodes[id].locked = true;
      else delete d.nodes[id].locked;
    }
  });
  if (lock) setSelection([]);
}

export function nudge(dx: number, dy: number) {
  const ids = selected();
  if (!ids.length) return;
  const doc = getState().doc!;
  const movable = ids.filter((id) => !isAutoLayout(doc.nodes[doc.nodes[id].parentId]) || doc.nodes[id].position === 'absolute');
  if (!movable.length) {
    // In auto layout, arrows reorder.
    const forward = dx > 0 || dy > 0;
    reorder(forward ? 'forward' : 'backward');
    return;
  }
  commit(
    (d) => {
      for (const id of movable) {
        d.nodes[id].x = Math.round((d.nodes[id].x + dx) * 100) / 100;
        d.nodes[id].y = Math.round((d.nodes[id].y + dy) * 100) / 100;
      }
    },
    { key: 'nudge' },
  );
}

export function alignSelection(edge: 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom') {
  const ids = selected();
  const doc = getState().doc!;
  if (!ids.length) return;
  const rects = ids.map((id) => ({ id, r: parentRelativeRect(id) }));
  let ref: Rect;
  if (ids.length === 1) {
    const parent = doc.nodes[doc.nodes[ids[0]].parentId];
    if (!parent) return;
    ref = { x: 0, y: 0, width: parent.width, height: parent.height };
  } else {
    const minX = Math.min(...rects.map((x) => x.r.x));
    const minY = Math.min(...rects.map((x) => x.r.y));
    const maxX = Math.max(...rects.map((x) => x.r.x + x.r.width));
    const maxY = Math.max(...rects.map((x) => x.r.y + x.r.height));
    ref = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }
  commit((d) => {
    for (const { id, r } of rects) {
      const n = d.nodes[id];
      if (isAutoLayout(d.nodes[n.parentId]) && n.position !== 'absolute') continue;
      if (edge === 'left') n.x = ref.x;
      if (edge === 'hcenter') n.x = Math.round(ref.x + (ref.width - r.width) / 2);
      if (edge === 'right') n.x = ref.x + ref.width - r.width;
      if (edge === 'top') n.y = ref.y;
      if (edge === 'vcenter') n.y = Math.round(ref.y + (ref.height - r.height) / 2);
      if (edge === 'bottom') n.y = ref.y + ref.height - r.height;
    }
  });
}

export function distributeSelection(axis: 'x' | 'y') {
  const ids = selected();
  if (ids.length < 3) return;
  const rects = ids.map((id) => ({ id, r: parentRelativeRect(id) })).sort((a, b) => a.r[axis] - b.r[axis]);
  const size = axis === 'x' ? 'width' : 'height';
  const first = rects[0].r;
  const last = rects[rects.length - 1].r;
  const total = rects.reduce((s, x) => s + x.r[size], 0);
  const gap = (last[axis] + last[size] - first[axis] - total) / (rects.length - 1);
  commit((d) => {
    let pos = first[axis];
    for (const { id, r } of rects) {
      d.nodes[id][axis] = Math.round(pos);
      pos += r[size] + gap;
    }
  });
}

export function selectParent() {
  const s = getState();
  const ids = selected();
  if (!ids.length || !s.doc) return;
  const p = s.doc.nodes[ids[0]].parentId;
  if (s.doc.nodes[p]) setSelection([p]);
  else setSelection([]);
}

export function selectChildren() {
  const s = getState();
  const ids = selected();
  if (ids.length !== 1 || !s.doc) return;
  const n = s.doc.nodes[ids[0]];
  if (isFrameLike(n) && n.children.length) setSelection([...n.children]);
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export async function uploadImage(file: Blob): Promise<string> {
  const res = await fetch('/api/assets', { method: 'POST', headers: { 'content-type': file.type || 'image/png' }, body: file });
  if (!res.ok) throw new Error('Upload failed');
  const { url } = await res.json();
  return url;
}

function imageSize(url: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 200, h: img.naturalHeight || 200 });
    img.onerror = () => resolve({ w: 240, h: 160 });
    img.src = url;
  });
}

export async function insertImageFile(file: File, at?: { x: number; y: number }) {
  try {
    const url = await uploadImage(file);
    const { w, h } = await imageSize(url);
    const scale = Math.min(1, 800 / Math.max(w, h));
    const s = getState();
    const { width, height } = viewportSize();
    const c = at ?? toWorld(width / 2, height / 2);
    const sel = selected();
    const parent = sel.length === 1 && isFrameLike(s.doc!.nodes[sel[0]]) ? sel[0] : s.pageId;
    let ids: string[] = [];
    commit((d) => {
      ids = createNodes(
        d,
        [{ type: 'image', name: file.name.replace(/\.[^.]+$/, '') || 'Image', src: url, width: Math.round(w * scale), height: Math.round(h * scale), x: Math.round(c.x - (w * scale) / 2), y: Math.round(c.y - (h * scale) / 2) }],
        parent,
      ).ids;
    });
    setSelection(ids);
  } catch (e: any) {
    toast(`Image upload failed: ${e.message}`, { kind: 'error' });
  }
}

export function pickImage() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.onchange = async () => {
    for (const f of Array.from(input.files ?? [])) await insertImageFile(f);
  };
  input.click();
}

export async function copyAsCode(id: string, framework: 'react-tailwind' | 'html' | 'react-css' = 'react-tailwind') {
  const doc = getState().doc!;
  const res = generateCode(doc, id, { framework, assetBase: location.origin });
  await navigator.clipboard.writeText(res.code);
  toast('Copied code to clipboard');
}

export async function copyAsPng(id: string) {
  const { dataUrl } = await captureScreenshot({ nodeId: id, scale: 2 });
  const blob = await (await fetch(dataUrl)).blob();
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Copied PNG to clipboard');
  } catch {
    toast('Clipboard image copy not supported here', { kind: 'error' });
  }
}

export function renameNode(id: string, name: string) {
  commit((d) => {
    if (d.nodes[id]) d.nodes[id].name = name.trim() || d.nodes[id].name;
  });
}
