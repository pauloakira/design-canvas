import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import DOMPurify from 'dompurify';
import type { CSSProperties } from 'react';
import type { FrameNode, ImageNode, SceneNode, SvgNode, TextNode } from '../../shared/types.ts';
import { nodeStyle } from '../../shared/style.ts';
import { buildRenderTree, type RenderNode } from '../../shared/tree.ts';
import { commit, getState, setState, useEditor } from '../store.ts';

export function sanitizeSvg(svg: string): string {
  const clean = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
  return clean.replace(/<svg\b([^>]*)>/i, (_m, attrs: string) => `<svg${attrs.replace(/\s(width|height)="[^"]*"/g, '')} width="100%" height="100%" preserveAspectRatio="${/preserveAspectRatio/.test(attrs) ? '' : 'xMidYMid meet'}">`.replace(' preserveAspectRatio=""', ''));
}

const svgCache = new Map<string, string>();
function cachedSvg(svg: string) {
  let v = svgCache.get(svg);
  if (v === undefined) {
    v = sanitizeSvg(svg);
    if (svgCache.size > 500) svgCache.clear();
    svgCache.set(svg, v);
  }
  return v;
}

interface ParentInfo {
  type: SceneNode['type'];
  layout?: FrameNode['layout'];
}

function toReactStyle(s: Record<string, string>): CSSProperties {
  return s as CSSProperties;
}

/** Renders one real document node (and its children) on the canvas. */
export const NodeView = memo(function NodeView({ id }: { id: string }) {
  const node = useEditor((s) => s.doc?.nodes[id]);
  const parentType = useEditor((s) => (node ? s.doc?.nodes[node.parentId]?.type : undefined));
  const parentLayout = useEditor((s) => (node ? (s.doc?.nodes[node.parentId] as FrameNode | undefined)?.layout : undefined));
  const editing = useEditor((s) => s.editingTextId === id);
  if (!node) return null;
  const parent: ParentInfo | null = parentType ? { type: parentType, layout: parentLayout } : null;
  if (node.type === 'instance') return <InstanceView id={id} parent={parent} />;
  const style = toReactStyle(nodeStyle(node, { parent: parent as any, editor: true }));
  const common = { 'data-node-id': id, style } as const;
  switch (node.type) {
    case 'frame':
    case 'component':
      return (
        <div {...common} data-type={node.type}>
          {(node as FrameNode).children.map((c) => (
            <NodeView key={c} id={c} />
          ))}
        </div>
      );
    case 'text':
      if (editing) return <TextEditor node={node as TextNode} style={style} />;
      return <div {...common}>{(node as TextNode).text || '​'}</div>;
    case 'image':
      return <ImageView node={node as ImageNode} style={style} />;
    case 'svg':
      return <div {...common} dangerouslySetInnerHTML={{ __html: cachedSvg((node as SvgNode).svg || '') }} />;
    default:
      return <div {...common} />;
  }
});

function ImageView({ node, style }: { node: ImageNode; style: CSSProperties }) {
  if (!node.src) {
    return (
      <div data-node-id={node.id} style={{ ...style, background: '#E5E7EB', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9CA3AF', fontSize: 12, fontFamily: 'system-ui' }}>
        Image
      </div>
    );
  }
  return (
    <img
      data-node-id={node.id}
      src={node.src}
      alt={node.alt ?? node.name}
      draggable={false}
      style={style}
      onLoad={() => setState((s) => ({ layoutTick: s.layoutTick + 1 }))}
    />
  );
}

/** Instances render a virtual copy of their main component. */
function InstanceView({ id, parent }: { id: string; parent: ParentInfo | null }) {
  const nodes = useEditor((s) => s.doc?.nodes);
  const tree = useMemo(() => {
    const doc = getState().doc;
    return doc ? buildRenderTree(doc, id) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, id]);
  if (!tree) return null;
  return <StaticNode rn={tree} parent={parent} root />;
}

function StaticNode({ rn, parent, root }: { rn: RenderNode; parent: ParentInfo | null; root?: boolean }) {
  const node = rn.node;
  const style = toReactStyle(nodeStyle(node, { parent: parent as any, editor: true }));
  const attrs: Record<string, string> = root ? { 'data-node-id': rn.sourceId, 'data-type': 'instance' } : { 'data-instance-child': rn.componentNodeId ?? '' };
  const me: ParentInfo = { type: node.type, layout: (node as FrameNode).layout };
  switch (node.type) {
    case 'frame':
    case 'component':
      return (
        <div {...attrs} style={style}>
          {rn.children.map((c) => (
            <StaticNode key={c.node.id} rn={c} parent={me} />
          ))}
        </div>
      );
    case 'text':
      return (
        <div {...attrs} style={style}>
          {(node as TextNode).text || '​'}
        </div>
      );
    case 'image':
      return (node as ImageNode).src ? <img {...attrs} src={(node as ImageNode).src} alt="" draggable={false} style={style} /> : <div {...attrs} style={{ ...style, background: '#E5E7EB' }} />;
    case 'svg':
      return <div {...attrs} style={style} dangerouslySetInnerHTML={{ __html: cachedSvg((node as SvgNode).svg || '') }} />;
    default:
      return <div {...attrs} style={style} />;
  }
}

/** In-place text editing with contentEditable (plain text). */
function TextEditor({ node, style }: { node: TextNode; style: CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  const initial = useRef(node.text);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerText = initial.current;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, []);
  useEffect(() => {
    const el = ref.current;
    return () => {
      // Commit on unmount (blur / escape / selection change).
      if (!el) return;
      const text = el.innerText.replace(/\n$/, '');
      if (text !== node.text) {
        commit((d) => {
          const n = d.nodes[node.id] as TextNode | undefined;
          if (n) {
            n.text = text;
            if (n.name === initial.current.slice(0, 40) || n.name === 'Text') n.name = text.slice(0, 40) || 'Text';
          }
        });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div
      ref={ref}
      data-node-id={node.id}
      data-editing="true"
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck={false}
      style={{ ...style, outline: 'none', cursor: 'text', minWidth: 2, userSelect: 'text' }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          setState({ editingTextId: null });
        }
      }}
      onInput={() => setState((s) => ({ layoutTick: s.layoutTick + 1 }))}
      onBlur={() => {
        if (getState().editingTextId === node.id) setState({ editingTextId: null });
      }}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}
