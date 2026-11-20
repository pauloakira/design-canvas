import { getState, setState, toast } from '../store.ts';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

let viewportEl: HTMLElement | null = null;

export function registerViewport(el: HTMLElement | null) {
  viewportEl = el;
}

export function getViewportEl() {
  return viewportEl;
}

export function nodeEl(id: string): HTMLElement | null {
  if (!viewportEl) return null;
  return viewportEl.querySelector(`[data-node-id="${CSS.escape(id)}"]`);
}

export function toWorld(clientX: number, clientY: number) {
  const { viewport: v } = getState();
  const r = viewportEl?.getBoundingClientRect() ?? { left: 0, top: 0 };
  return { x: (clientX - r.left - v.x) / v.zoom, y: (clientY - r.top - v.y) / v.zoom };
}

export function toScreen(x: number, y: number) {
  const { viewport: v } = getState();
  return { x: x * v.zoom + v.x, y: y * v.zoom + v.y };
}

/** World-space bounding box of a rendered node. */
export function measure(id: string): Rect | null {
  const el = nodeEl(id);
  if (!el || !viewportEl) return null;
  return measureEl(el);
}

export function measureEl(el: Element): Rect {
  const { viewport: v } = getState();
  const vr = viewportEl!.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return {
    x: (r.left - vr.left - v.x) / v.zoom,
    y: (r.top - vr.top - v.y) / v.zoom,
    width: r.width / v.zoom,
    height: r.height / v.zoom,
  };
}

export function unionRects(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function intersects(a: Rect, b: Rect) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function viewportSize() {
  const r = viewportEl?.getBoundingClientRect();
  return { width: r?.width ?? window.innerWidth, height: r?.height ?? window.innerHeight };
}

export function zoomToRect(r: Rect, maxZoom = 1, padding = 80) {
  const { width, height } = viewportSize();
  const zoom = Math.max(0.02, Math.min(maxZoom, (width - padding * 2) / Math.max(1, r.width), (height - padding * 2) / Math.max(1, r.height)));
  setState({
    viewport: {
      zoom,
      x: width / 2 - (r.x + r.width / 2) * zoom,
      y: height / 2 - (r.y + r.height / 2) * zoom,
    },
  });
}

export function zoomToNodes(ids: string[], maxZoom = 1) {
  const rects = ids.map(measure).filter((r): r is Rect => !!r);
  const u = unionRects(rects);
  if (u) zoomToRect(u, maxZoom);
}

export function zoomToFit() {
  const s = getState();
  const page = s.doc?.pages[s.pageId];
  if (!page || !page.children.length) {
    setState({ viewport: { x: 80, y: 80, zoom: 1 } });
    return;
  }
  zoomToNodes(page.children, 1);
}

export function zoomBy(factor: number, center?: { x: number; y: number }) {
  const { viewport: v } = getState();
  const { width, height } = viewportSize();
  const c = center ?? { x: width / 2, y: height / 2 };
  const zoom = Math.min(64, Math.max(0.02, v.zoom * factor));
  const k = zoom / v.zoom;
  setState({ viewport: { zoom, x: c.x - (c.x - v.x) * k, y: c.y - (c.y - v.y) * k } });
}

export function setZoom(zoom: number) {
  zoomBy(zoom / getState().viewport.zoom);
}

export function isVisible(r: Rect): boolean {
  const { viewport: v } = getState();
  const { width, height } = viewportSize();
  const sx = r.x * v.zoom + v.x;
  const sy = r.y * v.zoom + v.y;
  return sx < width && sy < height && sx + r.width * v.zoom > 0 && sy + r.height * v.zoom > 0;
}

/** Called when an agent creates layers: offer to jump to them if off-screen. */
export function revealNodes(ids: string[], agent: string) {
  requestAnimationFrame(() => {
    const s = getState();
    const doc = s.doc;
    if (!doc) return;
    const onPage = ids.filter((id) => doc.nodes[id]);
    if (!onPage.length) return;
    const rects = onPage.map(measure).filter((r): r is Rect => !!r);
    const name = doc.nodes[onPage[0]]?.name ?? 'layers';
    if (!rects.length) {
      toast(`${agent} added "${name}" on another page`, { kind: 'agent' });
      return;
    }
    if (!rects.some(isVisible) || !s.doc?.pages[s.pageId]?.children.length) {
      toast(`${agent} added "${name}"`, { kind: 'agent', action: { label: 'Show', run: () => zoomToNodes(onPage) }, ms: 8000 });
    }
  });
}
