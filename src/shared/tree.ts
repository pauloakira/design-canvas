import type { DesignDoc, FrameNode, InstanceNode, NodeOverride, SceneNode } from './types.ts';
import { isFrameLike } from './doc.ts';

/**
 * A resolved node ready for rendering or code generation. Instances are
 * expanded into a virtual copy of their main component with overrides applied.
 */
export interface RenderNode {
  /** Effective node (for instances: merged with the component root). */
  node: SceneNode;
  children: RenderNode[];
  /** Real document id of the node (for virtual nodes: the outermost instance id). */
  sourceId: string;
  /** Id of the node inside the main component (only for virtual nodes). */
  componentNodeId?: string;
  /** Set on instance roots. */
  instanceOf?: FrameNode;
  /** True for nodes that live inside an instance (not directly editable). */
  virtual?: boolean;
}

const INSTANCE_BOX_KEYS = [
  'id',
  'name',
  'parentId',
  'x',
  'y',
  'width',
  'height',
  'widthMode',
  'heightMode',
  'minWidth',
  'maxWidth',
  'minHeight',
  'maxHeight',
  'position',
  'rotation',
  'visible',
  'locked',
  'opacity',
] as const;

export function applyOverride<T extends SceneNode>(node: T, o: NodeOverride | undefined): T {
  if (!o) return node;
  const out: any = { ...node };
  if (o.text !== undefined && out.type === 'text') out.text = o.text;
  if (o.visible !== undefined) out.visible = o.visible;
  if (o.fills !== undefined) out.fills = o.fills;
  if (o.src !== undefined && out.type === 'image') out.src = o.src;
  return out;
}

/** The instance's effective root node (component visuals + instance box). */
export function instanceRoot(doc: DesignDoc, inst: InstanceNode): FrameNode | null {
  const comp = doc.nodes[inst.componentId];
  if (!comp || comp.type !== 'component') return null;
  const root: any = { ...comp, type: 'frame' };
  for (const k of INSTANCE_BOX_KEYS) {
    if ((inst as any)[k] !== undefined) root[k] = (inst as any)[k];
    else if (k === 'visible' || k === 'opacity' || k === 'rotation' || k === 'position') delete root[k];
  }
  // Instance-level visual props override the component root when set.
  if (inst.fills) root.fills = inst.fills;
  if (inst.stroke) root.stroke = inst.stroke;
  if (inst.radius !== undefined) root.radius = inst.radius;
  if (inst.shadows) root.shadows = inst.shadows;
  const o = inst.overrides?.[comp.id];
  return applyOverride(root as FrameNode, o);
}

export function buildRenderTree(doc: DesignDoc, id: string, depthGuard = 0): RenderNode | null {
  const node = doc.nodes[id];
  if (!node || depthGuard > 64) return null;
  if (node.type === 'instance') return expandInstance(doc, node, depthGuard);
  const rn: RenderNode = { node, children: [], sourceId: id };
  if (isFrameLike(node)) {
    for (const c of node.children) {
      const child = buildRenderTree(doc, c, depthGuard + 1);
      if (child) rn.children.push(child);
    }
  }
  return rn;
}

function expandInstance(doc: DesignDoc, inst: InstanceNode, depthGuard: number): RenderNode {
  const root = instanceRoot(doc, inst);
  if (!root) {
    // Missing component: render as an empty placeholder box.
    const placeholder: FrameNode = {
      ...(inst as any),
      type: 'frame',
      children: [],
      fills: [{ type: 'solid', color: '#f3f4f6' }],
      stroke: { color: '#ef4444', width: 1, style: 'dashed' },
    };
    return { node: placeholder, children: [], sourceId: inst.id };
  }
  const comp = doc.nodes[inst.componentId] as FrameNode;
  const visiting = new Set<string>([comp.id]);
  const rn: RenderNode = { node: root, children: [], sourceId: inst.id, instanceOf: comp };
  const walk = (parentComp: FrameNode, prefix: string, out: RenderNode[], overrides: Record<string, NodeOverride> | undefined, keyPrefix: string, depth: number) => {
    for (const cid of parentComp.children) {
      const src = doc.nodes[cid];
      if (!src) continue;
      const vid = `${prefix}:${cid}`;
      const okey = keyPrefix ? `${keyPrefix}:${cid}` : cid;
      if (src.type === 'instance') {
        const nestedComp = doc.nodes[src.componentId];
        if (!nestedComp || nestedComp.type !== 'component' || visiting.has(nestedComp.id) || depth > 32) continue;
        const nestedRoot = instanceRoot(doc, src);
        if (!nestedRoot) continue;
        const merged = applyOverride({ ...nestedRoot, id: vid, parentId: prefix } as FrameNode, overrides?.[okey]);
        const child: RenderNode = { node: merged, children: [], sourceId: inst.id, componentNodeId: okey, virtual: true, instanceOf: nestedComp as FrameNode };
        visiting.add(nestedComp.id);
        // Nested overrides: the inner instance's own overrides + outer overrides keyed by path.
        const nestedOverrides: Record<string, NodeOverride> = { ...(src.overrides ?? {}) };
        for (const k in overrides ?? {}) if (k.startsWith(okey + ':')) nestedOverrides[k.slice(okey.length + 1)] = { ...nestedOverrides[k.slice(okey.length + 1)], ...overrides![k] };
        walk(nestedComp as FrameNode, vid, child.children, nestedOverrides, '', depth + 1);
        visiting.delete(nestedComp.id);
        // Re-key nested children override keys relative to the outer instance.
        reKey(child.children, okey);
        out.push(child);
        continue;
      }
      const eff = applyOverride({ ...src, id: vid, parentId: prefix } as SceneNode, overrides?.[okey]);
      const child: RenderNode = { node: eff, children: [], sourceId: inst.id, componentNodeId: okey, virtual: true };
      if (isFrameLike(src)) walk(src, vid, child.children, overrides, okey, depth + 1);
      out.push(child);
    }
  };
  walk(comp, inst.id, rn.children, inst.overrides, '', depthGuard);
  return rn;
}

function reKey(nodes: RenderNode[], prefix: string) {
  for (const n of nodes) {
    if (n.componentNodeId && !n.componentNodeId.startsWith(prefix + ':')) n.componentNodeId = `${prefix}:${n.componentNodeId}`;
    reKey(n.children, prefix);
  }
}

/** All overridable layers inside an instance (for the properties panel / LLMs). */
export function instanceLayers(doc: DesignDoc, inst: InstanceNode): Array<{ key: string; node: SceneNode; depth: number }> {
  const tree = buildRenderTree(doc, inst.id);
  const out: Array<{ key: string; node: SceneNode; depth: number }> = [];
  const walk = (ns: RenderNode[], depth: number) => {
    for (const n of ns) {
      if (n.componentNodeId) out.push({ key: n.componentNodeId, node: n.node, depth });
      walk(n.children, depth + 1);
    }
  };
  if (tree) walk(tree.children, 0);
  return out;
}
