/**
 * High-level document operations. All functions mutate a draft document
 * (use with immer `produce`) and are shared by the editor and the AI tools.
 */
import type { DesignDoc, FrameNode, InstanceNode, SceneNode, Variable, VariableType } from './types.ts';
import {
  attachToParent,
  cloneSubtree,
  DEFAULT_NAMES,
  deleteNode,
  descendants,
  detachFromParent,
  isAncestor,
  isAutoLayout,
  isFrameLike,
  isPageId,
  pageContentBounds,
  parentChildren,
  topLevelOnly,
  uid,
} from './doc.ts';
import { defaultsFor, normalizeProps, normalizeType, type NodeSpec } from './normalize.ts';

export interface CreateResult {
  ids: string[];
  /** All created ids, depth-first, with their names (useful for LLMs). */
  created: Array<{ id: string; name: string; type: string }>;
  warnings: string[];
}

/** Absolute position of a node in page coordinates (approximate for auto-layout children). */
export function absolutePosition(doc: DesignDoc, id: string): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let cur: SceneNode | undefined = doc.nodes[id];
  let guard = 0;
  while (cur && guard++ < 1000) {
    x += cur.x;
    y += cur.y;
    cur = doc.nodes[cur.parentId];
  }
  return { x, y };
}

export function createNodes(
  doc: DesignDoc,
  specs: NodeSpec[],
  parentId: string,
  index?: number,
  opts: { autoPlace?: boolean } = {},
): CreateResult {
  const result: CreateResult = { ids: [], created: [], warnings: [] };
  if (doc.pages[parentId]?.kind === 'section') throw new Error(`"${doc.pages[parentId].name}" is a page section, which can't hold layers. Use a page id.`);
  if (!isPageId(doc, parentId) && !isFrameLike(doc.nodes[parentId])) {
    throw new Error(`Parent "${parentId}" is not a page, frame or component.`);
  }
  let placeX: number | null = null;
  if (opts.autoPlace && isPageId(doc, parentId)) {
    const b = pageContentBounds(doc, parentId);
    placeX = b ? Math.round(b.maxX + 120) : 0;
  }
  let i = 0;
  for (const spec of specs) {
    const topLevel = isPageId(doc, parentId);
    const s = { ...spec };
    if (placeX !== null && s.x === undefined) {
      s.x = placeX;
      s.y = s.y ?? 0;
    }
    const id = createOne(doc, s, parentId, index === undefined ? undefined : index + i, result, topLevel);
    if (id) {
      result.ids.push(id);
      if (placeX !== null && spec.x === undefined) placeX += (doc.nodes[id].width || 100) + 120;
    }
    i++;
  }
  return result;
}

function createOne(doc: DesignDoc, spec: NodeSpec, parentId: string, index: number | undefined, result: CreateResult, topLevel: boolean): string | null {
  let type = normalizeType(spec.type);
  if (!type) {
    if (spec.text !== undefined || spec.content !== undefined) type = 'text';
    else if (spec.children) type = 'frame';
    else if (spec.svg) type = 'svg';
    else if (spec.src) type = 'image';
    else if (spec.componentId || spec.component) type = 'instance';
    else {
      result.warnings.push(`Unknown node type ${JSON.stringify(spec.type)}; created a frame.`);
      type = 'frame';
    }
  }
  if (type === 'instance') {
    const cid = resolveComponentId(doc, spec.componentId ?? spec.component);
    if (!cid) {
      result.warnings.push(`Component ${JSON.stringify(spec.componentId ?? spec.component)} not found; skipped instance.`);
      return null;
    }
    const id = createInstance(doc, cid, parentId, { x: spec.x, y: spec.y, index });
    const props = normalizeProps({ ...spec, type: 'instance' }, doc.nodes[id], result.warnings);
    delete (props as any).componentId;
    Object.assign(doc.nodes[id], props);
    result.created.push({ id, name: doc.nodes[id].name, type });
    return id;
  }
  const props = normalizeProps({ ...spec, type }, undefined, result.warnings);
  const id = typeof spec.id === 'string' && spec.id && !doc.nodes[spec.id] && /^[\w:-]{3,64}$/.test(spec.id) ? spec.id : uid();
  const node: any = {
    id,
    type,
    name: props.name ?? spec.name ?? (type === 'text' ? String(props.text ?? 'Text').slice(0, 40) : DEFAULT_NAMES[type]),
    parentId,
    x: 0,
    y: 0,
    ...defaultsFor(type, topLevel),
    ...props,
  };
  if ((type === 'frame' || type === 'component') && node.layout && node.layout.mode !== 'none') {
    // Auto-layout frames hug their content unless sized explicitly.
    if (spec.width === undefined && spec.widthMode === undefined) node.widthMode = 'hug';
    if (spec.height === undefined && spec.heightMode === undefined) node.heightMode = 'hug';
  }
  if (type === 'frame' || type === 'component') node.children = [];
  if (node.fills && !node.fills.length) delete node.fills;
  doc.nodes[id] = node as SceneNode;
  attachToParent(doc, id, parentId, index);
  result.created.push({ id, name: node.name, type });
  if ((type === 'frame' || type === 'component') && Array.isArray(spec.children)) {
    for (const child of spec.children) createOne(doc, child, id, undefined, result, false);
  } else if (spec.children?.length) {
    result.warnings.push(`Node "${node.name}" (${type}) cannot have children; ignored them.`);
  }
  return id;
}

export function resolveComponentId(doc: DesignDoc, ref: unknown): string | null {
  if (typeof ref !== 'string') return null;
  const n = doc.nodes[ref];
  if (n && n.type === 'component') return n.id;
  const byName = Object.values(doc.nodes).find((x) => x.type === 'component' && x.name.toLowerCase() === ref.toLowerCase());
  return byName?.id ?? null;
}

export function updateNode(doc: DesignDoc, id: string, input: Record<string, any>, warnings: string[] = []): void {
  const n = doc.nodes[id];
  if (!n) throw new Error(`Node "${id}" not found`);
  // Type change (e.g. rect → ellipse, frame ↔ component) when compatible.
  const newType = input.type ? normalizeType(input.type) : null;
  if (newType && newType !== n.type) {
    const frames = ['frame', 'component'];
    const shapes = ['rect', 'ellipse'];
    if ((frames.includes(newType) && frames.includes(n.type)) || (shapes.includes(newType) && shapes.includes(n.type))) {
      (n as any).type = newType;
    } else warnings.push(`Cannot change type of "${n.name}" from ${n.type} to ${newType}.`);
  }
  const props = normalizeProps({ ...input, type: n.type }, n, warnings);
  for (const k of ['id', 'parentId', 'children', 'type'] as const) delete (props as any)[k];
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) delete (n as any)[k];
    else (n as any)[k] = v;
  }
  if ((n.type === 'frame' || n.type === 'component') && input.layout && (n as FrameNode).layout?.mode !== 'none') {
    if (input.width === undefined && input.widthMode === undefined && (n.widthMode ?? 'fixed') === 'fixed' && !n.width) n.widthMode = 'hug';
  }
}

export function moveNodes(doc: DesignDoc, ids: string[], parentId: string, index?: number, pos?: { x?: number; y?: number }) {
  if (doc.pages[parentId]?.kind === 'section') throw new Error(`"${doc.pages[parentId].name}" is a page section, which can't hold layers. Use a page id.`);
  if (!isPageId(doc, parentId) && !isFrameLike(doc.nodes[parentId])) throw new Error(`Target "${parentId}" cannot contain children`);
  const list = topLevelOnly(doc, ids.filter((id) => doc.nodes[id]));
  let i = 0;
  for (const id of list) {
    if (id === parentId || isAncestor(doc, id, parentId)) throw new Error(`Cannot move "${id}" into itself`);
    const n = doc.nodes[id];
    const oldParent = n.parentId;
    // Preserve visual position when changing parents.
    if (oldParent !== parentId && pos?.x === undefined && pos?.y === undefined) {
      const abs = absolutePosition(doc, id);
      const pAbs = isPageId(doc, parentId) ? { x: 0, y: 0 } : absolutePosition(doc, parentId);
      n.x = abs.x - pAbs.x;
      n.y = abs.y - pAbs.y;
    }
    detachFromParent(doc, id);
    const target = parentChildren(doc, parentId)!;
    let idx = index === undefined ? undefined : index + i;
    if (idx !== undefined && idx > target.length) idx = target.length;
    attachToParent(doc, id, parentId, idx);
    if (pos?.x !== undefined) n.x = pos.x;
    if (pos?.y !== undefined) n.y = pos.y;
    if (n.position === 'absolute' && !isAutoLayout(doc.nodes[parentId])) delete n.position;
    if (isPageId(doc, parentId) && n.widthMode === 'fill') n.widthMode = 'fixed';
    if (isPageId(doc, parentId) && n.heightMode === 'fill') n.heightMode = 'fixed';
    i++;
  }
}

export function duplicateNodes(doc: DesignDoc, ids: string[], offset = { x: 20, y: 20 }): string[] {
  const out: string[] = [];
  for (const id of topLevelOnly(doc, ids)) {
    const n = doc.nodes[id];
    if (!n) continue;
    const { rootId, nodes } = cloneSubtree(doc, id);
    Object.assign(doc.nodes, nodes);
    const root = doc.nodes[rootId];
    root.parentId = n.parentId;
    const list = parentChildren(doc, n.parentId)!;
    const inFlow = isAutoLayout(doc.nodes[n.parentId]) && n.position !== 'absolute';
    if (!inFlow) {
      root.x = n.x + offset.x;
      root.y = n.y + offset.y;
    }
    list.splice(list.indexOf(id) + 1, 0, rootId);
    out.push(rootId);
  }
  return out;
}

/** Wrap nodes in a new frame (Figma: Group / Frame selection). */
export function wrapInFrame(
  doc: DesignDoc,
  ids: string[],
  opts: { name?: string; layout?: FrameNode['layout']; rects?: Record<string, { x: number; y: number; width: number; height: number }> } = {},
): string | null {
  const list = topLevelOnly(doc, ids).filter((id) => doc.nodes[id]);
  if (!list.length) return null;
  const parentId = doc.nodes[list[0]].parentId;
  const siblings = list.filter((id) => doc.nodes[id].parentId === parentId);
  const container = parentChildren(doc, parentId)!;
  const ordered = [...siblings].sort((a, b) => container.indexOf(a) - container.indexOf(b));
  const rect = (id: string) => opts.rects?.[id] ?? doc.nodes[id];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of ordered) {
    const r = rect(id);
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  const insertAt = Math.min(...ordered.map((id) => container.indexOf(id)));
  const parentInFlow = isAutoLayout(doc.nodes[parentId]);
  const fid = uid();
  const frame: FrameNode = {
    id: fid,
    type: 'frame',
    name: opts.name ?? 'Group',
    parentId,
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
    children: [],
    ...(opts.layout ? { layout: opts.layout, widthMode: 'hug', heightMode: 'hug' } : {}),
  };
  doc.nodes[fid] = frame;
  for (const id of ordered) detachFromParent(doc, id);
  container.splice(insertAt, 0, fid);
  for (const id of ordered) {
    const n = doc.nodes[id];
    const r = rect(id);
    n.x = r.x - minX;
    n.y = r.y - minY;
    if (parentInFlow) {
      n.width = r.width;
      n.height = r.height;
    }
    n.parentId = fid;
    frame.children.push(id);
  }
  if (opts.layout && opts.layout.mode !== 'none') {
    // Sort children visually for auto layout.
    const axis = opts.layout.mode === 'row' ? 'x' : 'y';
    frame.children.sort((a, b) => doc.nodes[a][axis] - doc.nodes[b][axis]);
    if (ordered.length > 1) {
      const sorted = frame.children.map((c) => doc.nodes[c]);
      let gapSum = 0;
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        gapSum += sorted[i][axis] - (prev[axis] + (axis === 'x' ? prev.width : prev.height));
      }
      frame.layout = { ...opts.layout, gap: Math.max(0, Math.round(gapSum / (sorted.length - 1))) };
    }
  }
  return fid;
}

/** Remove a frame, moving its children to its parent (Figma: Ungroup). */
export function unwrapFrame(doc: DesignDoc, id: string): string[] {
  const f = doc.nodes[id];
  if (!isFrameLike(f)) return [];
  const parentId = f.parentId;
  const list = parentChildren(doc, parentId)!;
  const at = list.indexOf(id);
  const kids = [...f.children];
  const parentAuto = isAutoLayout(doc.nodes[parentId]);
  for (const k of kids) {
    const n = doc.nodes[k];
    n.x += f.x;
    n.y += f.y;
    n.parentId = parentId;
  }
  list.splice(at, 1, ...kids);
  f.children = [];
  delete doc.nodes[id];
  if (parentAuto) for (const k of kids) delete doc.nodes[k].position;
  return kids;
}

export function createComponent(doc: DesignDoc, id: string): string {
  const n = doc.nodes[id];
  if (!n) throw new Error(`Node "${id}" not found`);
  if (n.type === 'component') return id;
  if (n.type === 'frame') {
    (n as any).type = 'component';
    return id;
  }
  if (n.type === 'instance') throw new Error('Detach the instance before turning it into a component');
  // Wrap non-frame nodes in a component.
  const fid = wrapInFrame(doc, [id], { name: n.name })!;
  (doc.nodes[fid] as any).type = 'component';
  return fid;
}

export function createInstance(doc: DesignDoc, componentId: string, parentId: string, opts: { x?: number; y?: number; index?: number } = {}): string {
  const comp = doc.nodes[componentId];
  if (!comp || comp.type !== 'component') throw new Error(`"${componentId}" is not a component`);
  if (isAncestor(doc, componentId, parentId) || parentId === componentId) throw new Error('Cannot place an instance inside its own component');
  const id = uid();
  const inst: InstanceNode = {
    id,
    type: 'instance',
    name: comp.name,
    parentId,
    componentId,
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    width: comp.width,
    height: comp.height,
    ...(comp.widthMode ? { widthMode: comp.widthMode } : {}),
    ...(comp.heightMode ? { heightMode: comp.heightMode } : {}),
  };
  doc.nodes[id] = inst;
  attachToParent(doc, id, parentId, opts.index);
  return id;
}

/** Convert an instance to a regular frame with a real copy of the component tree. */
export function detachInstance(doc: DesignDoc, id: string): string | null {
  const inst = doc.nodes[id];
  if (!inst || inst.type !== 'instance') return null;
  const comp = doc.nodes[inst.componentId];
  if (!comp || comp.type !== 'component') return null;
  const { rootId, nodes } = cloneSubtree(doc, comp.id);
  const root = nodes[rootId] as FrameNode;
  // Map component-node ids → new ids to re-apply overrides.
  const compDesc = descendants(doc, comp.id, true);
  const newDesc = (() => {
    const out: string[] = [];
    const walk = (nid: string) => {
      out.push(nid);
      const nn = nodes[nid];
      if (isFrameLike(nn)) nn.children.forEach(walk);
    };
    walk(rootId);
    return out;
  })();
  const mapping = new Map(compDesc.map((c, i) => [c, newDesc[i]]));
  for (const [key, o] of Object.entries(inst.overrides ?? {})) {
    const target = mapping.get(key.split(':')[0]);
    if (!target || !nodes[target] || key.includes(':')) continue;
    const t: any = nodes[target];
    if (o.text !== undefined && t.type === 'text') t.text = o.text;
    if (o.visible !== undefined) t.visible = o.visible;
    if (o.fills !== undefined) t.fills = o.fills;
    if (o.src !== undefined && t.type === 'image') t.src = o.src;
  }
  Object.assign(doc.nodes, nodes);
  const frame: any = {
    ...root,
    type: 'frame',
    id,
    name: inst.name,
    parentId: inst.parentId,
    x: inst.x,
    y: inst.y,
    width: inst.width,
    height: inst.height,
    widthMode: inst.widthMode,
    heightMode: inst.heightMode,
    position: inst.position,
    rotation: inst.rotation,
    opacity: inst.opacity,
    visible: inst.visible,
  };
  delete frame.codeConnect;
  for (const k of Object.keys(frame)) if (frame[k] === undefined) delete frame[k];
  for (const c of root.children) doc.nodes[c].parentId = id;
  delete doc.nodes[rootId];
  doc.nodes[id] = frame;
  return id;
}

export const VAR_NAME_RE = /^[a-zA-Z_][\w-]*$/;

export function sanitizeVarName(name: string): string {
  let n = name.trim().replace(/^\$|^--/, '').replace(/[\s/.]+/g, '-').replace(/[^\w-]/g, '');
  if (!/^[a-zA-Z_]/.test(n)) n = 'v-' + n;
  return n;
}

export function upsertVariable(doc: DesignDoc, input: { name: string; type?: VariableType; value: string | number; group?: string; description?: string }): Variable {
  const name = sanitizeVarName(input.name);
  const existing = Object.values(doc.variables).find((v) => v.name === name);
  const type: VariableType =
    input.type ?? existing?.type ?? (typeof input.value === 'number' ? 'number' : /^(#|rgb|hsl|oklch|color\()/i.test(String(input.value)) ? 'color' : 'string');
  let value: string | number = input.value;
  if (type === 'number' && typeof value === 'string') {
    const n = parseFloat(value);
    if (!isNaN(n) && /^-?\d+(\.\d+)?(px)?$/.test(value.trim())) value = n;
  }
  const v: Variable = {
    id: existing?.id ?? 'v_' + uid(8),
    name,
    type,
    value,
    ...(input.group ?? existing?.group ? { group: input.group ?? existing?.group } : {}),
    ...(input.description ?? existing?.description ? { description: input.description ?? existing?.description } : {}),
  };
  doc.variables[v.id] = v;
  return v;
}

export function deleteVariable(doc: DesignDoc, nameOrId: string) {
  const name = nameOrId.replace(/^\$/, '');
  for (const v of Object.values(doc.variables)) if (v.id === nameOrId || v.name === name) delete doc.variables[v.id];
}

export function deleteNodes(doc: DesignDoc, ids: string[]) {
  for (const id of topLevelOnly(doc, ids)) deleteNode(doc, id);
}

export function addPage(doc: DesignDoc, name?: string, opts: { section?: boolean; after?: string } = {}): string {
  const id = 'p_' + uid(8);
  const pages = doc.pageOrder.filter((p) => doc.pages[p]?.kind !== 'section').length;
  doc.pages[id] = opts.section
    ? { id, name: name?.trim() || 'Section', children: [], kind: 'section' }
    : { id, name: name ?? `Page ${pages + 1}`, children: [] };
  const at = opts.after ? doc.pageOrder.indexOf(opts.after) : -1;
  if (at >= 0) doc.pageOrder.splice(at + 1, 0, id);
  else doc.pageOrder.push(id);
  return id;
}

export function addSection(doc: DesignDoc, name?: string, opts: { after?: string } = {}): string {
  return addPage(doc, name, { ...opts, section: true });
}

/** A section id plus the pages it groups (up to the next section). Pages alone are just [id]. */
export function sectionBlock(doc: DesignDoc, id: string): string[] {
  if (doc.pages[id]?.kind !== 'section') return [id];
  const i = doc.pageOrder.indexOf(id);
  const out = [id];
  for (let j = i + 1; j < doc.pageOrder.length && doc.pages[doc.pageOrder[j]]?.kind !== 'section'; j++) out.push(doc.pageOrder[j]);
  return out;
}

/**
 * Reorders the page list. `ids` move together, in their current order, to just before
 * `beforeId` (or to the end when it is null). A section moves with the pages it groups.
 */
export function movePages(doc: DesignDoc, ids: string[], beforeId: string | null) {
  const moving = new Set(ids.filter((id) => doc.pages[id]).flatMap((id) => sectionBlock(doc, id)));
  if (!moving.size || (beforeId && moving.has(beforeId))) return;
  const block = doc.pageOrder.filter((p) => moving.has(p));
  const rest = doc.pageOrder.filter((p) => !moving.has(p));
  const at = beforeId ? rest.indexOf(beforeId) : rest.length;
  if (at < 0) throw new Error(`Page "${beforeId}" not found`);
  rest.splice(at, 0, ...block);
  doc.pageOrder = rest;
}

export function deletePage(doc: DesignDoc, pageId: string) {
  const page = doc.pages[pageId];
  if (!page) throw new Error(`Page "${pageId}" not found`);
  if (page.kind === 'section') {
    // Removing a section keeps its pages; they join the section above.
    delete doc.pages[pageId];
    doc.pageOrder = doc.pageOrder.filter((p) => p !== pageId);
    return;
  }
  if (doc.pageOrder.filter((p) => doc.pages[p]?.kind !== 'section').length <= 1) throw new Error('A document needs at least one page');
  for (const id of [...(doc.pages[pageId]?.children ?? [])]) deleteNode(doc, id);
  delete doc.pages[pageId];
  doc.pageOrder = doc.pageOrder.filter((p) => p !== pageId);
  for (const t of Object.values(doc.comments ?? {})) if (t.pageId === pageId) delete doc.comments[t.id];
}
