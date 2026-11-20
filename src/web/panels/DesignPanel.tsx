import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  ArrowDown,
  ArrowRight,
  Component,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Link2,
  Minus,
  Plus,
  Scan,
  SquareDashed,
  Unlink,
  WrapText,
  AlignHorizontalSpaceBetween,
  AlignVerticalSpaceBetween,
  Bold,
  Italic,
  Underline,
  Strikethrough,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignJustify,
} from 'lucide-react';
import type { AutoLayout, DesignDoc, FrameNode, ImageNode, InstanceNode, Paint, SceneNode, Shadow, SizeMode, Stroke, TextNode } from '../../shared/types.ts';
import { isAutoLayout, isFrameLike, isPageId } from '../../shared/doc.ts';
import { createNodes } from '../../shared/ops.ts';
import { sizeMode } from '../../shared/style.ts';
import { GOOGLE_FONTS } from '../../shared/codegen.ts';
import { instanceLayers } from '../../shared/tree.ts';
import { commit, getState, setSelection, setTool, useEditor } from '../store.ts';
import { ColorField, IconBtn, MIXED, NumField, Row, Section, Select, type Mixed } from './controls.tsx';
import { alignSelection, detachSelection, distributeSelection, goToMainComponent, insertInstance, makeComponent, uploadImage, copyAsCode } from '../editor/actions.ts';
import { downloadPng } from '../editor/screenshot.ts';
import { toWorld, viewportSize } from '../editor/viewport.ts';

type AnyNode = SceneNode & Record<string, any>;

function useSelectedNodes(): SceneNode[] {
  return useEditor(useShallow((s) => (s.doc ? s.selection.map((id) => s.doc!.nodes[id]).filter(Boolean) : [])));
}

function update(ids: string[], fn: (n: AnyNode, d: DesignDoc) => void, key?: string) {
  commit(
    (d) => {
      for (const id of ids) if (d.nodes[id]) fn(d.nodes[id] as AnyNode, d);
    },
    { key },
  );
}

function common<T>(nodes: SceneNode[], get: (n: AnyNode) => T): Mixed<T> {
  if (!nodes.length) return MIXED;
  const first = get(nodes[0] as AnyNode);
  for (const n of nodes) if (JSON.stringify(get(n as AnyNode)) !== JSON.stringify(first)) return MIXED;
  return first;
}

const PRESETS = [
  { name: 'iPhone 16', w: 393, h: 852 },
  { name: 'iPhone 16 Pro Max', w: 440, h: 956 },
  { name: 'Android', w: 412, h: 915 },
  { name: 'iPad', w: 834, h: 1194 },
  { name: 'Desktop', w: 1440, h: 1024 },
  { name: 'MacBook', w: 1280, h: 832 },
  { name: 'Wide', w: 1920, h: 1080 },
  { name: 'Social post', w: 1080, h: 1080 },
  { name: 'Open Graph', w: 1200, h: 630 },
];

export function DesignPanel() {
  const nodes = useSelectedNodes();
  const tool = useEditor((s) => s.tool);
  if (tool === 'frame' && !nodes.length) return <FramePresets />;
  if (!nodes.length) return <PageProps />;
  const ids = nodes.map((n) => n.id);
  const single = nodes.length === 1 ? (nodes[0] as AnyNode) : null;
  const allFrames = nodes.every((n) => isFrameLike(n));
  const allText = nodes.every((n) => n.type === 'text');
  return (
    <div className="design-panel" key={ids.join(',')}>
      <AlignBar count={nodes.length} />
      <TypeHeader nodes={nodes} />
      {single?.type === 'instance' && <InstanceSection node={single as InstanceNode} />}
      <GeometrySection nodes={nodes} ids={ids} />
      {allFrames && <AutoLayoutSection nodes={nodes as FrameNode[]} ids={ids} />}
      <AppearanceSection nodes={nodes} ids={ids} />
      {allText && <TextSection nodes={nodes as TextNode[]} ids={ids} />}
      {single?.type === 'image' && <ImageSection node={single as ImageNode} />}
      {single?.type === 'svg' && <SvgSection node={single as any} />}
      {!allText && nodes.every((n) => n.type !== 'svg') && <FillSection nodes={nodes} ids={ids} title="Fill" />}
      {allText && <FillSection nodes={nodes} ids={ids} title="Text color" />}
      <StrokeSection nodes={nodes} ids={ids} />
      <EffectsSection nodes={nodes} ids={ids} />
      {single?.type === 'component' && <ComponentSection node={single as FrameNode} />}
      {single && <NotesSection node={single} />}
      {single && <ExportSection node={single} />}
    </div>
  );
}

function FramePresets() {
  const create = (p: (typeof PRESETS)[number]) => {
    const s = getState();
    const { width, height } = viewportSize();
    const c = toWorld(width / 2, height / 2);
    let id = '';
    commit((d) => {
      id = createNodes(d, [{ type: 'frame', name: p.name, x: Math.round(c.x - p.w / 2), y: Math.round(c.y - p.h / 2), width: p.w, height: p.h }], s.pageId).ids[0];
    });
    setSelection([id]);
    setTool('move');
  };
  return (
    <div className="design-panel">
      <Section title="Frame presets">
        <div className="presets">
          {PRESETS.map((p) => (
            <button key={p.name} onClick={() => create(p)}>
              <span>{p.name}</span>
              <span className="muted">
                {p.w}×{p.h}
              </span>
            </button>
          ))}
        </div>
      </Section>
      <p className="hint">Or drag on the canvas to draw a frame.</p>
    </div>
  );
}

function PageProps() {
  const page = useEditor((s) => s.doc?.pages[s.pageId]);
  const docName = useEditor((s) => s.doc?.name);
  const counts = useEditor(useShallow((s) => [Object.keys(s.doc?.nodes ?? {}).length, Object.keys(s.doc?.variables ?? {}).length]));
  if (!page) return null;
  return (
    <div className="design-panel">
      <Section title="Page">
        <Row>
          <span className="plabel">Background</span>
          <ColorField
            value={page.background ?? '#1E1E1E'}
            allowTokens={false}
            onChange={(v, o) =>
              commit(
                (d) => {
                  d.pages[page.id].background = v;
                },
                { key: o.scrub ? 'page-bg' : undefined },
              )
            }
          />
        </Row>
      </Section>
      <Section title="Document">
        <p className="muted small">
          {docName} · {counts[0]} layers · {counts[1]} tokens
        </p>
        <p className="hint">Select a layer to edit it. Use the Code tab to get implementation code, or the AI tab to design with Claude or GPT.</p>
      </Section>
    </div>
  );
}

function AlignBar({ count }: { count: number }) {
  return (
    <div className="alignbar">
      <IconBtn title="Align left" onClick={() => alignSelection('left')}>
        <AlignStartVertical size={15} />
      </IconBtn>
      <IconBtn title="Align horizontal centers" onClick={() => alignSelection('hcenter')}>
        <AlignCenterVertical size={15} />
      </IconBtn>
      <IconBtn title="Align right" onClick={() => alignSelection('right')}>
        <AlignEndVertical size={15} />
      </IconBtn>
      <IconBtn title="Align top" onClick={() => alignSelection('top')}>
        <AlignStartHorizontal size={15} />
      </IconBtn>
      <IconBtn title="Align vertical centers" onClick={() => alignSelection('vcenter')}>
        <AlignCenterHorizontal size={15} />
      </IconBtn>
      <IconBtn title="Align bottom" onClick={() => alignSelection('bottom')}>
        <AlignEndHorizontal size={15} />
      </IconBtn>
      <IconBtn title="Distribute horizontally" onClick={() => distributeSelection('x')} disabled={count < 3}>
        <AlignHorizontalSpaceBetween size={15} />
      </IconBtn>
      <IconBtn title="Distribute vertically" onClick={() => distributeSelection('y')} disabled={count < 3}>
        <AlignVerticalSpaceBetween size={15} />
      </IconBtn>
    </div>
  );
}

function TypeHeader({ nodes }: { nodes: SceneNode[] }) {
  const n = nodes[0];
  const label = nodes.length > 1 ? `${nodes.length} layers` : { frame: 'Frame', component: 'Component', instance: 'Instance', rect: 'Rectangle', ellipse: 'Ellipse', text: 'Text', image: 'Image', svg: 'Vector' }[n.type];
  return (
    <div className="type-header">
      <span className={n.type === 'component' || n.type === 'instance' ? 'component-color' : ''}>{label}</span>
      {nodes.length === 1 && n.type !== 'component' && n.type !== 'instance' && (
        <button className="btn ghost small" onClick={makeComponent} title="Create component (⌥⌘K)">
          <Component size={13} /> Make component
        </button>
      )}
      {nodes.length === 1 && n.type === 'component' && (
        <button className="btn ghost small" onClick={() => insertInstance(n.id)} title="Place an instance">
          <Plus size={13} /> Instance
        </button>
      )}
    </div>
  );
}

function GeometrySection({ nodes, ids }: { nodes: SceneNode[]; ids: string[] }) {
  const doc = useEditor((s) => s.doc)!;
  const inFlow = nodes.some((n) => isAutoLayout(doc.nodes[n.parentId]) && n.position !== 'absolute');
  const anyInAuto = nodes.some((n) => isAutoLayout(doc.nodes[n.parentId]));
  const canHug = nodes.every((n) => n.type === 'text' || n.type === 'instance' || (isFrameLike(n) && isAutoLayout(n)));
  const canFill = nodes.every((n) => isAutoLayout(doc.nodes[n.parentId]) && n.position !== 'absolute');
  const modeOptions = (): Array<{ value: SizeMode; label: string }> => [
    { value: 'fixed', label: 'Fixed' },
    ...(canHug ? [{ value: 'hug' as SizeMode, label: 'Hug' }] : []),
    ...(canFill ? [{ value: 'fill' as SizeMode, label: 'Fill' }] : []),
  ];
  const wm = common(nodes, (n) => sizeMode(n, 'w'));
  const hm = common(nodes, (n) => sizeMode(n, 'h'));
  return (
    <Section title="Layout">
      <Row>
        <NumField label="X" value={common(nodes, (n) => n.x)} disabled={inFlow} onChange={(v, o) => update(ids, (n) => (n.x = Number(v)), o.scrub ? 'x' : undefined)} />
        <NumField label="Y" value={common(nodes, (n) => n.y)} disabled={inFlow} onChange={(v, o) => update(ids, (n) => (n.y = Number(v)), o.scrub ? 'y' : undefined)} />
        <NumField
          label="⟳"
          title="Rotation"
          value={common(nodes, (n) => n.rotation ?? 0)}
          suffix="°"
          onChange={(v, o) =>
            update(
              ids,
              (n) => {
                if (Number(v)) n.rotation = Number(v);
                else delete n.rotation;
              },
              o.scrub ? 'rot' : undefined,
            )
          }
        />
      </Row>
      <Row>
        <NumField
          label="W"
          value={common(nodes, (n) => n.width)}
          min={1}
          onChange={(v, o) =>
            update(
              ids,
              (n) => {
                n.width = Number(v);
                n.widthMode = 'fixed';
              },
              o.scrub ? 'w' : undefined,
            )
          }
        />
        <NumField
          label="H"
          value={common(nodes, (n) => n.height)}
          min={1}
          onChange={(v, o) =>
            update(
              ids,
              (n) => {
                n.height = Number(v);
                n.heightMode = 'fixed';
              },
              o.scrub ? 'h' : undefined,
            )
          }
        />
      </Row>
      <Row>
        <span className="plabel">W</span>
        <Select value={wm === MIXED ? '' : wm} options={modeOptions()} onChange={(v) => update(ids, (n) => (n.widthMode = v))} title="Horizontal resizing" />
        <span className="plabel">H</span>
        <Select value={hm === MIXED ? '' : hm} options={modeOptions()} onChange={(v) => update(ids, (n) => (n.heightMode = v))} title="Vertical resizing" />
      </Row>
      {anyInAuto && (
        <Row>
          <label className="check">
            <input
              type="checkbox"
              checked={nodes.every((n) => n.position === 'absolute')}
              onChange={(e) =>
                update(ids, (n) => {
                  if (e.target.checked) {
                    n.position = 'absolute';
                    if (n.widthMode === 'fill') n.widthMode = 'fixed';
                    if (n.heightMode === 'fill') n.heightMode = 'fixed';
                  } else delete n.position;
                })
              }
            />
            Absolute position (ignore auto layout)
          </label>
        </Row>
      )}
    </Section>
  );
}

const JUSTIFY_OPTS = ['start', 'center', 'end'] as const;

function AutoLayoutSection({ nodes, ids }: { nodes: FrameNode[]; ids: string[] }) {
  const layout = nodes[0].layout;
  const has = nodes.every((n) => n.layout && n.layout.mode !== 'none');
  const pad0 = layout?.padding ?? [0, 0, 0, 0];
  const [showAll, setShowAll] = useState(!(pad0[1] === pad0[3] && pad0[0] === pad0[2]));
  const set =(fn: (l: AutoLayout, n: FrameNode) => void, key?: string) =>
    update(
      ids,
      (n) => {
        const f = n as FrameNode;
        f.layout = { ...(f.layout ?? { mode: 'column' }) } as AutoLayout;
        fn(f.layout, f);
      },
      key,
    );
  if (!has || !layout) {
    return (
      <Section
        title="Auto layout"
        actions={
          <IconBtn
            title="Add auto layout (⇧A)"
            onClick={() =>
              update(ids, (n) => {
                const f = n as FrameNode;
                f.layout = { gap: 8, padding: [16, 16, 16, 16], align: 'start', ...(f.layout ?? {}), mode: f.layout?.mode && f.layout.mode !== 'none' ? f.layout.mode : 'column' };
                if (!f.children.length) return;
                f.widthMode = 'hug';
                f.heightMode = 'hug';
              })
            }
          >
            <Plus size={14} />
          </IconBtn>
        }
      >
        <Row>
          <label className="check">
            <input type="checkbox" checked={nodes.every((n) => n.clip)} onChange={(e) => update(ids, (n) => ((n as FrameNode).clip = e.target.checked || undefined))} />
            Clip content
          </label>
        </Row>
      </Section>
    );
  }
  const pad = layout.padding ?? [0, 0, 0, 0];
  const justify = layout.justify ?? 'start';
  const align = layout.align ?? 'start';
  const row = layout.mode === 'row';
  return (
    <Section
      title="Auto layout"
      actions={
        <IconBtn title="Remove auto layout" onClick={() => set((l) => (l.mode = 'none'))}>
          <Minus size={14} />
        </IconBtn>
      }
    >
      <Row>
        <div className="seg">
          <IconBtn title="Vertical" active={layout.mode === 'column'} onClick={() => set((l) => (l.mode = 'column'))}>
            <ArrowDown size={14} />
          </IconBtn>
          <IconBtn title="Horizontal" active={layout.mode === 'row'} onClick={() => set((l) => (l.mode = 'row'))}>
            <ArrowRight size={14} />
          </IconBtn>
          <IconBtn title="Wrap" active={!!layout.wrap} onClick={() => set((l) => (l.wrap = !l.wrap || undefined))}>
            <WrapText size={14} />
          </IconBtn>
        </div>
        <NumField
          label="Gap"
          value={justify === 'space-between' ? 'Auto' : layout.gap ?? 0}
          allowToken
          disabled={justify === 'space-between'}
          onChange={(v, o) => set((l) => (l.gap = v), o.scrub ? 'gap' : undefined)}
        />
      </Row>
      <Row className="align-row">
        <div className={`align-grid ${row ? 'row' : 'col'}`} title="Alignment">
          {(['start', 'center', 'end'] as const).map((a) =>
            JUSTIFY_OPTS.map((j) => {
              const active = (justify === j || (justify === 'space-between' && j === 'center')) && align === a;
              return (
                <button
                  key={a + j}
                  className={active ? 'active' : ''}
                  style={row ? { gridRow: ['start', 'center', 'end'].indexOf(a) + 1, gridColumn: JUSTIFY_OPTS.indexOf(j) + 1 } : { gridColumn: ['start', 'center', 'end'].indexOf(a) + 1, gridRow: JUSTIFY_OPTS.indexOf(j) + 1 }}
                  onClick={() =>
                    set((l) => {
                      l.align = a;
                      if (l.justify !== 'space-between') l.justify = j;
                    })
                  }
                >
                  <span />
                </button>
              );
            }),
          )}
        </div>
        <div className="align-side">
          <label className="check">
            <input type="checkbox" checked={justify === 'space-between'} onChange={(e) => set((l) => (l.justify = e.target.checked ? 'space-between' : 'start'))} />
            Space between
          </label>
          <label className="check">
            <input type="checkbox" checked={align === 'stretch'} onChange={(e) => set((l) => (l.align = e.target.checked ? 'stretch' : 'start'))} />
            Stretch children
          </label>
          <label className="check">
            <input type="checkbox" checked={nodes.every((n) => n.clip)} onChange={(e) => update(ids, (n) => ((n as FrameNode).clip = e.target.checked || undefined))} />
            Clip content
          </label>
        </div>
      </Row>
      {!showAll ? (
        <Row>
          <NumField label="↔" title="Horizontal padding" value={pad[1]} allowToken onChange={(v, o) => set((l) => (l.padding = [pad[0], v, pad[2], v]), o.scrub ? 'padh' : undefined)} />
          <NumField label="↕" title="Vertical padding" value={pad[0]} allowToken onChange={(v, o) => set((l) => (l.padding = [v, pad[1], v, pad[3]]), o.scrub ? 'padv' : undefined)} />
          <IconBtn title="Individual padding" onClick={() => setShowAll(true)}>
            <Scan size={14} />
          </IconBtn>
        </Row>
      ) : (
        <>
          <Row>
            <NumField label="T" title="Top padding" value={pad[0]} allowToken onChange={(v, o) => set((l) => (l.padding = [v, pad[1], pad[2], pad[3]]), o.scrub ? 'padt' : undefined)} />
            <NumField label="R" title="Right padding" value={pad[1]} allowToken onChange={(v, o) => set((l) => (l.padding = [pad[0], v, pad[2], pad[3]]), o.scrub ? 'padr' : undefined)} />
            <IconBtn title="Uniform padding" active onClick={() => setShowAll(false)}>
              <Scan size={14} />
            </IconBtn>
          </Row>
          <Row>
            <NumField label="B" title="Bottom padding" value={pad[2]} allowToken onChange={(v, o) => set((l) => (l.padding = [pad[0], pad[1], v, pad[3]]), o.scrub ? 'padb' : undefined)} />
            <NumField label="L" title="Left padding" value={pad[3]} allowToken onChange={(v, o) => set((l) => (l.padding = [pad[0], pad[1], pad[2], v]), o.scrub ? 'padl' : undefined)} />
            <span style={{ width: 26 }} />
          </Row>
        </>
      )}
    </Section>
  );
}

function AppearanceSection({ nodes, ids }: { nodes: SceneNode[]; ids: string[] }) {
  const radius = common(nodes, (n) => n.radius ?? 0);
  const perCorner = Array.isArray(radius);
  const [corners, setCorners] = useState(perCorner);
  const noRadius = nodes.some((n) => n.type === 'ellipse' || n.type === 'text');
  const r = (radius === MIXED ? MIXED : Array.isArray(radius) ? radius : [radius, radius, radius, radius]) as any;
  return (
    <Section title="Appearance">
      <Row>
        <NumField
          label="◐"
          title="Opacity"
          value={common(nodes, (n) => Math.round((n.opacity ?? 1) * 100))}
          min={0}
          max={100}
          suffix="%"
          onChange={(v, o) =>
            update(
              ids,
              (n) => {
                const x = Number(v) / 100;
                if (x >= 1) delete n.opacity;
                else n.opacity = Math.max(0, x);
              },
              o.scrub ? 'opacity' : undefined,
            )
          }
        />
        {!noRadius && !corners && (
          <NumField
            label="◜"
            title="Corner radius"
            value={r === MIXED ? MIXED : r[0]}
            min={0}
            allowToken
            onChange={(v, o) =>
              update(
                ids,
                (n) => {
                  if (v === 0) delete n.radius;
                  else n.radius = v;
                },
                o.scrub ? 'radius' : undefined,
              )
            }
          />
        )}
        {!noRadius && (
          <IconBtn title="Independent corners" active={corners} onClick={() => setCorners(!corners)}>
            <SquareDashed size={14} />
          </IconBtn>
        )}
      </Row>
      {!noRadius && corners && r !== MIXED && (
        <Row>
          {['↖', '↗', '↘', '↙'].map((lbl, i) => (
            <NumField
              key={i}
              label={lbl}
              value={r[i]}
              min={0}
              onChange={(v, o) =>
                update(
                  ids,
                  (n) => {
                    const cur = (Array.isArray(n.radius) ? [...n.radius] : [n.radius ?? 0, n.radius ?? 0, n.radius ?? 0, n.radius ?? 0]) as [number, number, number, number];
                    cur[i] = v as number;
                    n.radius = cur;
                  },
                  o.scrub ? 'radius' + i : undefined,
                )
              }
            />
          ))}
        </Row>
      )}
    </Section>
  );
}

function FillSection({ nodes, ids, title }: { nodes: SceneNode[]; ids: string[]; title: string }) {
  const fills = common(nodes, (n) => n.fills ?? []);
  const setFills = (fn: (f: Paint[]) => Paint[], key?: string) => update(ids, (n) => (n.fills = fn([...(n.fills ?? [])])), key);
  return (
    <Section
      title={title}
      actions={
        <IconBtn title="Add fill" onClick={() => setFills((f) => [...f, { type: 'solid', color: f.length ? '#000000' : nodes[0].type === 'text' ? '#000000' : '#D9D9D9' }])}>
          <Plus size={14} />
        </IconBtn>
      }
    >
      {fills === MIXED && <p className="muted small">Mixed fills</p>}
      {fills !== MIXED &&
        [...fills]
          .map((p, i) => ({ p, i }))
          .reverse()
          .map(({ p, i }) => (
            <PaintRow
              key={i}
              paint={p}
              onChange={(np, o) => setFills((f) => f.map((x, j) => (j === i ? np : x)), o?.scrub ? `fill${i}` : undefined)}
              onRemove={() => setFills((f) => f.filter((_, j) => j !== i))}
            />
          ))}
    </Section>
  );
}

function PaintRow({ paint, onChange, onRemove }: { paint: Paint; onChange: (p: Paint, o?: { scrub?: boolean }) => void; onRemove: () => void }) {
  const hidden = paint.visible === false;
  return (
    <div className={`paint ${hidden ? 'hidden' : ''}`}>
      <Row>
        <Select
          value={paint.type}
          className="narrow"
          options={[
            { value: 'solid', label: 'Solid' },
            { value: 'gradient', label: 'Gradient' },
            { value: 'image', label: 'Image' },
          ]}
          onChange={(t) => {
            const base = paint.type === 'solid' ? paint.color : paint.type === 'gradient' ? paint.stops[0]?.color ?? '#000000' : '#D9D9D9';
            if (t === 'solid') onChange({ type: 'solid', color: base });
            if (t === 'gradient') onChange({ type: 'gradient', kind: 'linear', angle: 180, stops: [{ color: base, position: 0 }, { color: '#FFFFFF', position: 1 }] });
            if (t === 'image') onChange({ type: 'image', src: '', fit: 'cover' });
          }}
        />
        {paint.type === 'solid' && <ColorField value={paint.color} onChange={(c, o) => onChange({ ...paint, color: c }, o)} />}
        <span className="grow" />
        <IconBtn title={hidden ? 'Show' : 'Hide'} onClick={() => onChange({ ...paint, visible: hidden ? undefined : false } as Paint)}>
          {hidden ? <EyeOff size={14} /> : <Eye size={14} />}
        </IconBtn>
        <IconBtn title="Remove" onClick={onRemove}>
          <Minus size={14} />
        </IconBtn>
      </Row>
      {paint.type === 'gradient' && (
        <>
          <Row>
            <Select
              value={paint.kind ?? 'linear'}
              className="narrow"
              options={[
                { value: 'linear', label: 'Linear' },
                { value: 'radial', label: 'Radial' },
              ]}
              onChange={(k) => onChange({ ...paint, kind: k })}
            />
            {paint.kind !== 'radial' && <NumField label="∠" value={paint.angle ?? 180} suffix="°" onChange={(v, o) => onChange({ ...paint, angle: Number(v) }, o)} />}
          </Row>
          {paint.stops.map((st, si) => (
            <Row key={si}>
              <NumField label="" width={56} value={Math.round(st.position * 100)} min={0} max={100} suffix="%" onChange={(v, o) => onChange({ ...paint, stops: paint.stops.map((x, j) => (j === si ? { ...x, position: Number(v) / 100 } : x)) }, o)} />
              <ColorField value={st.color} onChange={(c, o) => onChange({ ...paint, stops: paint.stops.map((x, j) => (j === si ? { ...x, color: c } : x)) }, o)} />
              {paint.stops.length > 2 && (
                <IconBtn title="Remove stop" onClick={() => onChange({ ...paint, stops: paint.stops.filter((_, j) => j !== si) })}>
                  <Minus size={12} />
                </IconBtn>
              )}
            </Row>
          ))}
          <button className="btn ghost small" onClick={() => onChange({ ...paint, stops: [...paint.stops, { color: '#888888', position: 0.5 }].sort((a, b) => a.position - b.position) })}>
            <Plus size={12} /> Stop
          </button>
        </>
      )}
      {paint.type === 'image' && (
        <Row>
          <input className="text-input grow" placeholder="Image URL" value={paint.src} onChange={(e) => onChange({ ...paint, src: e.target.value })} />
          <IconBtn
            title="Upload"
            onClick={() => {
              const input = document.createElement('input');
              input.type = 'file';
              input.accept = 'image/*';
              input.onchange = async () => {
                const f = input.files?.[0];
                if (f) onChange({ ...paint, src: await uploadImage(f) });
              };
              input.click();
            }}
          >
            <ImageIcon size={14} />
          </IconBtn>
          <Select
            value={paint.fit ?? 'cover'}
            className="narrow"
            options={[
              { value: 'cover', label: 'Fill' },
              { value: 'contain', label: 'Fit' },
              { value: 'fill', label: 'Stretch' },
            ]}
            onChange={(fit) => onChange({ ...paint, fit })}
          />
        </Row>
      )}
    </div>
  );
}

function StrokeSection({ nodes, ids }: { nodes: SceneNode[]; ids: string[] }) {
  const stroke = common(nodes, (n) => n.stroke ?? null);
  const set = (fn: (s: Stroke) => Stroke, key?: string) => update(ids, (n) => (n.stroke = fn({ ...(n.stroke ?? { color: '#000000', width: 1 }) })), key);
  return (
    <Section
      title="Stroke"
      actions={
        stroke ? (
          <IconBtn title="Remove stroke" onClick={() => update(ids, (n) => delete n.stroke)}>
            <Minus size={14} />
          </IconBtn>
        ) : (
          <IconBtn title="Add stroke" onClick={() => set(() => ({ color: '#000000', width: 1, align: 'inside' }))}>
            <Plus size={14} />
          </IconBtn>
        )
      }
    >
      {stroke === MIXED && <p className="muted small">Mixed strokes</p>}
      {stroke && stroke !== MIXED && (
        <>
          <Row>
            <ColorField value={stroke.color} onChange={(c, o) => set((s) => ({ ...s, color: c }), o.scrub ? 'stroke-color' : undefined)} />
          </Row>
          <Row>
            <NumField label="W" title="Stroke width" value={stroke.width} min={0} step={0.5} onChange={(v, o) => set((s) => ({ ...s, width: Number(v) }), o.scrub ? 'stroke-w' : undefined)} />
            <Select
              value={stroke.align ?? 'inside'}
              options={[
                { value: 'inside', label: 'Inside' },
                { value: 'center', label: 'Center' },
                { value: 'outside', label: 'Outside' },
              ]}
              onChange={(v) => set((s) => ({ ...s, align: v }))}
            />
            <Select
              value={stroke.style ?? 'solid'}
              options={[
                { value: 'solid', label: 'Solid' },
                { value: 'dashed', label: 'Dashed' },
                { value: 'dotted', label: 'Dotted' },
              ]}
              onChange={(v) => set((s) => ({ ...s, style: v }))}
            />
          </Row>
        </>
      )}
    </Section>
  );
}

function EffectsSection({ nodes, ids }: { nodes: SceneNode[]; ids: string[] }) {
  const shadows = common(nodes, (n) => n.shadows ?? []);
  const blur = common(nodes, (n) => n.blur ?? 0);
  const bblur = common(nodes, (n) => n.backdropBlur ?? 0);
  const [showBlur, setShowBlur] = useState(false);
  const setShadows = (fn: (s: Shadow[]) => Shadow[], key?: string) =>
    update(
      ids,
      (n) => {
        const next = fn([...(n.shadows ?? [])]);
        if (next.length) n.shadows = next;
        else delete n.shadows;
      },
      key,
    );
  return (
    <Section
      title="Effects"
      actions={
        <>
          <IconBtn title="Blur" active={showBlur || blur !== 0 || bblur !== 0} onClick={() => setShowBlur(!showBlur)}>
            <span style={{ fontSize: 11 }}>Blur</span>
          </IconBtn>
          <IconBtn title="Add shadow" onClick={() => setShadows((s) => [...s, { type: 'drop', x: 0, y: 4, blur: 12, spread: 0, color: '#0000001F' }])}>
            <Plus size={14} />
          </IconBtn>
        </>
      }
    >
      {shadows !== MIXED &&
        shadows.map((sh, i) => (
          <div key={i} className="paint">
            <Row>
              <Select
                value={sh.type ?? 'drop'}
                className="narrow"
                options={[
                  { value: 'drop', label: 'Drop shadow' },
                  { value: 'inner', label: 'Inner shadow' },
                ]}
                onChange={(t) => setShadows((s) => s.map((x, j) => (j === i ? { ...x, type: t } : x)))}
              />
              <ColorField value={sh.color} onChange={(c, o) => setShadows((s) => s.map((x, j) => (j === i ? { ...x, color: c } : x)), o.scrub ? 'sh-c' + i : undefined)} />
              <IconBtn title="Remove" onClick={() => setShadows((s) => s.filter((_, j) => j !== i))}>
                <Minus size={14} />
              </IconBtn>
            </Row>
            <Row>
              {(['x', 'y', 'blur', 'spread'] as const).map((k) => (
                <NumField
                  key={k}
                  label={k === 'blur' ? 'B' : k === 'spread' ? 'S' : k.toUpperCase()}
                  title={k}
                  value={sh[k] ?? 0}
                  min={k === 'blur' ? 0 : undefined}
                  onChange={(v, o) => setShadows((s) => s.map((x, j) => (j === i ? { ...x, [k]: Number(v) } : x)), o.scrub ? `sh-${k}${i}` : undefined)}
                />
              ))}
            </Row>
          </div>
        ))}
      {(showBlur || blur !== 0 || bblur !== 0) && (
        <Row>
          <NumField label="Layer" title="Layer blur" value={blur} min={0} onChange={(v, o) => update(ids, (n) => (Number(v) ? (n.blur = Number(v)) : delete n.blur), o.scrub ? 'blur' : undefined)} />
          <NumField label="Bg" title="Background blur (backdrop-filter)" value={bblur} min={0} onChange={(v, o) => update(ids, (n) => (Number(v) ? (n.backdropBlur = Number(v)) : delete n.backdropBlur), o.scrub ? 'bblur' : undefined)} />
        </Row>
      )}
    </Section>
  );
}

const SYSTEM_FONTS = ['system-ui', 'Helvetica', 'Arial', 'Georgia', 'Times New Roman', 'Menlo'];
const WEIGHTS = [
  [100, 'Thin'],
  [200, 'Extra Light'],
  [300, 'Light'],
  [400, 'Regular'],
  [500, 'Medium'],
  [600, 'Semi Bold'],
  [700, 'Bold'],
  [800, 'Extra Bold'],
  [900, 'Black'],
] as const;

function TextSection({ nodes, ids }: { nodes: TextNode[]; ids: string[] }) {
  const fam = common(nodes, (n) => n.fontFamily ?? 'Inter');
  const weight = common(nodes, (n) => n.fontWeight ?? 400);
  const align = common(nodes, (n) => n.textAlign ?? 'left');
  const deco = common(nodes, (n) => n.textDecoration ?? 'none');
  const tt = common(nodes, (n) => n.textTransform ?? 'none');
  const italic = common(nodes, (n) => !!n.italic);
  const fonts = [...GOOGLE_FONTS, ...SYSTEM_FONTS];
  const famValue = fam === MIXED ? '' : (fam as string);
  return (
    <Section title="Typography">
      <Row>
        <select
          className="select grow"
          value={famValue && fonts.includes(famValue) ? famValue : famValue ? '__custom' : ''}
          onChange={(e) => {
            let v = e.target.value;
            if (v === '__custom') {
              v = prompt('Font family (Google Fonts name or installed font)', famValue) ?? '';
              if (!v) return;
            }
            update(ids, (n) => (n.fontFamily = v));
          }}
        >
          {fam === MIXED && <option value="">Mixed</option>}
          {famValue && !fonts.includes(famValue) && <option value="__custom">{famValue}</option>}
          <optgroup label="Google Fonts">
            {GOOGLE_FONTS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </optgroup>
          <optgroup label="System">
            {SYSTEM_FONTS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </optgroup>
          <option value="__custom">Custom…</option>
        </select>
      </Row>
      <Row>
        <select className="select grow" value={weight === MIXED ? '' : String(weight)} onChange={(e) => update(ids, (n) => (n.fontWeight = Number(e.target.value)))}>
          {weight === MIXED && <option value="">Mixed</option>}
          {WEIGHTS.map(([w, l]) => (
            <option key={w} value={w}>
              {l} · {w}
            </option>
          ))}
        </select>
        <NumField label="Aa" title="Font size" value={common(nodes, (n) => n.fontSize ?? 16)} min={1} allowToken onChange={(v, o) => update(ids, (n) => (n.fontSize = v), o.scrub ? 'fs' : undefined)} />
      </Row>
      <Row>
        <NumField
          label="LH"
          title="Line height (px, or e.g. 150%)"
          value={common(nodes, (n) => (n.lineHeight === undefined ? 'Auto' : n.lineHeight))}
          allowToken
          onChange={(v, o) => update(ids, (n) => (n.lineHeight = v), o.scrub ? 'lh' : undefined)}
        />
        <NumField label="LS" title="Letter spacing (px)" value={common(nodes, (n) => n.letterSpacing ?? 0)} step={0.1} onChange={(v, o) => update(ids, (n) => (Number(v) ? (n.letterSpacing = Number(v)) : delete n.letterSpacing), o.scrub ? 'ls' : undefined)} />
      </Row>
      <Row>
        <div className="seg">
          {(
            [
              ['left', AlignLeft],
              ['center', AlignCenter],
              ['right', AlignRight],
              ['justify', AlignJustify],
            ] as const
          ).map(([a, Icon]) => (
            <IconBtn key={a} title={`Align ${a}`} active={align === a} onClick={() => update(ids, (n) => (a === 'left' ? delete n.textAlign : (n.textAlign = a)))}>
              <Icon size={14} />
            </IconBtn>
          ))}
        </div>
        <div className="seg">
          <IconBtn title="Bold" active={weight !== MIXED && weight >= 600} onClick={() => update(ids, (n) => (n.fontWeight = (n.fontWeight ?? 400) >= 600 ? 400 : 700))}>
            <Bold size={14} />
          </IconBtn>
          <IconBtn title="Italic" active={italic === true} onClick={() => update(ids, (n) => (n.italic ? delete n.italic : (n.italic = true)))}>
            <Italic size={14} />
          </IconBtn>
          <IconBtn title="Underline" active={deco === 'underline'} onClick={() => update(ids, (n) => (n.textDecoration === 'underline' ? delete n.textDecoration : (n.textDecoration = 'underline')))}>
            <Underline size={14} />
          </IconBtn>
          <IconBtn title="Strikethrough" active={deco === 'line-through'} onClick={() => update(ids, (n) => (n.textDecoration === 'line-through' ? delete n.textDecoration : (n.textDecoration = 'line-through')))}>
            <Strikethrough size={14} />
          </IconBtn>
        </div>
      </Row>
      <Row>
        <span className="plabel">Case</span>
        <Select
          value={tt === MIXED ? '' : tt}
          options={[
            { value: 'none', label: 'As typed' },
            { value: 'uppercase', label: 'UPPERCASE' },
            { value: 'lowercase', label: 'lowercase' },
            { value: 'capitalize', label: 'Title Case' },
          ]}
          onChange={(v) => update(ids, (n) => (v === 'none' ? delete n.textTransform : (n.textTransform = v)))}
        />
      </Row>
    </Section>
  );
}

function ImageSection({ node }: { node: ImageNode }) {
  return (
    <Section title="Image">
      <Row>
        <input className="text-input grow" value={node.src} placeholder="https://… or upload" onChange={(e) => update([node.id], (n) => (n.src = e.target.value))} />
        <IconBtn
          title="Replace image"
          onClick={() => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.onchange = async () => {
              const f = input.files?.[0];
              if (f) {
                const url = await uploadImage(f);
                update([node.id], (n) => (n.src = url));
              }
            };
            input.click();
          }}
        >
          <ImageIcon size={14} />
        </IconBtn>
      </Row>
      <Row>
        <span className="plabel">Fit</span>
        <Select
          value={node.fit ?? 'cover'}
          options={[
            { value: 'cover', label: 'Fill (cover)' },
            { value: 'contain', label: 'Fit (contain)' },
            { value: 'fill', label: 'Stretch' },
          ]}
          onChange={(v) => update([node.id], (n) => (n.fit = v))}
        />
      </Row>
      <Row>
        <input className="text-input grow" value={node.alt ?? ''} placeholder="Alt text" onChange={(e) => update([node.id], (n) => (n.alt = e.target.value || undefined), 'alt')} />
      </Row>
    </Section>
  );
}

function SvgSection({ node }: { node: { id: string; svg: string } }) {
  const [text, setText] = useState(node.svg);
  return (
    <Section title="SVG markup">
      <textarea className="code-input" rows={6} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => text !== node.svg && update([node.id], (n) => (n.svg = text))} spellCheck={false} />
      <p className="hint">Paste any SVG (icons from Lucide, Heroicons…). Use explicit colors.</p>
    </Section>
  );
}

function ComponentSection({ node }: { node: FrameNode }) {
  const cc = node.codeConnect ?? { name: '' };
  const setCC = (patch: Partial<NonNullable<FrameNode['codeConnect']>>) =>
    update(
      [node.id],
      (n) => {
        const next = { ...(n.codeConnect ?? { name: '' }), ...patch };
        if (!next.name && !next.importPath && !next.notes) delete n.codeConnect;
        else n.codeConnect = next;
      },
      'cc',
    );
  const instances = useEditor(useShallow((s) => Object.values(s.doc?.nodes ?? {}).filter((n) => n.type === 'instance' && (n as InstanceNode).componentId === node.id).length));
  return (
    <Section
      title={
        <span>
          <Link2 size={12} /> Code Connect
        </span>
      }
    >
      <p className="hint">Map this component to your codebase so generated code and AI agents use it ({instances} instance{instances === 1 ? '' : 's'}).</p>
      <Row>
        <input className="text-input grow" placeholder="Component name, e.g. Button" value={cc.name} onChange={(e) => setCC({ name: e.target.value })} />
      </Row>
      <Row>
        <input className="text-input grow" placeholder="Import path, e.g. @/components/ui/button" value={cc.importPath ?? ''} onChange={(e) => setCC({ importPath: e.target.value || undefined })} />
      </Row>
      <Row>
        <input className="text-input grow" placeholder="Usage notes (props, variants)…" value={cc.notes ?? ''} onChange={(e) => setCC({ notes: e.target.value || undefined })} />
      </Row>
    </Section>
  );
}

function InstanceSection({ node }: { node: InstanceNode }) {
  const doc = useEditor((s) => s.doc)!;
  const comp = doc.nodes[node.componentId];
  const layers = instanceLayers(doc, node).filter((l) => l.node.type === 'text' || l.depth === 0);
  const setOverride = (key: string, patch: Record<string, any> | null) =>
    update(
      [node.id],
      (n) => {
        const o = { ...((n as InstanceNode).overrides ?? {}) };
        if (patch === null) delete o[key];
        else o[key] = { ...(o[key] ?? {}), ...patch };
        for (const k of Object.keys(o)) for (const kk of Object.keys(o[k])) if ((o[k] as any)[kk] === undefined) delete (o[k] as any)[kk];
        (n as InstanceNode).overrides = Object.keys(o).length ? o : undefined;
        if (!(n as InstanceNode).overrides) delete (n as any).overrides;
      },
      'override-' + key,
    );
  return (
    <Section title={<span className="component-color">◇ {comp?.name ?? 'Missing component'}</span>}>
      <Row>
        <button className="btn small" onClick={() => goToMainComponent(node.id)} disabled={!comp}>
          Go to main
        </button>
        <button className="btn small" onClick={detachSelection}>
          <Unlink size={12} /> Detach
        </button>
        {node.overrides && (
          <button className="btn small ghost" onClick={() => update([node.id], (n) => delete (n as any).overrides)}>
            Reset
          </button>
        )}
      </Row>
      {layers
        .filter((l) => l.node.type === 'text')
        .map((l) => (
          <div key={l.key} className="override">
            <div className="override-head">
              <span className="muted small">{l.node.name}</span>
              <IconBtn title="Toggle visibility" onClick={() => setOverride(l.key, { visible: l.node.visible === false ? undefined : false })}>
                {l.node.visible === false ? <EyeOff size={12} /> : <Eye size={12} />}
              </IconBtn>
            </div>
            <input className="text-input" value={(l.node as TextNode).text} onChange={(e) => setOverride(l.key, { text: e.target.value })} />
          </div>
        ))}
      {layers
        .filter((l) => l.node.type !== 'text' && l.depth === 0)
        .map((l) => (
          <Row key={l.key}>
            <span className="muted small grow">{l.node.name}</span>
            <IconBtn title="Toggle visibility" onClick={() => setOverride(l.key, { visible: l.node.visible === false ? undefined : false })}>
              {l.node.visible === false ? <EyeOff size={12} /> : <Eye size={12} />}
            </IconBtn>
          </Row>
        ))}
    </Section>
  );
}

function NotesSection({ node }: { node: SceneNode }) {
  const [text, setText] = useState(node.description ?? '');
  return (
    <Section title="Dev notes" collapsible>
      <textarea
        className="text-input"
        rows={2}
        placeholder="Notes for engineers & AI agents (behavior, data, states)…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== (node.description ?? '') && update([node.id], (n) => (text ? (n.description = text) : delete n.description))}
      />
    </Section>
  );
}

function ExportSection({ node }: { node: SceneNode }) {
  return (
    <Section title="Export" collapsible>
      <Row>
        <button className="btn small" onClick={() => downloadPng(node.id, 1)}>
          PNG 1×
        </button>
        <button className="btn small" onClick={() => downloadPng(node.id, 2)}>
          PNG 2×
        </button>
        <button className="btn small" onClick={() => copyAsCode(node.id)}>
          Copy React
        </button>
      </Row>
    </Section>
  );
}

