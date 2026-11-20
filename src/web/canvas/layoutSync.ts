import type { SceneNode } from '../../shared/types.ts';
import { isAutoLayout } from '../../shared/doc.ts';
import { sizeMode } from '../../shared/style.ts';
import { commit, getState } from '../store.ts';
import { getViewportEl } from '../editor/viewport.ts';

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Writes the browser-computed geometry of hug/fill/auto-layout nodes back
 * into the document, so the model (and AI agents reading it) see real sizes.
 */
export function syncLayout() {
  const s = getState();
  const doc = s.doc;
  const world = getViewportEl()?.querySelector('[data-world]');
  if (!doc || !world) return;
  const zoom = s.viewport.zoom;
  const els = new Map<string, HTMLElement>();
  world.querySelectorAll<HTMLElement>('[data-node-id]').forEach((el) => els.set(el.dataset.nodeId!, el));
  const rectCache = new Map<string, DOMRect>();
  const rect = (id: string, el: HTMLElement) => {
    let r = rectCache.get(id);
    if (!r) {
      r = el.getBoundingClientRect();
      rectCache.set(id, r);
    }
    return r;
  };
  const updates: Array<{ id: string; x?: number; y?: number; width?: number; height?: number }> = [];
  for (const [id, el] of els) {
    const n: SceneNode | undefined = doc.nodes[id];
    if (!n || n.visible === false) continue;
    const parent = doc.nodes[n.parentId];
    const inFlow = !!parent && isAutoLayout(parent) && n.position !== 'absolute';
    const wm = sizeMode(n, 'w');
    const hm = sizeMode(n, 'h');
    if (!inFlow && wm === 'fixed' && hm === 'fixed') continue;
    if (!el.getClientRects().length) continue;
    const rotated = !!n.rotation || !!(parent && parent.rotation);
    let w: number, h: number, x: number | undefined, y: number | undefined;
    if (rotated) {
      w = el.offsetWidth;
      h = el.offsetHeight;
      if (inFlow) {
        x = el.offsetLeft;
        y = el.offsetTop;
      }
    } else {
      const r = rect(id, el);
      w = r2(r.width / zoom);
      h = r2(r.height / zoom);
      if (inFlow) {
        const pel = els.get(n.parentId);
        if (pel) {
          const pr = rect(n.parentId, pel);
          x = r2((r.left - pr.left) / zoom);
          y = r2((r.top - pr.top) / zoom);
        }
      }
    }
    const u: { id: string; x?: number; y?: number; width?: number; height?: number } = { id };
    let changed = false;
    if (Math.abs(w - n.width) > 0.5) ((u.width = w), (changed = true));
    if (Math.abs(h - n.height) > 0.5) ((u.height = h), (changed = true));
    if (x !== undefined && Math.abs(x - n.x) > 0.5) ((u.x = x), (changed = true));
    if (y !== undefined && Math.abs(y - n.y) > 0.5) ((u.y = y), (changed = true));
    if (changed) updates.push(u);
  }
  if (!updates.length) return;
  commit(
    (d) => {
      for (const u of updates) {
        const n = d.nodes[u.id];
        if (!n) continue;
        if (u.width !== undefined) n.width = u.width;
        if (u.height !== undefined) n.height = u.height;
        if (u.x !== undefined) n.x = u.x;
        if (u.y !== undefined) n.y = u.y;
      }
    },
    { history: false },
  );
}

let scheduled = false;
export function scheduleLayoutSync() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    try {
      syncLayout();
    } catch (e) {
      console.warn('layout sync failed', e);
    }
  });
}
