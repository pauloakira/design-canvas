import type { CSSProperties } from 'react';
import type { FrameNode, ImageNode, SvgNode, TextNode } from '../../shared/types.ts';
import { nodeStyle } from '../../shared/style.ts';
import type { RenderNode } from '../../shared/tree.ts';
import { sanitizeSvg } from './NodeView.tsx';

/** Static, id-less rendering of a render tree (thumbnails). */
export function PreviewNode({ rn, parent, root }: { rn: RenderNode; parent: { type: string; layout?: FrameNode['layout'] } | null; root?: boolean }) {
  const node = rn.node;
  const style = nodeStyle(node, { parent: parent as any, isRoot: root }) as CSSProperties;
  const me = { type: node.type, layout: (node as FrameNode).layout };
  switch (node.type) {
    case 'frame':
    case 'component':
      return (
        <div style={style}>
          {rn.children.map((c) => (
            <PreviewNode key={c.node.id} rn={c} parent={me} />
          ))}
        </div>
      );
    case 'text':
      return <div style={style}>{(node as TextNode).text}</div>;
    case 'image':
      return (node as ImageNode).src ? <img src={(node as ImageNode).src} alt="" style={style} draggable={false} /> : <div style={{ ...style, background: '#E5E7EB' }} />;
    case 'svg':
      return <div style={style} dangerouslySetInnerHTML={{ __html: sanitizeSvg((node as SvgNode).svg || '') }} />;
    default:
      return <div style={style} />;
  }
}
