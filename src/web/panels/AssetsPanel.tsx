import { useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { FrameNode } from '../../shared/types.ts';
import { pageOf } from '../../shared/doc.ts';
import { buildRenderTree } from '../../shared/tree.ts';
import { variablesStyleMap } from '../../shared/style.ts';
import { getState, setState, useEditor } from '../store.ts';
import { insertInstance } from '../editor/actions.ts';
import { zoomToNodes } from '../editor/viewport.ts';
import { PreviewNode } from '../canvas/Preview.tsx';

export function AssetsPanel() {
  const comps = useEditor(useShallow((s) => Object.values(s.doc?.nodes ?? {}).filter((n) => n.type === 'component') as FrameNode[]));
  const [q, setQ] = useState('');
  const filtered = comps.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="assets">
      <input className="text-input search" placeholder="Search components" value={q} onChange={(e) => setQ(e.target.value)} />
      {!comps.length && (
        <p className="hint pad">
          No components yet. Select a frame and press <kbd>⌥⌘K</kbd> (or “Make component”) to create one. Components can be mapped to code via Code Connect.
        </p>
      )}
      <div className="asset-grid">
        {filtered.map((c) => (
          <ComponentCard key={c.id} comp={c} />
        ))}
      </div>
    </div>
  );
}

function ComponentCard({ comp }: { comp: FrameNode }) {
  const nodes = useEditor((s) => s.doc?.nodes);
  const vars = useEditor((s) => s.doc?.variables);
  const tree = useMemo(() => (getState().doc ? buildRenderTree(getState().doc!, comp.id) : null), [nodes, comp.id]);
  const varStyle = useMemo(() => variablesStyleMap(vars ?? {}), [vars]);
  const scale = Math.min(1, 104 / Math.max(comp.width, 1), 56 / Math.max(comp.height, 1));
  return (
    <div
      className="asset-card"
      draggable
      title={`${comp.name} — click to insert, drag onto the canvas, double-click to edit the main component`}
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-dc-component', comp.id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={() => insertInstance(comp.id)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        const doc = getState().doc!;
        const p = pageOf(doc, comp.id);
        if (p) setState({ pageId: p, selection: [comp.id] });
        requestAnimationFrame(() => zoomToNodes([comp.id]));
      }}
    >
      <div className="asset-preview" style={varStyle as any}>
        <div style={{ transform: `scale(${scale})`, transformOrigin: 'center', width: comp.width, height: comp.height, position: 'relative', flexShrink: 0 }}>
          {tree && <PreviewNode rn={tree} parent={null} root />}
        </div>
      </div>
      <div className="asset-name">{comp.name}</div>
      {comp.codeConnect?.name && <div className="asset-cc">&lt;{comp.codeConnect.name} /&gt;</div>}
    </div>
  );
}
