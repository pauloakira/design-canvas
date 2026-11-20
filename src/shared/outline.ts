/** Compact, token-efficient representations of a document for LLMs. */
import type { DesignDoc, FrameNode, InstanceNode, Paint, SceneNode, TextNode } from './types.ts';
import { childIds, isFrameLike } from './doc.ts';
import { sizeMode } from './style.ts';

function paintStr(p: Paint): string {
  if (p.type === 'solid') return p.color;
  if (p.type === 'gradient') return `gradient(${p.stops.map((s) => s.color).join('→')})`;
  return `image`;
}

export function nodeSummary(doc: DesignDoc, n: SceneNode): string {
  const parts: string[] = [`${n.type} "${n.name}" #${n.id}`];
  const wm = sizeMode(n, 'w');
  const hm = sizeMode(n, 'h');
  const w = wm === 'fixed' ? `${Math.round(n.width)}` : `${wm}(${Math.round(n.width)})`;
  const h = hm === 'fixed' ? `${Math.round(n.height)}` : `${hm}(${Math.round(n.height)})`;
  const parent = doc.nodes[n.parentId];
  const inFlow = isFrameLike(parent) && parent.layout && parent.layout.mode !== 'none' && n.position !== 'absolute';
  parts.push(inFlow ? `[${w}×${h}]` : `[x${Math.round(n.x)} y${Math.round(n.y)} ${w}×${h}]`);
  if (isFrameLike(n) && n.layout && n.layout.mode !== 'none') {
    const l = n.layout;
    const pad = l.padding ? ` pad=${l.padding.join(',')}` : '';
    parts.push(`layout=${l.mode}${l.gap !== undefined ? ` gap=${l.gap}` : ''}${pad}${l.justify ? ` justify=${l.justify}` : ''}${l.align ? ` align=${l.align}` : ''}${l.wrap ? ' wrap' : ''}`);
  }
  const fills = (n.fills ?? []).filter((f) => f.visible !== false);
  if (fills.length && n.type !== 'text') parts.push(`fill=${fills.map(paintStr).join('+')}`);
  if (n.stroke) parts.push(`stroke=${n.stroke.width}px ${n.stroke.color}`);
  if (n.radius) parts.push(`radius=${Array.isArray(n.radius) ? n.radius.join(',') : n.radius}`);
  if (n.shadows?.length) parts.push(`shadow×${n.shadows.length}`);
  if (n.opacity !== undefined && n.opacity < 1) parts.push(`opacity=${n.opacity}`);
  if (n.visible === false) parts.push('hidden');
  if (n.position === 'absolute') parts.push('absolute');
  if (n.type === 'text') {
    const t = n as TextNode;
    const color = fills.length ? paintStr(fills[0]) : '#000000';
    const text = t.text.length > 80 ? t.text.slice(0, 77) + '…' : t.text;
    parts.push(`${JSON.stringify(text)} ${t.fontFamily ?? 'Inter'} ${t.fontSize ?? 16}/${t.fontWeight ?? 400} ${color}`);
  }
  if (n.type === 'instance') {
    const c = doc.nodes[(n as InstanceNode).componentId];
    parts.push(`of component "${c?.name ?? '?'}" #${(n as InstanceNode).componentId}`);
  }
  if (n.type === 'component' && (n as FrameNode).codeConnect) parts.push(`codeConnect=${(n as FrameNode).codeConnect!.name}`);
  if (n.type === 'image') parts.push(`src=${(n as any).src?.slice(0, 60)}`);
  return parts.join(' ');
}

export function outline(doc: DesignDoc, rootIds: string[], maxDepth = 6, maxLines = 400): string {
  const lines: string[] = [];
  const walk = (id: string, depth: number) => {
    if (lines.length >= maxLines) return;
    const n = doc.nodes[id];
    if (!n) return;
    lines.push(`${'  '.repeat(depth)}- ${nodeSummary(doc, n)}`);
    if (isFrameLike(n)) {
      if (depth + 1 > maxDepth && n.children.length) {
        lines.push(`${'  '.repeat(depth + 1)}- … ${n.children.length} children (increase depth)`);
        return;
      }
      for (const c of n.children) walk(c, depth + 1);
    }
  };
  for (const id of rootIds) walk(id, 0);
  if (lines.length >= maxLines) lines.push(`… truncated at ${maxLines} lines`);
  return lines.join('\n');
}

export function pageOutline(doc: DesignDoc, pageId: string, maxDepth = 4): string {
  const p = doc.pages[pageId];
  if (!p) return '';
  return `Page "${p.name}" #${p.id}\n${outline(doc, childIds(doc, pageId), maxDepth) || '  (empty)'}`;
}

/** Node JSON with its subtree nested (for get_node). */
export function nodeTree(doc: DesignDoc, id: string, depth = 99): any {
  const n = doc.nodes[id];
  if (!n) return null;
  const { parentId, ...rest } = n as any;
  const out: any = { ...rest };
  if (isFrameLike(n)) {
    if (depth <= 0) out.children = `${n.children.length} children (not expanded)`;
    else out.children = n.children.map((c) => nodeTree(doc, c, depth - 1)).filter(Boolean);
  }
  return out;
}
