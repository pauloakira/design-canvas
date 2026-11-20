import { memo, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { ChevronDown, ChevronRight, Component, Diamond, Eye, EyeOff, Frame, Image as ImageIcon, Lock, Unlock, Plus, Square, Circle, Type, PenTool, X, LayoutGrid, Rows3, Columns3 } from 'lucide-react';
import type { FrameNode, SceneNode } from '../../shared/types.ts';
import { isAutoLayout, isFrameLike, isPageId, pathOf } from '../../shared/doc.ts';
import { addPage, deletePage, moveNodes } from '../../shared/ops.ts';
import { commit, getState, setSelection, setState, toast, useEditor } from '../store.ts';
import { renameNode, toggleLocked, toggleVisible } from '../editor/actions.ts';
import { zoomToNodes } from '../editor/viewport.ts';
import { sendPresence } from '../sync.ts';

const useLayersUI = create<{ expanded: Record<string, boolean>; drop: { id: string; pos: 'before' | 'after' | 'inside' } | null; dragging: string[] }>(() => ({
  expanded: {},
  drop: null,
  dragging: [],
}));

export function NodeIcon({ node, size = 13 }: { node: SceneNode; size?: number }) {
  switch (node.type) {
    case 'frame': {
      const l = (node as FrameNode).layout;
      if (l && l.mode === 'row') return <Columns3 size={size} />;
      if (l && l.mode === 'column') return <Rows3 size={size} />;
      return (node as FrameNode).children.length && !isPageId(getState().doc!, node.parentId) ? <LayoutGrid size={size} /> : <Frame size={size} />;
    }
    case 'component':
      return <Component size={size} className="component-color" />;
    case 'instance':
      return <Diamond size={size} className="component-color" />;
    case 'rect':
      return <Square size={size} />;
    case 'ellipse':
      return <Circle size={size} />;
    case 'text':
      return <Type size={size} />;
    case 'image':
      return <ImageIcon size={size} />;
    case 'svg':
      return <PenTool size={size} />;
  }
}

function displayChildren(parent: SceneNode | undefined, list: string[]): string[] {
  // Auto layout shows children in flow order; free-form shows top-most first (like Figma).
  return parent && isAutoLayout(parent) ? list : [...list].reverse();
}

export function LayersPanel() {
  const page = useEditor((s) => s.doc?.pages[s.pageId]);
  const selection = useEditor((s) => s.selection);
  // Auto-expand ancestors of the selection.
  useEffect(() => {
    const doc = getState().doc;
    if (!doc || !selection.length) return;
    const exp = { ...useLayersUI.getState().expanded };
    let changed = false;
    for (const id of selection) {
      for (const a of pathOf(doc, id).slice(0, -1)) {
        if (!exp[a]) {
          exp[a] = true;
          changed = true;
        }
      }
    }
    if (changed) useLayersUI.setState({ expanded: exp });
    requestAnimationFrame(() => document.querySelector(`.layer-row[data-id="${CSS.escape(selection[0])}"]`)?.scrollIntoView({ block: 'nearest' }));
  }, [selection]);
  if (!page) return null;
  return (
    <div className="layers">
      <PagesList />
      <div className="layers-title">Layers</div>
      <div className="layers-tree" onPointerLeave={() => setState({ hoverId: null })}>
        {displayChildren(undefined, page.children).map((id) => (
          <LayerRow key={id} id={id} depth={0} />
        ))}
        {!page.children.length && <p className="hint pad">No layers yet. Draw a frame (F) or ask the AI.</p>}
      </div>
    </div>
  );
}

function PagesList() {
  const pages = useEditor(useShallow((s) => s.doc?.pageOrder.map((p) => s.doc!.pages[p]) ?? []));
  const pageId = useEditor((s) => s.pageId);
  const [editing, setEditing] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  if (!pages.length) return null;
  return (
    <div className="pages">
      <div className="layers-title" onClick={() => setOpen(!open)}>
        <span>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Pages
        </span>
        <button
          className="iconbtn"
          title="Add page"
          onClick={(e) => {
            e.stopPropagation();
            let id = '';
            commit((d) => {
              id = addPage(d);
            });
            setState({ pageId: id, selection: [] });
          }}
        >
          <Plus size={13} />
        </button>
      </div>
      {open &&
        pages.map((p) => (
          <div
            key={p.id}
            className={`page-row ${p.id === pageId ? 'active' : ''}`}
            onClick={() => {
              setState({ pageId: p.id, selection: [] });
              sendPresence(true);
            }}
            onDoubleClick={() => setEditing(p.id)}
          >
            {editing === p.id ? (
              <input
                autoFocus
                defaultValue={p.name}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v) commit((d) => (d.pages[p.id].name = v));
                  setEditing(null);
                }}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === 'Escape') && (e.target as HTMLInputElement).blur()}
              />
            ) : (
              <span>{p.name}</span>
            )}
            {pages.length > 1 && (
              <button
                className="iconbtn hover-only"
                title="Delete page"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!confirm(`Delete page "${p.name}" and everything on it?`)) return;
                  try {
                    commit((d) => deletePage(d, p.id));
                    if (getState().pageId === p.id) setState({ pageId: getState().doc!.pageOrder[0] });
                  } catch (err: any) {
                    toast(err.message, { kind: 'error' });
                  }
                }}
              >
                <X size={12} />
              </button>
            )}
          </div>
        ))}
    </div>
  );
}

const LayerRow = memo(function LayerRow({ id, depth }: { id: string; depth: number }) {
  const node = useEditor((s) => s.doc?.nodes[id]);
  const parent = useEditor((s) => (node ? s.doc?.nodes[node.parentId] : undefined));
  const selected = useEditor((s) => s.selection.includes(id));
  const hovered = useEditor((s) => s.hoverId === id);
  const expanded = useLayersUI((s) => !!s.expanded[id]);
  const drop = useLayersUI((s) => (s.drop?.id === id ? s.drop.pos : null));
  const [renaming, setRenaming] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  if (!node) return null;
  const hasKids = isFrameLike(node) && node.children.length > 0;
  const hidden = node.visible === false;
  const onClick = (e: React.MouseEvent) => {
    const s = getState();
    if (e.shiftKey || e.metaKey || e.ctrlKey) setSelection(s.selection.includes(id) ? s.selection.filter((x) => x !== id) : [...s.selection, id]);
    else setSelection([id]);
    sendPresence(true);
  };
  return (
    <>
      <div
        ref={rowRef}
        data-id={id}
        className={`layer-row ${selected ? 'selected' : ''} ${hovered ? 'hovered' : ''} ${hidden ? 'dim' : ''} ${drop ? 'drop-' + drop : ''} ${node.type === 'component' || node.type === 'instance' ? 'component' : ''}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={onClick}
        onDoubleClick={() => setRenaming(true)}
        onPointerEnter={() => setState({ hoverId: id })}
        draggable={!renaming}
        onDragStart={(e) => {
          const sel = getState().selection;
          const ids = sel.includes(id) ? sel : [id];
          useLayersUI.setState({ dragging: ids });
          e.dataTransfer.setData('application/x-dc-layer', id);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragEnd={() => useLayersUI.setState({ drop: null, dragging: [] })}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('application/x-dc-layer')) return;
          const dragging = useLayersUI.getState().dragging;
          const doc = getState().doc!;
          if (dragging.some((d) => d === id || pathOf(doc, id).includes(d))) return;
          e.preventDefault();
          const r = rowRef.current!.getBoundingClientRect();
          const y = e.clientY - r.top;
          const container = isFrameLike(node);
          const pos = y < r.height * 0.3 ? 'before' : y > r.height * 0.7 ? (container && expanded && hasKids ? 'inside' : 'after') : container ? 'inside' : y < r.height / 2 ? 'before' : 'after';
          const cur = useLayersUI.getState().drop;
          if (cur?.id !== id || cur.pos !== pos) useLayersUI.setState({ drop: { id, pos } });
        }}
        onDragLeave={() => {
          if (useLayersUI.getState().drop?.id === id) useLayersUI.setState({ drop: null });
        }}
        onDrop={(e) => {
          e.preventDefault();
          const d0 = useLayersUI.getState();
          useLayersUI.setState({ drop: null, dragging: [] });
          if (!d0.drop) return;
          dropLayers(d0.dragging, id, d0.drop.pos);
        }}
      >
        <span
          className="caret"
          onClick={(e) => {
            e.stopPropagation();
            useLayersUI.setState((s) => ({ expanded: { ...s.expanded, [id]: !s.expanded[id] } }));
          }}
        >
          {hasKids ? expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : null}
        </span>
        <span className="layer-icon">
          <NodeIcon node={node} />
        </span>
        {renaming ? (
          <input
            className="rename"
            autoFocus
            defaultValue={node.name}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              renameNode(id, e.target.value);
              setRenaming(false);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <span className="layer-name" title={node.name}>
            {node.name}
          </span>
        )}
        <span className="layer-actions">
          <button
            className={`iconbtn ${node.locked ? 'on' : ''}`}
            title={node.locked ? 'Unlock' : 'Lock'}
            onClick={(e) => {
              e.stopPropagation();
              toggleLocked([id]);
            }}
          >
            {node.locked ? <Lock size={12} /> : <Unlock size={12} />}
          </button>
          <button
            className={`iconbtn ${hidden ? 'on' : ''}`}
            title={hidden ? 'Show' : 'Hide'}
            onClick={(e) => {
              e.stopPropagation();
              toggleVisible([id]);
            }}
          >
            {hidden ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
        </span>
      </div>
      {hasKids &&
        expanded &&
        displayChildren(node, (node as FrameNode).children).map((c) => <LayerRow key={c} id={c} depth={depth + 1} />)}
    </>
  );
});

function dropLayers(ids: string[], targetId: string, pos: 'before' | 'after' | 'inside') {
  const doc = getState().doc!;
  const target = doc.nodes[targetId];
  if (!target || !ids.length) return;
  try {
    if (pos === 'inside') {
      commit((d) => moveNodes(d, ids, targetId, isAutoLayout(d.nodes[targetId]) ? 0 : undefined), { selectionAfter: ids });
      useLayersUI.setState((s) => ({ expanded: { ...s.expanded, [targetId]: true } }));
      return;
    }
    const parentId = target.parentId;
    const parent = doc.nodes[parentId];
    const list = isPageId(doc, parentId) ? doc.pages[parentId].children : (parent as FrameNode).children;
    const reversed = !(parent && isAutoLayout(parent));
    const remaining = list.filter((x) => !ids.includes(x));
    const idx = remaining.indexOf(targetId);
    const index = reversed ? (pos === 'before' ? idx + 1 : idx) : pos === 'before' ? idx : idx + 1;
    commit((d) => moveNodes(d, ids, parentId, index), { selectionAfter: ids });
  } catch (e: any) {
    toast(e.message, { kind: 'error' });
  }
}

export function revealInLayers(id: string) {
  setSelection([id]);
  zoomToNodes([id]);
}
