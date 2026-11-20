import { useEffect, useMemo, useRef } from 'react';
import type { DesignDoc, FrameNode, SceneNode } from '../../shared/types.ts';
import { attachToParent, descendants, detachFromParent, isAutoLayout, isFrameLike, isPageId, pathOf, topLevelOnly, uniqueName } from '../../shared/doc.ts';
import { createNodes, duplicateNodes, moveNodes } from '../../shared/ops.ts';
import { variablesStyleMap } from '../../shared/style.ts';
import { commit, getState, newGestureKey, setOverlay, setSelection, setState, useEditor, emptyOverlay, type Guide } from '../store.ts';
import { NodeView } from './NodeView.tsx';
import { Overlay } from './Overlay.tsx';
import { scheduleLayoutSync } from './layoutSync.ts';
import { intersects, measure, registerViewport, toWorld, unionRects, zoomBy, zoomToFit, type Rect } from '../editor/viewport.ts';
import { goToMainComponent, insertImageFile, insertInstance } from '../editor/actions.ts';
import { keyState } from '../editor/keys.ts';
import { sendPresence } from '../sync.ts';

type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

type Gesture =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
  | { kind: 'pending'; sx: number; sy: number; world: { x: number; y: number }; target: string; wasSelected: boolean; shift: boolean; alt: boolean; frameBackground: boolean; clickTarget?: string }
  | {
      kind: 'move';
      start: { x: number; y: number };
      ids: string[];
      startRects: Map<string, Rect>;
      startPos: Map<string, { x: number; y: number; parentId: string }>;
      excluded: Set<string>;
      key: string;
      mode: 'absolute' | 'reorder';
      reorder?: { target: string; index: number };
    }
  | { kind: 'marquee'; start: { x: number; y: number }; scope: string; base: string[] }
  | {
      kind: 'resize';
      handle: Handle;
      ids: string[];
      startRects: Map<string, Rect>;
      startPos: Map<string, { x: number; y: number }>;
      bbox: Rect;
      key: string;
    }
  | { kind: 'draw'; type: 'frame' | 'rect' | 'ellipse' | 'text'; start: { x: number; y: number }; parentId: string; origin: { x: number; y: number }; nodeId: string | null; key: string };

const SNAP_PX = 6;

function doc(): DesignDoc {
  return getState().doc!;
}

function lockedOrHidden(d: DesignDoc, id: string): boolean {
  let cur: SceneNode | undefined = d.nodes[id];
  while (cur) {
    if (cur.locked || cur.visible === false) return true;
    cur = d.nodes[cur.parentId];
  }
  return false;
}

/** Deepest real (non-virtual) node under the pointer that can be selected. */
function hitTest(clientX: number, clientY: number, skip?: Set<string>): string | null {
  const d = doc();
  const els = document.elementsFromPoint(clientX, clientY);
  for (const el of els) {
    const ne = (el as HTMLElement).closest?.('[data-node-id]') as HTMLElement | null;
    if (!ne) continue;
    const id = ne.dataset.nodeId!;
    if (!d.nodes[id] || skip?.has(id)) continue;
    if (lockedOrHidden(d, id)) continue;
    return id;
  }
  return null;
}

/** Figma-like selection depth rules. */
function selectableTarget(deepest: string, deep: boolean): string {
  if (deep) return deepest;
  const d = doc();
  const sel = getState().selection;
  const path = pathOf(d, deepest);
  let best: string | null = null;
  let bestDepth = -1;
  for (const s of sel) {
    const n = d.nodes[s];
    if (!n) continue;
    const i = path.indexOf(n.parentId);
    if (i >= 0 && i + 1 < path.length && i + 1 > bestDepth) {
      best = path[i + 1];
      bestDepth = i + 1;
    }
  }
  const def = path.length >= 2 && isFrameLike(d.nodes[path[0]]) ? path[1] : path[0];
  const defDepth = path.indexOf(def);
  if (best && bestDepth >= defDepth) return best;
  return def;
}

/** Container (frame/component/page) under the pointer for drops and drawing. */
function containerAt(clientX: number, clientY: number, excluded?: Set<string>): string {
  const d = doc();
  const els = document.elementsFromPoint(clientX, clientY);
  for (const el of els) {
    const ne = (el as HTMLElement).closest?.('[data-node-id]') as HTMLElement | null;
    if (!ne) continue;
    let id: string | undefined = ne.dataset.nodeId!;
    while (id && d.nodes[id]) {
      const n: SceneNode = d.nodes[id];
      if (!excluded?.has(id) && isFrameLike(n) && !lockedOrHidden(d, id)) return id;
      id = n.parentId;
    }
  }
  return getState().pageId;
}

function originOf(id: string): { x: number; y: number } {
  if (isPageId(doc(), id)) return { x: 0, y: 0 };
  const r = measure(id);
  return r ? { x: r.x, y: r.y } : { x: 0, y: 0 };
}

function snap(moving: Rect, candidates: Rect[], zoom: number, axes: { x: boolean; y: boolean } = { x: true, y: true }) {
  const t = SNAP_PX / zoom;
  let bestX: { d: number; at: number } | null = null;
  let bestY: { d: number; at: number } | null = null;
  const mx = [moving.x, moving.x + moving.width / 2, moving.x + moving.width];
  const my = [moving.y, moving.y + moving.height / 2, moving.y + moving.height];
  for (const c of candidates) {
    const cx = [c.x, c.x + c.width / 2, c.x + c.width];
    const cy = [c.y, c.y + c.height / 2, c.y + c.height];
    if (axes.x)
      for (const a of mx)
        for (const b of cx) {
          const dd = b - a;
          if (Math.abs(dd) <= t && (!bestX || Math.abs(dd) < Math.abs(bestX.d))) bestX = { d: dd, at: b };
        }
    if (axes.y)
      for (const a of my)
        for (const b of cy) {
          const dd = b - a;
          if (Math.abs(dd) <= t && (!bestY || Math.abs(dd) < Math.abs(bestY.d))) bestY = { d: dd, at: b };
        }
  }
  const dx = bestX?.d ?? 0;
  const dy = bestY?.d ?? 0;
  const guides: Guide[] = [];
  const snapped = { ...moving, x: moving.x + dx, y: moving.y + dy };
  if (bestX) {
    const xs = bestX.at;
    const related = candidates.filter((c) => [c.x, c.x + c.width / 2, c.x + c.width].some((v) => Math.abs(v - xs) < 0.01));
    const ys = [snapped.y, snapped.y + snapped.height, ...related.flatMap((c) => [c.y, c.y + c.height])];
    guides.push({ axis: 'x', pos: xs, from: Math.min(...ys), to: Math.max(...ys) });
  }
  if (bestY) {
    const ys = bestY.at;
    const related = candidates.filter((c) => [c.y, c.y + c.height / 2, c.y + c.height].some((v) => Math.abs(v - ys) < 0.01));
    const xs = [snapped.x, snapped.x + snapped.width, ...related.flatMap((c) => [c.x, c.x + c.width])];
    guides.push({ axis: 'y', pos: ys, from: Math.min(...xs), to: Math.max(...xs) });
  }
  return { dx, dy, guides };
}

function snapCandidates(parentId: string, excluded: Set<string>): Rect[] {
  const d = doc();
  const kids = isPageId(d, parentId) ? d.pages[parentId].children : (d.nodes[parentId] as FrameNode)?.children ?? [];
  const out: Rect[] = [];
  for (const k of kids) {
    if (excluded.has(k) || d.nodes[k]?.visible === false) continue;
    const r = measure(k);
    if (r) out.push(r);
  }
  if (!isPageId(d, parentId)) {
    const pr = measure(parentId);
    if (pr) out.push(pr);
  }
  return out;
}

function reorderIndex(target: string, excluded: Set<string>, p: { x: number; y: number }) {
  const d = doc();
  const f = d.nodes[target] as FrameNode;
  const row = f.layout?.mode === 'row';
  const kids = f.children.filter((c) => !excluded.has(c) && d.nodes[c]?.visible !== false && d.nodes[c]?.position !== 'absolute');
  const rects = kids.map((k) => measure(k)).filter((r): r is Rect => !!r);
  let index = rects.length;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const mid = row ? r.x + r.width / 2 : r.y + r.height / 2;
    const v = row ? p.x : p.y;
    if (f.layout?.wrap) {
      // Wrapped rows: compare on the cross axis first.
      const crossIn = row ? p.y >= r.y && p.y <= r.y + r.height : p.x >= r.x && p.x <= r.x + r.width;
      if (crossIn && v < mid) {
        index = i;
        break;
      }
      continue;
    }
    if (v < mid) {
      index = i;
      break;
    }
  }
  // Map index among visible flow children to index in the full children list.
  const fullIndex = index < kids.length ? f.children.filter((c) => !excluded.has(c)).indexOf(kids[index]) : f.children.filter((c) => !excluded.has(c)).length;
  const fr = measure(target)!;
  const pad = (f.layout?.padding ?? [0, 0, 0, 0]).map((v) => (typeof v === 'number' ? v : 0));
  let line: { x1: number; y1: number; x2: number; y2: number };
  if (row) {
    const x = rects.length === 0 ? fr.x + pad[3] : index === 0 ? rects[0].x - 2 : index >= rects.length ? rects[rects.length - 1].x + rects[rects.length - 1].width + 2 : (rects[index - 1].x + rects[index - 1].width + rects[index].x) / 2;
    const ref = rects[Math.min(index, rects.length - 1)];
    line = ref ? { x1: x, y1: ref.y, x2: x, y2: ref.y + ref.height } : { x1: x, y1: fr.y + pad[0], x2: x, y2: fr.y + fr.height - pad[2] };
  } else {
    const y = rects.length === 0 ? fr.y + pad[0] : index === 0 ? rects[0].y - 2 : index >= rects.length ? rects[rects.length - 1].y + rects[rects.length - 1].height + 2 : (rects[index - 1].y + rects[index - 1].height + rects[index].y) / 2;
    const ref = rects[Math.min(index, rects.length - 1)];
    line = ref ? { x1: ref.x, y1: y, x2: ref.x + ref.width, y2: y } : { x1: fr.x + pad[3], y1: y, x2: fr.x + fr.width - pad[1], y2: y };
  }
  return { index: fullIndex, line };
}

export function Canvas() {
  const ref = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const pageId = useEditor((s) => s.pageId);
  const page = useEditor((s) => s.doc?.pages[s.pageId]);
  const viewport = useEditor((s) => s.viewport);
  const tool = useEditor((s) => s.tool);
  const vars = useEditor((s) => s.doc?.variables);
  const nodes = useEditor((s) => s.doc?.nodes);
  const layoutTick = useEditor((s) => s.layoutTick);
  const varStyle = useMemo(() => variablesStyleMap(vars ?? {}), [vars]);
  const spaceDown = keyState((k) => k.space);

  useEffect(() => {
    registerViewport(ref.current);
    return () => registerViewport(null);
  }, []);

  // Keep the document's geometry in sync with what the browser laid out.
  useEffect(() => {
    scheduleLayoutSync();
  }, [nodes, layoutTick, pageId]);
  useEffect(() => {
    const on = () => setState((s) => ({ layoutTick: s.layoutTick + 1 }));
    document.fonts?.addEventListener?.('loadingdone', on);
    return () => document.fonts?.removeEventListener?.('loadingdone', on);
  }, []);

  // Fit content when a page is first shown.
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    if (!page || fitted.current === pageId) return;
    fitted.current = pageId;
    requestAnimationFrame(() => requestAnimationFrame(() => zoomToFit()));
  }, [pageId, !!page]);

  // Wheel: pan, ctrl/⌘ + wheel (or pinch): zoom.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest?.('[data-editing]')) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0075));
        zoomBy(factor, { x: e.clientX - r.left, y: e.clientY - r.top });
      } else {
        const v = getState().viewport;
        const k = e.deltaMode === 1 ? 16 : 1;
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
        setState({ viewport: { ...v, x: v.x - dx * k, y: v.y - dy * k } });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const finishGesture = (e?: React.PointerEvent) => {
    const g = gesture.current;
    gesture.current = null;
    setOverlay({ ...emptyOverlay, measure: getState().overlay.measure });
    if (!g) return;
    if (g.kind === 'move' && g.mode === 'reorder' && g.reorder) {
      const { target, index } = g.reorder;
      commit((d) => moveNodes(d, g.ids, target, index), { key: g.key, selectionAfter: g.ids });
    }
    if (g.kind === 'draw') {
      let id = g.nodeId;
      if (!id) {
        // Click without drag → default-sized shape.
        const size = g.type === 'text' ? 0 : 100;
        commit(
          (d) => {
            const spec: Record<string, any> =
              g.type === 'text'
                ? { type: 'text', text: '', x: g.start.x - g.origin.x, y: g.start.y - g.origin.y - 10, fontSize: 16 }
                : { type: g.type, x: Math.round(g.start.x - g.origin.x - size / 2), y: Math.round(g.start.y - g.origin.y - size / 2), width: size, height: size, name: uniqueName(d, g.type === 'frame' ? 'Frame' : g.type === 'rect' ? 'Rectangle' : 'Ellipse') };
            id = createNodes(d, [spec], g.parentId).ids[0];
          },
          { key: g.key },
        );
      }
      if (id) {
        setState({ selection: [id], tool: 'move', editingTextId: g.type === 'text' ? id : null });
      }
    }
    if (g.kind === 'pending') {
      // A click without a drag.
      if (g.frameBackground) setSelection([g.target]);
      else if (g.clickTarget) setSelection([g.clickTarget]);
      else if (!g.shift && g.wasSelected && getState().selection.length > 1) setSelection([g.target]);
    }
    if (e) sendPresence(true);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const s = getState();
    if (!s.doc) return;
    if (s.contextMenu) setState({ contextMenu: null });
    const target = e.target as HTMLElement;
    if (target.closest('[data-editing]')) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const w = toWorld(e.clientX, e.clientY);

    // Pan: middle button, space, or hand tool.
    if (e.button === 1 || spaceDown || s.tool === 'hand') {
      gesture.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: s.viewport.x, vy: s.viewport.y };
      return;
    }
    if (e.button !== 0) return;
    if (s.editingTextId) setState({ editingTextId: null });

    // Resize handles.
    const handleEl = target.closest('[data-handle]') as HTMLElement | null;
    if (handleEl) {
      const ids = topLevelOnly(s.doc, s.selection).filter((id) => s.doc!.nodes[id] && !s.doc!.nodes[id].locked);
      const startRects = new Map<string, Rect>();
      const startPos = new Map<string, { x: number; y: number }>();
      for (const id of ids) {
        const r = measure(id);
        if (r) startRects.set(id, r);
        startPos.set(id, { x: s.doc.nodes[id].x, y: s.doc.nodes[id].y });
      }
      const bbox = unionRects([...startRects.values()]);
      if (!bbox) return;
      gesture.current = { kind: 'resize', handle: handleEl.dataset.handle as Handle, ids, startRects, startPos, bbox, key: newGestureKey('resize') };
      return;
    }

    // Drawing tools.
    if (s.tool === 'frame' || s.tool === 'rect' || s.tool === 'ellipse' || s.tool === 'text') {
      const parentId = containerAt(e.clientX, e.clientY);
      gesture.current = { kind: 'draw', type: s.tool, start: w, parentId, origin: originOf(parentId), nodeId: null, key: newGestureKey('draw') };
      return;
    }
    if (s.tool === 'image') return;

    // Frame name labels select top-level frames.
    const labelEl = target.closest('[data-label-for]') as HTMLElement | null;
    let hit: string | null = labelEl ? labelEl.dataset.labelFor! : hitTest(e.clientX, e.clientY);
    if (!hit) {
      if (!e.shiftKey) setSelection([]);
      gesture.current = { kind: 'marquee', start: w, scope: s.pageId, base: e.shiftKey ? s.selection : [] };
      return;
    }
    const deep = e.metaKey || e.ctrlKey;
    const tgt = labelEl ? hit : selectableTarget(hit, deep);
    const tn = s.doc.nodes[tgt];
    const frameBackground =
      !labelEl && !deep && tgt === hit && isPageId(s.doc, tn.parentId) && isFrameLike(tn) && tn.children.length > 0 && !s.selection.includes(tgt);
    if (frameBackground) {
      if (!e.shiftKey) setSelection([]);
      gesture.current = { kind: 'pending', sx: e.clientX, sy: e.clientY, world: w, target: tgt, wasSelected: false, shift: e.shiftKey, alt: e.altKey, frameBackground: true };
      return;
    }
    // An already-selected layer under the pointer takes priority for dragging
    // (like Figma); a plain click without dragging then selects the inner layer.
    if (!e.shiftKey && !deep && !labelEl && !s.selection.includes(tgt)) {
      const path = pathOf(s.doc, hit);
      const held = s.selection.find((x) => path.includes(x));
      if (held) {
        gesture.current = { kind: 'pending', sx: e.clientX, sy: e.clientY, world: w, target: held, wasSelected: true, shift: false, alt: e.altKey, frameBackground: false, clickTarget: tgt };
        return;
      }
    }
    const wasSelected = s.selection.includes(tgt);
    if (e.shiftKey) setSelection(wasSelected ? s.selection.filter((x) => x !== tgt) : [...s.selection, tgt]);
    else if (!wasSelected) setSelection([tgt]);
    gesture.current = { kind: 'pending', sx: e.clientX, sy: e.clientY, world: w, target: tgt, wasSelected, shift: e.shiftKey, alt: e.altKey, frameBackground: false };
  };

  const startMove = (g: Extract<Gesture, { kind: 'pending' }>, alt: boolean) => {
    const s = getState();
    let ids = topLevelOnly(s.doc!, s.selection).filter((id) => s.doc!.nodes[id] && !lockedOrHidden(s.doc!, id));
    if (!ids.length) return;
    const key = newGestureKey('move');
    if (alt) {
      let dup: string[] = [];
      commit((d) => (dup = duplicateNodes(d, ids, { x: 0, y: 0 })), { key });
      ids = dup;
      setSelection(dup);
    }
    const d = doc();
    const startRects = new Map<string, Rect>();
    const startPos = new Map<string, { x: number; y: number; parentId: string }>();
    for (const id of ids) {
      const r = measure(id);
      if (r) startRects.set(id, r);
      startPos.set(id, { x: d.nodes[id].x, y: d.nodes[id].y, parentId: d.nodes[id].parentId });
    }
    const excluded = new Set<string>();
    for (const id of ids) for (const x of descendants(d, id, true)) excluded.add(x);
    gesture.current = { kind: 'move', start: g.world, ids, startRects, startPos, excluded, key, mode: 'absolute' };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const s = getState();
    if (!s.doc) return;
    const g = gesture.current;
    const w = toWorld(e.clientX, e.clientY);
    if (!g) {
      // Hover feedback.
      if (s.tool !== 'move' || spaceDown) {
        if (s.hoverId) setState({ hoverId: null });
        return;
      }
      const target = e.target as HTMLElement;
      const labelEl = target.closest?.('[data-label-for]') as HTMLElement | null;
      const hit = labelEl ? labelEl.dataset.labelFor! : hitTest(e.clientX, e.clientY);
      const hover = hit ? (labelEl ? hit : selectableTarget(hit, e.metaKey || e.ctrlKey)) : null;
      if (hover !== s.hoverId) setState({ hoverId: hover });
      if (e.altKey !== s.overlay.measure) setOverlay({ measure: e.altKey });
      return;
    }
    if (g.kind === 'pan') {
      setState({ viewport: { ...s.viewport, x: g.vx + e.clientX - g.sx, y: g.vy + e.clientY - g.sy } });
      return;
    }
    if (g.kind === 'pending') {
      if (Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 3) return;
      if (g.frameBackground) {
        gesture.current = { kind: 'marquee', start: g.world, scope: g.target, base: g.shift ? s.selection : [] };
      } else {
        startMove(g, g.alt);
      }
      return onPointerMove(e);
    }
    if (g.kind === 'marquee') {
      const r = { x: Math.min(g.start.x, w.x), y: Math.min(g.start.y, w.y), width: Math.abs(w.x - g.start.x), height: Math.abs(w.y - g.start.y) };
      setOverlay({ marquee: r });
      const d = s.doc;
      const kids = isPageId(d, g.scope) ? d.pages[g.scope].children : (d.nodes[g.scope] as FrameNode).children;
      const hits = kids.filter((k) => {
        if (lockedOrHidden(d, k)) return false;
        const kr = measure(k);
        return kr && intersects(kr, r);
      });
      const next = [...new Set([...g.base, ...hits])];
      setSelection(next);
      return;
    }
    if (g.kind === 'move') return moveGesture(g, e, w);
    if (g.kind === 'resize') return resizeGesture(g, e, w);
    if (g.kind === 'draw') return drawGesture(g, e, w);
  };

  const moveGesture = (g: Extract<Gesture, { kind: 'move' }>, e: React.PointerEvent, w: { x: number; y: number }) => {
    const s = getState();
    let dx = w.x - g.start.x;
    let dy = w.y - g.start.y;
    if (e.shiftKey) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    const first = g.ids[0];
    const curParent = doc().nodes[first]?.parentId ?? s.pageId;
    const d = doc();
    // Children of an auto-layout frame reorder within it while the pointer stays
    // inside it (nesting into siblings is done from the layers panel).
    const origParent = g.startPos.get(first)?.parentId ?? curParent;
    const origRect = isAutoLayout(d.nodes[origParent]) && d.nodes[first]?.position !== 'absolute' ? measure(origParent) : null;
    const insideOrig = origRect && w.x >= origRect.x && w.x <= origRect.x + origRect.width && w.y >= origRect.y && w.y <= origRect.y + origRect.height;
    const target = e.metaKey || e.ctrlKey ? curParent : insideOrig ? origParent : containerAt(e.clientX, e.clientY, g.excluded);
    const bbox0 = unionRects([...g.startRects.values()]);
    if (!bbox0) return;
    const allAbsInTarget = g.ids.every((id) => d.nodes[id]?.parentId === target && d.nodes[id]?.position === 'absolute');
    if (isAutoLayout(d.nodes[target]) && !allAbsInTarget) {
      const { index, line } = reorderIndex(target, g.excluded, w);
      g.mode = 'reorder';
      g.reorder = { target, index };
      setOverlay({ indicator: line, ghost: { ...bbox0, x: bbox0.x + dx, y: bbox0.y + dy }, guides: [], dropTarget: target });
      return;
    }
    g.mode = 'absolute';
    g.reorder = undefined;
    const moved = { ...bbox0, x: bbox0.x + dx, y: bbox0.y + dy };
    const sn = e.altKey && false ? { dx: 0, dy: 0, guides: [] } : snap(moved, snapCandidates(target, g.excluded), s.viewport.zoom, { x: !e.shiftKey || dx !== 0, y: !e.shiftKey || dy !== 0 });
    dx += sn.dx;
    dy += sn.dy;
    const torigin = originOf(target);
    commit(
      (dd) => {
        for (const id of g.ids) {
          const n = dd.nodes[id];
          if (!n) continue;
          const sp = g.startPos.get(id)!;
          const sr = g.startRects.get(id);
          if (n.parentId !== target) {
            // Reparent, keeping the node under the cursor.
            const fromFlow = isAutoLayout(dd.nodes[n.parentId]) && n.position !== 'absolute';
            detachFromParent(dd, id);
            attachToParent(dd, id, target);
            if (sr && (fromFlow || n.widthMode === 'fill' || n.heightMode === 'fill')) {
              n.width = sr.width;
              n.height = sr.height;
              if (n.widthMode === 'fill') n.widthMode = 'fixed';
              if (n.heightMode === 'fill') n.heightMode = 'fixed';
            }
            if (n.position === 'absolute' && !isAutoLayout(dd.nodes[target])) delete n.position;
          }
          if (target === sp.parentId) {
            n.x = Math.round((sp.x + dx) * 100) / 100;
            n.y = Math.round((sp.y + dy) * 100) / 100;
          } else if (sr) {
            n.x = Math.round((sr.x + dx - torigin.x) * 100) / 100;
            n.y = Math.round((sr.y + dy - torigin.y) * 100) / 100;
          }
        }
      },
      { key: g.key },
    );
    setOverlay({ guides: sn.guides, indicator: null, ghost: null, dropTarget: isPageId(d, target) ? null : target });
  };

  const resizeGesture = (g: Extract<Gesture, { kind: 'resize' }>, e: React.PointerEvent, w: { x: number; y: number }) => {
    const s = getState();
    const b = g.bbox;
    let left = b.x;
    let top = b.y;
    let right = b.x + b.width;
    let bottom = b.y + b.height;
    const h = g.handle;
    if (h.includes('w')) left = w.x;
    if (h.includes('e')) right = w.x;
    if (h.includes('n')) top = w.y;
    if (h.includes('s')) bottom = w.y;
    // Snap moving edges.
    const d = doc();
    const parentId = d.nodes[g.ids[0]]?.parentId ?? s.pageId;
    const excluded = new Set<string>();
    for (const id of g.ids) for (const x of descendants(d, id, true)) excluded.add(x);
    const cands = snapCandidates(parentId, excluded);
    const guides: Guide[] = [];
    const t = SNAP_PX / s.viewport.zoom;
    const snapEdge = (v: number, axis: 'x' | 'y') => {
      let best: number | null = null;
      for (const c of cands) {
        const vals = axis === 'x' ? [c.x, c.x + c.width / 2, c.x + c.width] : [c.y, c.y + c.height / 2, c.y + c.height];
        for (const cv of vals) if (Math.abs(cv - v) <= t && (best === null || Math.abs(cv - v) < Math.abs(best - v))) best = cv;
      }
      return best;
    };
    if (!e.altKey) {
      if (h.includes('w')) {
        const sv = snapEdge(left, 'x');
        if (sv !== null) left = sv;
      }
      if (h.includes('e')) {
        const sv = snapEdge(right, 'x');
        if (sv !== null) right = sv;
      }
      if (h.includes('n')) {
        const sv = snapEdge(top, 'y');
        if (sv !== null) top = sv;
      }
      if (h.includes('s')) {
        const sv = snapEdge(bottom, 'y');
        if (sv !== null) bottom = sv;
      }
    }
    if (e.altKey) {
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      if (h.includes('w')) right = cx + (cx - left);
      if (h.includes('e')) left = cx - (right - cx);
      if (h.includes('n')) bottom = cy + (cy - top);
      if (h.includes('s')) top = cy - (bottom - cy);
    }
    let nw = Math.max(1, Math.abs(right - left));
    let nh = Math.max(1, Math.abs(bottom - top));
    if (e.shiftKey && b.width > 0 && b.height > 0) {
      const ratio = b.width / b.height;
      if (h === 'n' || h === 's') nw = nh * ratio;
      else if (h === 'e' || h === 'w') nh = nw / ratio;
      else if (nw / nh > ratio) nh = nw / ratio;
      else nw = nh * ratio;
      if (h.includes('w')) left = right - nw;
      if (h.includes('n')) top = bottom - nh;
      if (h === 'e' || h === 'w') top = b.y + (b.height - nh) / 2;
      if (h === 'n' || h === 's') left = b.x + (b.width - nw) / 2;
    }
    const nx = Math.min(left, left + (right - left < 0 ? right - left : 0));
    const ny = Math.min(top, top + (bottom - top < 0 ? bottom - top : 0));
    const sx = nw / b.width;
    const sy = nh / b.height;
    const changedW = h.includes('e') || h.includes('w') || (e.shiftKey && (h === 'n' || h === 's'));
    const changedH = h.includes('n') || h.includes('s') || (e.shiftKey && (h === 'e' || h === 'w'));
    for (const v of [left, right]) if (cands.some((c) => [c.x, c.x + c.width / 2, c.x + c.width].some((cv) => Math.abs(cv - v) < 0.01))) guides.push({ axis: 'x', pos: v, from: ny - 20, to: ny + nh + 20 });
    for (const v of [top, bottom]) if (cands.some((c) => [c.y, c.y + c.height / 2, c.y + c.height].some((cv) => Math.abs(cv - v) < 0.01))) guides.push({ axis: 'y', pos: v, from: nx - 20, to: nx + nw + 20 });
    commit(
      (dd) => {
        for (const id of g.ids) {
          const n = dd.nodes[id];
          const r = g.startRects.get(id);
          const sp = g.startPos.get(id);
          if (!n || !r || !sp) continue;
          const inFlow = isAutoLayout(dd.nodes[n.parentId]) && n.position !== 'absolute';
          const newX = nx + (r.x - b.x) * sx;
          const newY = ny + (r.y - b.y) * sy;
          const rw = Math.max(1, Math.round(r.width * sx * 100) / 100);
          const rh = Math.max(1, Math.round(r.height * sy * 100) / 100);
          if (changedW) {
            n.width = rw;
            n.widthMode = 'fixed';
          }
          if (changedH) {
            n.height = rh;
            n.heightMode = 'fixed';
          } else if (n.type === 'text' && changedW) n.heightMode = 'hug';
          if (!inFlow) {
            n.x = Math.round((sp.x + (newX - r.x)) * 100) / 100;
            n.y = Math.round((sp.y + (newY - r.y)) * 100) / 100;
          }
        }
      },
      { key: g.key },
    );
    setOverlay({ guides });
  };

  const drawGesture = (g: Extract<Gesture, { kind: 'draw' }>, e: React.PointerEvent, w: { x: number; y: number }) => {
    let x0 = g.start.x;
    let y0 = g.start.y;
    let wdt = w.x - x0;
    let hgt = w.y - y0;
    if (!g.nodeId && Math.hypot(wdt, hgt) * getState().viewport.zoom < 3) return;
    if (e.shiftKey) {
      const m = Math.max(Math.abs(wdt), Math.abs(hgt));
      wdt = Math.sign(wdt || 1) * m;
      hgt = Math.sign(hgt || 1) * m;
    }
    if (e.altKey) {
      x0 -= wdt;
      y0 -= hgt;
      wdt *= 2;
      hgt *= 2;
    }
    const rx = Math.round(Math.min(x0, x0 + wdt) - g.origin.x);
    const ry = Math.round(Math.min(y0, y0 + hgt) - g.origin.y);
    const rw = Math.max(1, Math.round(Math.abs(wdt)));
    const rh = Math.max(1, Math.round(Math.abs(hgt)));
    commit(
      (d) => {
        if (!g.nodeId) {
          const names: Record<string, string> = { frame: 'Frame', rect: 'Rectangle', ellipse: 'Ellipse', text: 'Text' };
          const spec: Record<string, any> =
            g.type === 'text'
              ? { type: 'text', text: '', x: rx, y: ry, width: rw, fontSize: 16 }
              : { type: g.type, name: uniqueName(d, names[g.type]), x: rx, y: ry, width: rw, height: rh };
          g.nodeId = createNodes(d, [spec], g.parentId).ids[0];
          return;
        }
        const n = d.nodes[g.nodeId];
        if (!n) return;
        n.x = rx;
        n.y = ry;
        n.width = rw;
        if (g.type !== 'text') n.height = rh;
      },
      { key: g.key },
    );
    setSelection(g.nodeId ? [g.nodeId] : []);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    finishGesture(e);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const s = getState();
    if (!s.doc || s.tool !== 'move') return;
    const hit = hitTest(e.clientX, e.clientY);
    if (!hit) return;
    const d = s.doc;
    const sel = s.selection[0];
    const path = pathOf(d, hit);
    let next = hit;
    if (sel && path.includes(sel) && sel !== hit) next = path[path.indexOf(sel) + 1];
    else if (sel === hit) next = hit;
    else next = selectableTarget(hit, false);
    const n = d.nodes[next];
    if (n?.type === 'text' && (sel === next || next === hit)) {
      setState({ selection: [next], editingTextId: next });
      return;
    }
    if (n?.type === 'instance' && sel === next) {
      goToMainComponent(next);
      return;
    }
    setSelection([next]);
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const s = getState();
    if (!s.doc) return;
    const hit = hitTest(e.clientX, e.clientY);
    if (hit) {
      const t = selectableTarget(hit, e.metaKey || e.ctrlKey);
      if (!s.selection.includes(t)) setSelection([t]);
    }
    setState({ contextMenu: { x: e.clientX, y: e.clientY } });
  };

  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('application/x-dc-component')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  };
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const w = toWorld(e.clientX, e.clientY);
    const comp = e.dataTransfer.getData('application/x-dc-component');
    if (comp) {
      const parent = containerAt(e.clientX, e.clientY);
      const o = originOf(parent);
      insertInstance(comp, { x: Math.round(w.x - o.x), y: Math.round(w.y - o.y) }, parent);
      return;
    }
    for (const f of Array.from(e.dataTransfer.files)) if (f.type.startsWith('image/')) await insertImageFile(f, w);
  };

  if (!page) return <div className="canvas" ref={ref} />;
  const cursor = spaceDown || tool === 'hand' ? 'grab' : tool === 'text' ? 'text' : tool === 'move' ? 'default' : 'crosshair';
  return (
    <div
      className="canvas"
      ref={ref}
      style={{ background: page.background ?? 'var(--canvas-bg)', cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => finishGesture()}
      onPointerLeave={() => !gesture.current && getState().hoverId && setState({ hoverId: null })}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div
        data-world
        className="world"
        style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`, ...(varStyle as any) }}
      >
        {page.children.map((id) => (
          <NodeView key={id} id={id} />
        ))}
      </div>
      <Overlay />
      {!page.children.length && (
        <div className="canvas-empty">
          <div>Empty page</div>
          <p>
            Press <kbd>F</kbd> to draw a frame, or open the <b>AI</b> tab and describe a screen.
          </p>
        </div>
      )}
    </div>
  );
}
