/**
 * Figma → Design Canvas import.
 *
 * The Design Canvas Figma plugin serializes the Figma selection into the same
 * `FigmaSpec` shape the export uses (src/shared/figma.ts), so the mapping is a
 * mirror image of the export: auto layout → flexbox frames, main components →
 * components, instances → linked instances with overrides, bound variables →
 * `$tokens`, vectors → SVG, image fills → uploaded assets.
 *
 * Identity: a layer that came from Design Canvas carries its original key
 * (`<docId>/<nodeId>`) and is updated in place; anything else gets a new id,
 * and the plugin tags the Figma layer with it — so later round trips in either
 * direction update the same layers instead of duplicating them.
 */
import type { DesignDoc, FrameNode, NodeOverride, Paint, SceneNode, Shadow, Stroke } from './types.ts';
import { attachToParent, deleteNode, isFrameLike, uid } from './doc.ts';
import { sanitizeVarName, upsertVariable } from './ops.ts';
import type { FEffect, FigmaSpec, FPaint, RGBA, Sizing } from './figma.ts';

export const FIGMA_IMPORT_FORMAT = 'design-canvas/figma-import@1';

export interface FImportVariable {
  /** Token name to use (`primary`), from the variable's WEB code syntax when it has one. */
  token: string;
  /** Group path (`color`) from the Figma variable name. */
  group?: string;
  type: 'COLOR' | 'FLOAT' | 'STRING' | 'BOOLEAN';
  value: RGBA | number | string | boolean;
  description?: string;
}

export interface FigmaImportPayload {
  format: typeof FIGMA_IMPORT_FORMAT;
  fileName: string;
  variables: FImportVariable[];
  /** Main components used by instances in `roots` (and not inside them), by key. */
  components: Record<string, FigmaSpec>;
  roots: FigmaSpec[];
  warnings: string[];
}

export interface FigmaImportResult {
  rootIds: string[];
  /** Figma node id → Design Canvas node id (the plugin tags its layers with these). */
  keyMap: Record<string, string>;
  created: number;
  updated: number;
  removed: number;
  warnings: string[];
}

// --------------------------------------------------------------------------

const hex2 = (n: number) =>
  Math.round(Math.min(1, Math.max(0, n)) * 255)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase();

/** 0..1 RGBA → `#RRGGBB` (opaque) or `rgba(r, g, b, a)`. */
export function rgbaToCss(c: RGBA): string {
  if (c.a >= 0.999) return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
  const ch = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 255);
  return `rgba(${ch(c.r)}, ${ch(c.g)}, ${ch(c.b)}, ${Math.round(c.a * 1000) / 1000})`;
}

/** Inverse of linearGradientTransform: CSS angle (deg) from a Figma gradient transform. */
export function cssAngleFromTransform(t: [[number, number, number], [number, number, number]], w: number, h: number): number {
  const dx = t[0][0] / (w || 1);
  const dy = t[0][1] / (h || 1);
  let deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  deg = ((deg % 360) + 360) % 360;
  return Math.round(deg * 100) / 100;
}

interface Ctx {
  doc: DesignDoc;
  payload: FigmaImportPayload;
  ids: Map<string, string>;
  existing: Set<string>;
  warnings: Set<string>;
  created: number;
  updated: number;
  /** Ids attached during this import (never garbage-collected). */
  touched: Set<string>;
  /** Children dropped from updated containers (deleted at the end unless re-attached). */
  dropped: Set<string>;
}

function warn(ctx: Ctx, m: string) {
  ctx.warnings.add(m);
}

function tok(name: string | undefined): string | undefined {
  return name ? `$${name}` : undefined;
}

function paintIn(ctx: Ctx, p: FPaint, w: number, h: number): Paint | null {
  const visible = p.visible === false ? { visible: false } : {};
  if (p.type === 'SOLID') return { type: 'solid', color: tok(p.variable) ?? rgbaToCss(p.color), ...visible };
  if (p.type === 'IMAGE') {
    if (!p.url) {
      warn(ctx, 'An image could not be transferred from Figma.');
      return null;
    }
    if (p.scaleMode === 'CROP') warn(ctx, 'Cropped image fills are imported as "cover".');
    return { type: 'image', src: p.url, fit: p.scaleMode === 'FIT' ? 'contain' : 'cover', ...visible };
  }
  const stops = p.stops.map((s) => ({ color: rgbaToCss(s.color), position: s.position }));
  if (p.type === 'GRADIENT_RADIAL') return { type: 'gradient', kind: 'radial', stops, ...visible };
  return { type: 'gradient', kind: 'linear', angle: cssAngleFromTransform(p.transform, w, h), stops, ...visible };
}

function paintsIn(ctx: Ctx, list: FPaint[] | undefined, w: number, h: number): Paint[] {
  return (list ?? []).map((p) => paintIn(ctx, p, w, h)).filter((p): p is Paint => !!p);
}

function effectsIn(fx: FEffect[] | undefined): { shadows?: Shadow[]; blur?: number; backdropBlur?: number } {
  const out: { shadows?: Shadow[]; blur?: number; backdropBlur?: number } = {};
  for (const e of fx ?? []) {
    if (e.type === 'LAYER_BLUR') {
      if (e.visible !== false) out.blur = Math.round((e.radius / 2) * 100) / 100;
    } else if (e.type === 'BACKGROUND_BLUR') {
      if (e.visible !== false) out.backdropBlur = Math.round((e.radius / 2) * 100) / 100;
    } else if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      (out.shadows ??= []).push({
        type: e.type === 'INNER_SHADOW' ? 'inner' : 'drop',
        x: e.offset.x,
        y: e.offset.y,
        blur: e.radius,
        ...(e.spread ? { spread: e.spread } : {}),
        color: tok(e.variable) ?? rgbaToCss(e.color),
        ...(e.visible === false ? { visible: false } : {}),
      });
    }
  }
  return out;
}

const sizeMode = (s: Sizing) => (s === 'FILL' ? 'fill' : s === 'HUG' ? 'hug' : 'fixed') as 'fill' | 'hug' | 'fixed';

const BLEND_IN: Record<string, string> = {
  MULTIPLY: 'multiply',
  SCREEN: 'screen',
  OVERLAY: 'overlay',
  DARKEN: 'darken',
  LIGHTEN: 'lighten',
  COLOR_DODGE: 'color-dodge',
  COLOR_BURN: 'color-burn',
  HARD_LIGHT: 'hard-light',
  SOFT_LIGHT: 'soft-light',
  DIFFERENCE: 'difference',
  EXCLUSION: 'exclusion',
  HUE: 'hue',
  SATURATION: 'saturation',
  COLOR: 'color',
  LUMINOSITY: 'luminosity',
};

function numOrToken(v: number, binding: string | undefined): number | string {
  return binding ? `$${binding}` : Math.round(v * 100) / 100;
}

/** Everything a node of any type has. */
function baseProps(ctx: Ctx, s: FigmaSpec): Partial<SceneNode> & Record<string, any> {
  const b = s.bindings ?? {};
  const p: Record<string, any> = {
    name: s.name,
    x: Math.round(s.x * 100) / 100,
    y: Math.round(s.y * 100) / 100,
    width: Math.round(s.width * 100) / 100,
    height: Math.round(s.height * 100) / 100,
    widthMode: sizeMode(s.sizingH),
    heightMode: sizeMode(s.sizingV),
  };
  if (s.absolute) p.position = 'absolute';
  if (s.rotation) p.rotation = Math.round(s.rotation * 100) / 100;
  if (!s.visible) p.visible = false;
  if (s.locked) p.locked = true;
  if (s.opacity < 1) p.opacity = Math.round(s.opacity * 1000) / 1000;
  if (BLEND_IN[s.blendMode]) p.blendMode = BLEND_IN[s.blendMode];
  for (const k of ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'] as const) if (s[k] !== undefined && s[k] !== null) p[k] = s[k];
  if (s.description) p.description = s.description;
  if (s.radius && s.kind !== 'ELLIPSE') {
    const keys = ['topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius'];
    const corners = s.radius.map((r, i) => numOrToken(r, b[keys[i]]));
    if (corners.some((c) => c !== 0)) p.radius = corners.every((c) => c === corners[0]) ? corners[0] : corners;
  }
  if (s.strokes?.length) {
    const solid = s.strokes.find((x) => x.type === 'SOLID' && x.visible !== false) as Extract<FPaint, { type: 'SOLID' }> | undefined;
    if (!solid) warn(ctx, `"${s.name}": gradient/image strokes aren't supported; skipped.`);
    else if (s.kind === 'TEXT') warn(ctx, `"${s.name}": text strokes aren't supported on the canvas; skipped.`);
    else {
      const w = s.strokeWeight ?? 1;
      const dash = s.dashPattern ?? [];
      const stroke: Stroke = { color: tok(solid.variable) ?? rgbaToCss(solid.color), width: w };
      if (dash.length) stroke.style = dash[0] <= w * 1.01 ? 'dotted' : 'dashed';
      stroke.align = s.strokeAlign === 'CENTER' ? 'center' : s.strokeAlign === 'OUTSIDE' ? 'outside' : 'inside';
      p.stroke = stroke;
    }
  }
  Object.assign(p, effectsIn(s.effects));
  return p as Partial<SceneNode>;
}

function textProps(ctx: Ctx, s: FigmaSpec, p: Record<string, any>) {
  const t = s.text!;
  const b = s.bindings ?? {};
  p.text = t.characters;
  p.fontFamily = t.family;
  p.fontSize = numOrToken(t.fontSize, b.fontSize);
  if (t.weight !== 400) p.fontWeight = t.weight;
  if (t.italic) p.italic = true;
  if (t.lineHeight.unit === 'AUTO') p.lineHeight = 'normal';
  else if (t.lineHeight.unit === 'PERCENT') p.lineHeight = `${Math.round(t.lineHeight.value * 100) / 100}%`;
  else p.lineHeight = numOrToken(t.lineHeight.value, b.lineHeight);
  if (t.letterSpacing) p.letterSpacing = Math.round(t.letterSpacing * 100) / 100;
  if (t.textAlignHorizontal !== 'LEFT') p.textAlign = t.textAlignHorizontal === 'JUSTIFIED' ? 'justify' : t.textAlignHorizontal.toLowerCase();
  if (t.textDecoration !== 'NONE') p.textDecoration = t.textDecoration === 'UNDERLINE' ? 'underline' : 'line-through';
  if (t.textCase !== 'ORIGINAL') p.textTransform = t.textCase === 'UPPER' ? 'uppercase' : t.textCase === 'LOWER' ? 'lowercase' : 'capitalize';
  // Text box sizing follows Figma's auto-resize mode.
  if (t.textAutoResize === 'WIDTH_AND_HEIGHT') {
    p.widthMode = s.sizingH === 'FILL' ? 'fill' : 'hug';
    p.heightMode = 'hug';
  } else if (t.textAutoResize === 'HEIGHT') {
    p.widthMode = s.sizingH === 'FILL' ? 'fill' : 'fixed';
    p.heightMode = 'hug';
  } else {
    if (p.widthMode === 'hug') p.widthMode = 'fixed';
    if (p.heightMode === 'hug') p.heightMode = 'fixed';
  }
}

function layoutProps(s: FigmaSpec, p: Record<string, any>) {
  const l = s.layout;
  if (!l) return;
  const b = s.bindings ?? {};
  const keys = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'];
  p.layout = {
    mode: l.mode === 'HORIZONTAL' ? 'row' : 'column',
    gap: numOrToken(l.itemSpacing, b.itemSpacing),
    padding: l.padding.map((v, i) => numOrToken(v, b[keys[i]])),
    justify: l.primaryAxisAlignItems === 'CENTER' ? 'center' : l.primaryAxisAlignItems === 'MAX' ? 'end' : l.primaryAxisAlignItems === 'SPACE_BETWEEN' ? 'space-between' : 'start',
    align: l.counterAxisAlignItems === 'CENTER' ? 'center' : l.counterAxisAlignItems === 'MAX' ? 'end' : l.counterAxisAlignItems === 'BASELINE' ? 'baseline' : 'start',
    ...(l.wrap ? { wrap: true } : {}),
  };
}

/** Assign a Design Canvas id to every spec key up front, so instances can point at components anywhere. */
function assignIds(ctx: Ctx, s: FigmaSpec) {
  if (!ctx.ids.has(s.key)) {
    const prefix = ctx.doc.id + '/';
    const own = s.key.startsWith(prefix) ? s.key.slice(prefix.length) : null;
    if (own && ctx.doc.nodes[own] && !ctx.existing.has(own)) {
      ctx.ids.set(s.key, own);
      ctx.existing.add(own);
    } else ctx.ids.set(s.key, uid());
  }
  for (const c of s.children ?? []) assignIds(ctx, c);
}

function build(ctx: Ctx, s: FigmaSpec, parentId: string, index: number): string {
  const id = ctx.ids.get(s.key)!;
  const prev = ctx.doc.nodes[id];
  const p: Record<string, any> = baseProps(ctx, s);
  let type: SceneNode['type'];
  switch (s.kind) {
    case 'FRAME':
    case 'COMPONENT':
      type = s.kind === 'COMPONENT' ? 'component' : 'frame';
      p.fills = paintsIn(ctx, s.fills, s.width, s.height);
      if (s.clipsContent) p.clip = true;
      layoutProps(s, p);
      if (s.codeConnect) p.codeConnect = s.codeConnect;
      break;
    case 'RECTANGLE': {
      const fills = paintsIn(ctx, s.fills, s.width, s.height);
      const top = fills[fills.length - 1];
      if (top && top.type === 'image' && top.visible !== false) {
        type = 'image';
        p.src = top.src;
        p.fit = top.fit;
        p.fills = fills.slice(0, -1);
      } else {
        type = 'rect';
        p.fills = fills;
      }
      break;
    }
    case 'ELLIPSE':
      type = 'ellipse';
      p.fills = paintsIn(ctx, s.fills, s.width, s.height);
      break;
    case 'TEXT':
      type = 'text';
      p.fills = paintsIn(ctx, s.fills, s.width, s.height);
      textProps(ctx, s, p);
      break;
    case 'SVG':
      type = 'svg';
      p.svg = s.svg ?? '';
      break;
    case 'INSTANCE': {
      type = 'instance';
      const compId = s.componentKey ? ctx.ids.get(s.componentKey) : undefined;
      if (!compId) {
        warn(ctx, `Instance "${s.name}" lost its main component; imported as an empty frame.`);
        type = 'frame';
        p.fills = [];
        break;
      }
      p.componentId = compId;
      if (s.fills) p.fills = paintsIn(ctx, s.fills, s.width, s.height);
      const overrides: Record<string, NodeOverride> = {};
      for (const o of s.overrides ?? []) {
        const path = o.path.map((k) => ctx.ids.get(k));
        if (path.some((x) => !x)) {
          warn(ctx, `An override on "${s.name}" points to a layer that wasn't imported.`);
          continue;
        }
        const ov: NodeOverride = {};
        if (o.characters !== undefined) ov.text = o.characters;
        if (o.visible !== undefined) ov.visible = o.visible;
        if (o.fills) {
          const fills = paintsIn(ctx, o.fills, s.width, s.height);
          const img = fills.find((f) => f.type === 'image');
          if (img && img.type === 'image') ov.src = img.src;
          else ov.fills = fills;
        }
        if (Object.keys(ov).length) overrides[path.join(':')] = ov;
      }
      if (Object.keys(overrides).length) p.overrides = overrides;
      break;
    }
    default:
      type = 'frame';
  }
  if (type !== 'text' && p.widthMode === 'hug' && !(type === 'frame' || type === 'component' || type === 'instance')) p.widthMode = 'fixed';
  if (type !== 'text' && p.heightMode === 'hug' && !(type === 'frame' || type === 'component' || type === 'instance')) p.heightMode = 'fixed';
  for (const k of ['widthMode', 'heightMode'] as const) if (p[k] === 'fixed') delete p[k];
  if (type === 'text') {
    p.widthMode ??= 'fixed';
    p.heightMode ??= 'fixed';
  }

  const node: any = { id, type, parentId, ...p };
  if (type === 'frame' || type === 'component') node.children = [];
  if (prev) {
    ctx.updated++;
    // Keep the canvas position of updated top-level layers (the user arranged them).
    if (!ctx.doc.nodes[prev.parentId] && ctx.doc.pages[parentId] && prev.parentId === parentId) {
      node.x = prev.x;
      node.y = prev.y;
    }
    if (isFrameLike(prev)) for (const c of prev.children) ctx.dropped.add(c);
    detachIfMoved(ctx, prev, parentId);
  } else ctx.created++;
  ctx.doc.nodes[id] = node as SceneNode;
  ctx.touched.add(id);
  attachToParent(ctx.doc, id, parentId, index);
  if (node.children) (s.children ?? []).forEach((c, i) => build(ctx, c, id, i));
  return id;
}

function detachIfMoved(ctx: Ctx, prev: SceneNode, parentId: string) {
  if (prev.parentId === parentId) return;
  const list = ctx.doc.pages[prev.parentId]?.children ?? (ctx.doc.nodes[prev.parentId] as FrameNode | undefined)?.children;
  if (list) {
    const i = list.indexOf(prev.id);
    if (i >= 0) list.splice(i, 1);
  }
}

function importVariables(ctx: Ctx) {
  for (const v of ctx.payload.variables ?? []) {
    let value: string | number;
    let type: 'color' | 'number' | 'string';
    if (v.type === 'COLOR' && typeof v.value === 'object') {
      value = rgbaToCss(v.value as RGBA);
      type = 'color';
    } else if (v.type === 'FLOAT' && typeof v.value === 'number') {
      value = v.value;
      type = 'number';
    } else {
      value = String(v.value);
      type = 'string';
    }
    upsertVariable(ctx.doc, { name: sanitizeVarName(v.token), type, value, ...(v.group ? { group: v.group } : {}), ...(v.description ? { description: v.description } : {}) });
  }
}

/** Page-content bounds for placing new layers to the right of what's there. */
function pageRight(doc: DesignDoc, pageId: string): number | null {
  let max: number | null = null;
  for (const id of doc.pages[pageId]?.children ?? []) {
    const n = doc.nodes[id];
    if (n) max = Math.max(max ?? -Infinity, n.x + n.width);
  }
  return max;
}

/**
 * Import Figma layers into `pageId`. Draft-safe (call inside an immer recipe).
 */
export function importFromFigma(doc: DesignDoc, payload: FigmaImportPayload, opts: { pageId: string }): FigmaImportResult {
  if (payload?.format !== FIGMA_IMPORT_FORMAT) throw new Error('Not a Design Canvas import from Figma');
  if (!doc.pages[opts.pageId]) throw new Error(`Page "${opts.pageId}" not found`);
  const ctx: Ctx = {
    doc,
    payload,
    ids: new Map(),
    existing: new Set(),
    warnings: new Set(payload.warnings ?? []),
    created: 0,
    updated: 0,
    touched: new Set(),
    dropped: new Set(),
  };
  importVariables(ctx);
  const comps = Object.values(payload.components ?? {});
  payload.roots.forEach((r) => assignIds(ctx, r));
  comps.forEach((c) => assignIds(ctx, c));

  // New top-level layers keep their Figma arrangement, placed right of existing content.
  const fresh = [...payload.roots, ...comps.filter((c) => !payload.roots.some((r) => r.key === c.key))].filter((r) => {
    const id = ctx.ids.get(r.key)!;
    return !doc.nodes[id];
  });
  const right = pageRight(doc, opts.pageId);
  const minX = Math.min(...fresh.map((r) => r.x));
  const minY = Math.min(...fresh.map((r) => r.y));
  const dx = right === null ? -minX : right + 120 - minX;
  const dy = -minY;

  const inRoots = new Set<string>();
  const mark = (s: FigmaSpec) => {
    inRoots.add(s.key);
    (s.children ?? []).forEach(mark);
  };
  payload.roots.forEach(mark);

  const rootIds: string[] = [];
  const place = (spec: FigmaSpec) => {
    const isNew = !doc.nodes[ctx.ids.get(spec.key)!];
    const prev = doc.nodes[ctx.ids.get(spec.key)!];
    const parent = prev && !isNew ? prev.parentId : opts.pageId;
    const target = isNew ? { ...spec, x: spec.x + dx, y: spec.y + dy } : spec;
    const list = doc.pages[parent]?.children ?? (doc.nodes[parent] as FrameNode | undefined)?.children ?? [];
    const at = prev ? list.indexOf(prev.id) : -1;
    return build(ctx, target, doc.pages[parent] || doc.nodes[parent] ? parent : opts.pageId, at >= 0 ? at : -1);
  };
  for (const r of payload.roots) rootIds.push(place(r));
  // Components used by the selection but living elsewhere in Figma.
  for (const c of comps) if (!inRoots.has(c.key)) place(c);

  // Layers removed in Figma from containers that were updated.
  let removed = 0;
  for (const id of ctx.dropped) {
    if (ctx.touched.has(id) || !doc.nodes[id]) continue;
    deleteNode(doc, id);
    removed++;
  }

  const keyMap: Record<string, string> = {};
  const collect = (s: FigmaSpec) => {
    if (s.figmaId) keyMap[s.figmaId] = ctx.ids.get(s.key)!;
    (s.children ?? []).forEach(collect);
  };
  payload.roots.forEach(collect);
  comps.forEach(collect);
  return { rootIds, keyMap, created: ctx.created, updated: ctx.updated, removed, warnings: [...ctx.warnings] };
}

