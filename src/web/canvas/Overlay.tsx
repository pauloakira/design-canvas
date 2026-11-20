import { useEffect, useLayoutEffect, useState } from 'react';
import type { FrameNode } from '../../shared/types.ts';
import { isAutoLayout, isFrameLike, isPageId, topLevelOnly } from '../../shared/doc.ts';
import { sizeMode } from '../../shared/style.ts';
import { setState, useEditor } from '../store.ts';
import { measure, unionRects, type Rect } from '../editor/viewport.ts';

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
const CURSORS: Record<string, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

interface Measured {
  sel: Array<{ id: string; r: Rect; component: boolean }>;
  bbox: Rect | null;
  hover: { r: Rect; component: boolean } | null;
  labels: Array<{ id: string; r: Rect; name: string; kind: string }>;
  peers: Array<{ id: string; r: Rect; color: string; name: string }>;
  flash: Array<{ id: string; r: Rect; agent: string }>;
  drop: Rect | null;
  paddings: Array<Rect>;
  measure: Array<{ x1: number; y1: number; x2: number; y2: number; label: string }>;
}

const empty: Measured = { sel: [], bbox: null, hover: null, labels: [], peers: [], flash: [], drop: null, paddings: [], measure: [] };

export function Overlay() {
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const hoverId = useEditor((s) => s.hoverId);
  const viewport = useEditor((s) => s.viewport);
  const overlay = useEditor((s) => s.overlay);
  const peers = useEditor((s) => s.peers);
  const flash = useEditor((s) => s.flash);
  const pageId = useEditor((s) => s.pageId);
  const editing = useEditor((s) => s.editingTextId);
  const tick = useEditor((s) => s.layoutTick);
  const [m, setM] = useState<Measured>(empty);

  useLayoutEffect(() => {
    if (!doc) return;
    const page = doc.pages[pageId];
    if (!page) return;
    const out: Measured = { ...empty, sel: [], labels: [], peers: [], flash: [], paddings: [], measure: [] };
    for (const id of selection) {
      const r = measure(id);
      if (r) out.sel.push({ id, r, component: doc.nodes[id]?.type === 'component' || doc.nodes[id]?.type === 'instance' });
    }
    out.bbox = unionRects(out.sel.map((x) => x.r));
    if (hoverId && !selection.includes(hoverId)) {
      const r = measure(hoverId);
      const t = doc.nodes[hoverId]?.type;
      if (r) out.hover = { r, component: t === 'component' || t === 'instance' };
    }
    for (const id of page.children) {
      const n = doc.nodes[id];
      if (!n || n.visible === false) continue;
      if (!isFrameLike(n) && n.type !== 'instance') continue;
      const r = measure(id);
      if (r) out.labels.push({ id, r, name: n.name, kind: n.type });
    }
    for (const p of peers) {
      if (p.pageId !== pageId) continue;
      for (const id of p.selection) {
        const r = measure(id);
        if (r) out.peers.push({ id, r, color: p.color, name: p.name });
      }
    }
    const now = Date.now();
    const fl = Object.entries(flash).filter(([, v]) => now - v.at < 2500);
    const flIds = topLevelOnly(doc, fl.map(([id]) => id).filter((id) => doc.nodes[id]));
    for (const id of flIds.slice(0, 40)) {
      const r = measure(id);
      if (r) out.flash.push({ id, r, agent: flash[id].agent });
    }
    if (overlay.dropTarget) out.drop = measure(overlay.dropTarget);
    // Auto-layout padding preview for a single selected frame.
    if (selection.length === 1 && isAutoLayout(doc.nodes[selection[0]]) && out.sel[0]) {
      const f = doc.nodes[selection[0]] as FrameNode;
      const [t, rr, b, l] = (f.layout?.padding ?? [0, 0, 0, 0]).map((v) => (typeof v === 'number' ? v : 0));
      const r = out.sel[0].r;
      if (t) out.paddings.push({ x: r.x, y: r.y, width: r.width, height: t });
      if (b) out.paddings.push({ x: r.x, y: r.y + r.height - b, width: r.width, height: b });
      if (l) out.paddings.push({ x: r.x, y: r.y + t, width: l, height: r.height - t - b });
      if (rr) out.paddings.push({ x: r.x + r.width - rr, y: r.y + t, width: rr, height: r.height - t - b });
    }
    // Alt: measure distances between selection and hovered layer.
    if (overlay.measure && out.bbox && hoverId && !selection.includes(hoverId)) {
      const a = out.bbox;
      const b = measure(hoverId);
      if (b) out.measure = distances(a, b);
    }
    setM(out);
  }, [doc, selection, hoverId, viewport, overlay, peers, flash, pageId, editing, tick]);

  // Expire agent highlights.
  useEffect(() => {
    if (!Object.keys(flash).length) return;
    const t = setTimeout(() => {
      const now = Date.now();
      setState((s) => ({ flash: Object.fromEntries(Object.entries(s.flash).filter(([, v]) => now - v.at < 2500)) }));
    }, 2600);
    return () => clearTimeout(t);
  }, [flash]);

  if (!doc) return null;
  const { x: vx, y: vy, zoom } = viewport;
  const S = (r: Rect) => ({ left: r.x * zoom + vx, top: r.y * zoom + vy, width: r.width * zoom, height: r.height * zoom });
  const single = m.sel.length === 1 ? doc.nodes[m.sel[0].id] : null;
  const showHandles = m.bbox && !editing && !overlay.ghost;
  const sizeLabel = (() => {
    if (!m.bbox) return '';
    const w = Math.round(m.bbox.width * 100) / 100;
    const h = Math.round(m.bbox.height * 100) / 100;
    if (single) {
      const wm = sizeMode(single, 'w');
      const hm = sizeMode(single, 'h');
      return `${wm === 'fixed' ? w : `${w} ${wm === 'hug' ? 'Hug' : 'Fill'}`} × ${hm === 'fixed' ? h : `${h} ${hm === 'hug' ? 'Hug' : 'Fill'}`}`;
    }
    return `${w} × ${h}`;
  })();
  const inFlowSingle = single && isAutoLayout(doc.nodes[single.parentId]) && single.position !== 'absolute';

  return (
    <div className="overlay">
      {m.labels.map((l) => {
        const s = S(l.r);
        const selected = selection.includes(l.id);
        return (
          <div
            key={'l' + l.id}
            className={`frame-label ${l.kind === 'component' || l.kind === 'instance' ? 'component' : ''} ${selected ? 'selected' : ''}`}
            data-label-for={l.id}
            style={{ left: s.left, top: s.top - 18, maxWidth: Math.max(40, s.width) }}
          >
            {l.kind === 'component' ? '❖ ' : l.kind === 'instance' ? '◇ ' : ''}
            {l.name}
          </div>
        );
      })}
      {m.paddings.map((p, i) => (
        <div key={'p' + i} className="padding-box" style={S(p)} />
      ))}
      {m.drop && <div className="drop-target" style={S(m.drop)} />}
      {m.peers.map((p) => (
        <div key={'peer' + p.id + p.name} className="peer-box" style={{ ...S(p.r), borderColor: p.color }}>
          <span style={{ background: p.color }}>{p.name}</span>
        </div>
      ))}
      {m.flash.map((f) => (
        <div key={'f' + f.id} className="agent-flash" style={S(f.r)}>
          <span>{f.agent}</span>
        </div>
      ))}
      {m.hover && <div className={`hover-box ${m.hover.component ? 'component' : ''}`} style={S(m.hover.r)} />}
      {m.sel.map((x) => (
        <div key={'s' + x.id} className={`sel-box ${x.component ? 'component' : ''}`} style={S(x.r)} />
      ))}
      {m.bbox && m.sel.length > 1 && <div className="sel-bbox" style={S(m.bbox)} />}
      {showHandles &&
        m.bbox &&
        HANDLES.map((h) => {
          const s = S(m.bbox!);
          const x = h.includes('w') ? s.left : h.includes('e') ? s.left + s.width : s.left + s.width / 2;
          const y = h.includes('n') ? s.top : h.includes('s') ? s.top + s.height : s.top + s.height / 2;
          const edge = h.length === 1;
          if (edge && (h === 'n' || h === 's') && s.width < 24) return null;
          if (edge && (h === 'e' || h === 'w') && s.height < 24) return null;
          return <div key={h} data-handle={h} className={`handle ${edge ? 'edge' : ''} ${m.sel[0]?.component ? 'component' : ''}`} style={{ left: x, top: y, cursor: CURSORS[h] }} />;
        })}
      {m.bbox && !overlay.ghost && (
        <div className={`size-label ${m.sel[0]?.component ? 'component' : ''}`} style={{ left: S(m.bbox).left + S(m.bbox).width / 2, top: S(m.bbox).top + S(m.bbox).height + 6 }}>
          {sizeLabel}
          {inFlowSingle ? ' · auto' : ''}
        </div>
      )}
      {overlay.marquee && <div className="marquee" style={S(overlay.marquee)} />}
      {overlay.ghost && <div className="ghost" style={S(overlay.ghost)} />}
      {overlay.indicator && (
        <div
          className="indicator"
          style={{
            left: Math.min(overlay.indicator.x1, overlay.indicator.x2) * zoom + vx - 1,
            top: Math.min(overlay.indicator.y1, overlay.indicator.y2) * zoom + vy - 1,
            width: Math.max(2, Math.abs(overlay.indicator.x2 - overlay.indicator.x1) * zoom + 2),
            height: Math.max(2, Math.abs(overlay.indicator.y2 - overlay.indicator.y1) * zoom + 2),
          }}
        />
      )}
      <svg className="guides">
        {overlay.guides.map((g, i) =>
          g.axis === 'x' ? (
            <line key={i} x1={g.pos * zoom + vx} x2={g.pos * zoom + vx} y1={g.from * zoom + vy} y2={g.to * zoom + vy} />
          ) : (
            <line key={i} y1={g.pos * zoom + vy} y2={g.pos * zoom + vy} x1={g.from * zoom + vx} x2={g.to * zoom + vx} />
          ),
        )}
        {m.measure.map((l, i) => (
          <g key={'m' + i} className="measure">
            <line x1={l.x1 * zoom + vx} y1={l.y1 * zoom + vy} x2={l.x2 * zoom + vx} y2={l.y2 * zoom + vy} />
          </g>
        ))}
      </svg>
      {m.measure.map((l, i) => (
        <div key={'ml' + i} className="measure-label" style={{ left: ((l.x1 + l.x2) / 2) * zoom + vx, top: ((l.y1 + l.y2) / 2) * zoom + vy }}>
          {l.label}
        </div>
      ))}
    </div>
  );
}

function distances(a: Rect, b: Rect) {
  const out: Array<{ x1: number; y1: number; x2: number; y2: number; label: string }> = [];
  const r = (n: number) => String(Math.round(n * 10) / 10);
  const inside = a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height;
  const cy = a.y + a.height / 2;
  const cx = a.x + a.width / 2;
  if (inside) {
    out.push({ x1: b.x, y1: cy, x2: a.x, y2: cy, label: r(a.x - b.x) });
    out.push({ x1: a.x + a.width, y1: cy, x2: b.x + b.width, y2: cy, label: r(b.x + b.width - a.x - a.width) });
    out.push({ x1: cx, y1: b.y, x2: cx, y2: a.y, label: r(a.y - b.y) });
    out.push({ x1: cx, y1: a.y + a.height, x2: cx, y2: b.y + b.height, label: r(b.y + b.height - a.y - a.height) });
    return out.filter((l) => l.label !== '0');
  }
  if (b.x >= a.x + a.width) out.push({ x1: a.x + a.width, y1: cy, x2: b.x, y2: cy, label: r(b.x - a.x - a.width) });
  else if (b.x + b.width <= a.x) out.push({ x1: b.x + b.width, y1: cy, x2: a.x, y2: cy, label: r(a.x - b.x - b.width) });
  if (b.y >= a.y + a.height) out.push({ x1: cx, y1: a.y + a.height, x2: cx, y2: b.y, label: r(b.y - a.y - a.height) });
  else if (b.y + b.height <= a.y) out.push({ x1: cx, y1: b.y + b.height, x2: cx, y2: a.y, label: r(a.y - b.y - b.height) });
  return out;
}

