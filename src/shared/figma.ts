/**
 * Design Canvas → Figma export.
 *
 * Converts a document subtree into Figma-shaped specs that the Design Canvas
 * Figma plugin (figma-plugin/) applies with the Plugin API. All the mapping
 * decisions live here (pure + unit-tested) so the plugin stays a thin,
 * generic "apply this spec" layer:
 *
 *  - frames with auto layout → Figma auto layout (flexbox semantics, incl. the
 *    CSS rules for fill / hug / align-items: stretch)
 *  - components → main components, instances → real instances with overrides
 *    addressed by component-layer path, so a component edit flows to every
 *    instance in Figma exactly like it does on the canvas
 *  - design tokens → Figma variables (bound by name, code syntax `var(--x)`)
 *  - every node carries a stable key, so sending again updates in place
 */
import type { Color, DesignDoc, FrameNode, InstanceNode, Num, Paint, SceneNode, Shadow, TextNode, Variable } from './types.ts';
import { isFrameLike } from './doc.ts';
import { CANVAS_AUTO_LINE_HEIGHT, DEFAULT_FONT, DEFAULT_FONT_SIZE, isTokenRef, sizeMode, tokenName } from './style.ts';

export const FIGMA_FORMAT = 'design-canvas/figma@1';

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export type FigmaTransform = [[number, number, number], [number, number, number]];

export type FPaint =
  | { type: 'SOLID'; color: RGBA; visible: boolean; variable?: string }
  | { type: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL'; transform: FigmaTransform; stops: Array<{ position: number; color: RGBA }>; visible: boolean }
  | { type: 'IMAGE'; url: string; scaleMode: 'FILL' | 'FIT' | 'CROP'; visible: boolean };

export type FEffect =
  | { type: 'DROP_SHADOW' | 'INNER_SHADOW'; color: RGBA; offset: { x: number; y: number }; radius: number; spread: number; visible: boolean; variable?: string }
  | { type: 'LAYER_BLUR' | 'BACKGROUND_BLUR'; radius: number; visible: boolean };

export type Sizing = 'FIXED' | 'HUG' | 'FILL';

export interface FLayout {
  mode: 'HORIZONTAL' | 'VERTICAL';
  wrap: boolean;
  itemSpacing: number;
  counterAxisSpacing: number;
  padding: [number, number, number, number];
  primaryAxisAlignItems: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';
  counterAxisAlignItems: 'MIN' | 'CENTER' | 'MAX' | 'BASELINE';
}

export interface FText {
  characters: string;
  family: string;
  weight: number;
  italic: boolean;
  fontSize: number;
  lineHeight: { unit: 'AUTO' } | { unit: 'PIXELS' | 'PERCENT'; value: number };
  letterSpacing: number;
  textAlignHorizontal: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  textDecoration: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
  textCase: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE';
  textAutoResize: 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'NONE';
}

export interface FOverride {
  /** Path of Design Canvas node ids from the instance's component down to the layer. */
  path: string[];
  characters?: string;
  visible?: boolean;
  fills?: FPaint[];
}

export interface FigmaSpec {
  /** Design Canvas node id — stable identity used to update in place. */
  key: string;
  /** Figma node id (only in payloads coming from Figma). */
  figmaId?: string;
  kind: 'FRAME' | 'COMPONENT' | 'INSTANCE' | 'RECTANGLE' | 'ELLIPSE' | 'TEXT' | 'SVG';
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** CSS degrees, clockwise, around the center. */
  rotation: number;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blendMode: string;
  sizingH: Sizing;
  sizingV: Sizing;
  /** True when the parent has auto layout and this node is out of the flow. */
  absolute: boolean;
  /** True when the parent has auto layout and this node is in the flow (x/y ignored). */
  inFlow: boolean;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  fills?: FPaint[];
  strokes?: FPaint[];
  strokeWeight?: number;
  strokeAlign?: 'INSIDE' | 'CENTER' | 'OUTSIDE';
  dashPattern?: number[];
  /** [topLeft, topRight, bottomRight, bottomLeft] */
  radius?: [number, number, number, number];
  effects?: FEffect[];
  clipsContent?: boolean;
  layout?: FLayout;
  text?: FText;
  svg?: string;
  /** INSTANCE: key of the main component. */
  componentKey?: string;
  overrides?: FOverride[];
  description?: string;
  codeConnect?: { name: string; importPath?: string; notes?: string };
  /** Numeric fields bound to variables: Figma field name → token name. */
  bindings?: Record<string, string>;
  children?: FigmaSpec[];
}

export interface FVariable {
  /** Token name in Design Canvas (`primary`). */
  token: string;
  /** Figma variable name (`color/primary` when the token has a group). */
  name: string;
  type: 'COLOR' | 'FLOAT' | 'STRING';
  value: RGBA | number | string;
  description?: string;
}

export interface FigmaExport {
  format: typeof FIGMA_FORMAT;
  docId: string;
  docName: string;
  pageName: string;
  exportedAt: number;
  variables: FVariable[];
  /** Every component the export needs, by key. `external` ones are not inside `roots`. */
  components: Record<string, FigmaSpec & { external: boolean }>;
  roots: FigmaSpec[];
  fonts: Array<{ family: string; weight: number; italic: boolean }>;
  images: string[];
  warnings: string[];
  stats: { nodes: number; components: number; instances: number; variables: number };
}

// --------------------------------------------------------------------------
// Colors

const NAMED: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  lime: '#00ff00',
  blue: '#0000ff',
  yellow: '#ffff00',
  cyan: '#00ffff',
  aqua: '#00ffff',
  magenta: '#ff00ff',
  fuchsia: '#ff00ff',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
  maroon: '#800000',
  olive: '#808000',
  purple: '#800080',
  teal: '#008080',
  navy: '#000080',
  orange: '#ffa500',
  pink: '#ffc0cb',
  gold: '#ffd700',
  indigo: '#4b0082',
  violet: '#ee82ee',
  brown: '#a52a2a',
  tomato: '#ff6347',
  coral: '#ff7f50',
  salmon: '#fa8072',
  crimson: '#dc143c',
  whitesmoke: '#f5f5f5',
  gainsboro: '#dcdcdc',
  lightgray: '#d3d3d3',
  lightgrey: '#d3d3d3',
  darkgray: '#a9a9a9',
  darkgrey: '#a9a9a9',
  dimgray: '#696969',
  slategray: '#708090',
  skyblue: '#87ceeb',
  royalblue: '#4169e1',
  dodgerblue: '#1e90ff',
  steelblue: '#4682b4',
  seagreen: '#2e8b57',
  forestgreen: '#228b22',
  rebeccapurple: '#663399',
  beige: '#f5f5dc',
  ivory: '#fffff0',
};

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const r4 = (n: number) => Math.round(n * 10000) / 10000 || 0;

function channel(s: string, max: number): number {
  s = s.trim();
  if (s.endsWith('%')) return clamp01(parseFloat(s) / 100);
  return clamp01(parseFloat(s) / max);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = (((h % 360) + 360) % 360) / 360;
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

/** Parse a CSS color into 0..1 RGBA. Returns null for anything we can't map exactly. */
export function parseColor(input: string): RGBA | null {
  let c = input.trim().toLowerCase();
  if (c === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (NAMED[c]) c = NAMED[c];
  let m = c.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    return { r: r4(n(0)), g: r4(n(2)), b: r4(n(4)), a: h.length === 8 ? r4(n(6)) : 1 };
  }
  m = c.match(/^(rgba?|hsla?)\((.*)\)$/);
  if (!m) return null;
  const parts = m[2].includes(',') ? m[2].split(',') : m[2].replace('/', ' / ').split(/\s+/).filter((p) => p && p !== '/');
  if (parts.length < 3) return null;
  const alpha = parts[3] !== undefined ? channel(parts[3], 1) : 1;
  if (m[1].startsWith('rgb')) {
    return { r: r4(channel(parts[0], 255)), g: r4(channel(parts[1], 255)), b: r4(channel(parts[2], 255)), a: r4(alpha) };
  }
  const [r, g, b] = hslToRgb(parseFloat(parts[0]), channel(parts[1], 100), channel(parts[2], 100));
  return { r: r4(r), g: r4(g), b: r4(b), a: r4(alpha) };
}

// --------------------------------------------------------------------------
// Gradients — exact CSS geometry expressed as Figma gradient transforms
// (the transform maps the node's normalized space to gradient space).

/** `linear-gradient(<angle>deg, …)`: CSS gradient line through the center, length |w·sinθ| + |h·cosθ|. */
export function linearGradientTransform(angleDeg: number, w: number, h: number): FigmaTransform {
  const t = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(t);
  const dy = -Math.cos(t);
  const L = Math.abs(w * dx) + Math.abs(h * dy) || 1;
  const a = (dx * w) / L;
  const b = (dy * h) / L;
  // Perpendicular axis (only used by Figma for the handle's width).
  const c = (-dy * w) / L;
  const d = (dx * h) / L;
  return [
    [r4(a), r4(b), r4(0.5 - (a + b) / 2)],
    [r4(c), r4(d), r4(0.5 - (c + d) / 2)],
  ];
}

/** `radial-gradient(circle, …)`: a circle centered in the box reaching the farthest corner. */
export function radialGradientTransform(w: number, h: number): FigmaTransform {
  const R = Math.sqrt((w / 2) ** 2 + (h / 2) ** 2) || 1;
  const sx = w / (2 * R);
  const sy = h / (2 * R);
  return [
    [r4(sx), 0, r4(0.5 - sx / 2)],
    [0, r4(sy), r4(0.5 - sy / 2)],
  ];
}

// --------------------------------------------------------------------------

interface Ctx {
  doc: DesignDoc;
  vars: Map<string, Variable>;
  assetBase: string;
  warnings: Set<string>;
  fonts: Map<string, { family: string; weight: number; italic: boolean }>;
  images: Set<string>;
  components: Record<string, FigmaSpec & { external: boolean }>;
  wantedComponents: Set<string>;
  stats: { nodes: number; components: number; instances: number };
}

function warn(ctx: Ctx, msg: string) {
  ctx.warnings.add(msg);
}

function lookupVar(ctx: Ctx, ref: string): Variable | undefined {
  const v = ctx.vars.get(tokenName(ref));
  if (!v) warn(ctx, `Token "${ref}" is not defined; used 0 / transparent.`);
  return v;
}

/** Number or token → px number (+ the variable to bind, when it's a token). */
function num(ctx: Ctx, v: Num | undefined, fallback = 0): { value: number; variable?: string } {
  if (v === undefined || v === null) return { value: fallback };
  if (typeof v === 'number') return { value: v };
  if (isTokenRef(v)) {
    const variable = lookupVar(ctx, v);
    if (!variable) return { value: fallback };
    const n = parseFloat(String(variable.value));
    return { value: Number.isFinite(n) ? n : fallback, variable: variable.type === 'number' ? variable.name : undefined };
  }
  const n = parseFloat(v);
  return { value: Number.isFinite(n) ? n : fallback };
}

function col(ctx: Ctx, c: Color | undefined): { color: RGBA; variable?: string } {
  if (!c) return { color: { r: 0, g: 0, b: 0, a: 0 } };
  if (isTokenRef(c)) {
    const v = lookupVar(ctx, c);
    if (!v) return { color: { r: 0, g: 0, b: 0, a: 0 } };
    const parsed = parseColor(String(v.value));
    if (!parsed) warn(ctx, `Token "${c}" (${v.value}) is not a color Figma understands.`);
    return { color: parsed ?? { r: 0, g: 0, b: 0, a: 1 }, variable: v.type === 'color' && parsed ? v.name : undefined };
  }
  const parsed = parseColor(c);
  if (!parsed) {
    warn(ctx, `Color "${c}" can't be converted exactly; used black.`);
    return { color: { r: 0, g: 0, b: 0, a: 1 } };
  }
  return { color: parsed };
}

function assetUrl(ctx: Ctx, src: string): string {
  if (/^https?:\/\//i.test(src) || src.startsWith('data:')) return src;
  return ctx.assetBase.replace(/\/$/, '') + (src.startsWith('/') ? src : '/' + src);
}

function imagePaint(ctx: Ctx, src: string, fit: 'cover' | 'contain' | 'fill' | undefined, visible = true): FPaint {
  const url = assetUrl(ctx, src);
  ctx.images.add(url);
  return { type: 'IMAGE', url, scaleMode: fit === 'contain' ? 'FIT' : fit === 'fill' ? 'CROP' : 'FILL', visible };
}

function paints(ctx: Ctx, fills: Paint[] | undefined, w: number, h: number): FPaint[] {
  const out: FPaint[] = [];
  for (const p of fills ?? []) {
    const visible = p.visible !== false;
    if (p.type === 'solid') {
      const { color, variable } = col(ctx, p.color);
      out.push({ type: 'SOLID', color, visible, ...(variable ? { variable } : {}) });
    } else if (p.type === 'gradient') {
      const stops = (p.stops ?? []).map((s) => ({ position: clamp01(s.position), color: col(ctx, s.color).color }));
      if (p.stops?.some((s) => isTokenRef(s.color))) warn(ctx, 'Gradient stops that use tokens are exported as plain colors (Figma can only bind solid paints).');
      if (p.kind === 'radial') out.push({ type: 'GRADIENT_RADIAL', transform: radialGradientTransform(w, h), stops, visible });
      else out.push({ type: 'GRADIENT_LINEAR', transform: linearGradientTransform(p.angle ?? 180, w, h), stops, visible });
    } else if (p.type === 'image' && p.src) {
      out.push(imagePaint(ctx, p.src, p.fit, visible));
    }
  }
  return out;
}

function effects(ctx: Ctx, node: SceneNode): FEffect[] {
  const out: FEffect[] = [];
  const text = node.type === 'text';
  for (const s of node.shadows ?? ([] as Shadow[])) {
    const { color, variable } = col(ctx, s.color);
    out.push({
      type: s.type === 'inner' && !text ? 'INNER_SHADOW' : 'DROP_SHADOW',
      color,
      offset: { x: s.x, y: s.y },
      radius: s.blur,
      spread: text ? 0 : (s.spread ?? 0),
      visible: s.visible !== false,
      ...(variable ? { variable } : {}),
    });
  }
  // CSS blur(σ) ≈ Figma blur radius 2σ (Figma exports `blur(radius / 2)`).
  if (node.blur) out.push({ type: 'LAYER_BLUR', radius: node.blur * 2, visible: true });
  if (node.backdropBlur) out.push({ type: 'BACKGROUND_BLUR', radius: node.backdropBlur * 2, visible: true });
  return out;
}

const BLEND: Record<string, string> = {
  normal: 'NORMAL',
  multiply: 'MULTIPLY',
  screen: 'SCREEN',
  overlay: 'OVERLAY',
  darken: 'DARKEN',
  lighten: 'LIGHTEN',
  'color-dodge': 'COLOR_DODGE',
  'color-burn': 'COLOR_BURN',
  'hard-light': 'HARD_LIGHT',
  'soft-light': 'SOFT_LIGHT',
  difference: 'DIFFERENCE',
  exclusion: 'EXCLUSION',
  hue: 'HUE',
  saturation: 'SATURATION',
  color: 'COLOR',
  luminosity: 'LUMINOSITY',
};

function hasLayout(n: SceneNode | null | undefined): n is FrameNode {
  return !!n && isFrameLike(n) && !!n.layout && n.layout.mode !== 'none';
}

function fontFamily(ctx: Ctx, f: string | undefined): string {
  let fam = f || DEFAULT_FONT;
  if (isTokenRef(fam)) fam = String(lookupVar(ctx, fam)?.value ?? DEFAULT_FONT);
  return fam.split(',')[0].trim().replace(/^["']|["']$/g, '') || DEFAULT_FONT;
}

function textSpec(ctx: Ctx, n: TextNode, sizingH: Sizing, sizingV: Sizing, bindings: Record<string, string>): FText {
  const family = fontFamily(ctx, n.fontFamily);
  const weight = n.fontWeight ?? 400;
  const italic = !!n.italic;
  ctx.fonts.set(`${family}|${weight}|${italic}`, { family, weight, italic });
  const size = num(ctx, n.fontSize, DEFAULT_FONT_SIZE);
  if (size.variable) bindings.fontSize = size.variable;
  // "auto" on the canvas inherits the editor's line-height; Figma's Auto uses font metrics instead.
  let lineHeight: FText['lineHeight'] = { unit: 'PERCENT', value: CANVAS_AUTO_LINE_HEIGHT * 100 };
  const lh = n.lineHeight as number | string | undefined;
  if (typeof lh === 'number') lineHeight = { unit: 'PIXELS', value: lh };
  else if (lh === 'normal') lineHeight = { unit: 'AUTO' }; // CSS `normal` = font metrics = Figma Auto
  else if (typeof lh === 'string' && lh !== 'auto') {
    if (lh.startsWith('$')) {
      const v = num(ctx, lh);
      lineHeight = { unit: 'PIXELS', value: v.value };
      if (v.variable) bindings.lineHeight = v.variable;
    } else if (lh.endsWith('%')) lineHeight = { unit: 'PERCENT', value: parseFloat(lh) };
    else if (lh.endsWith('em')) lineHeight = { unit: 'PERCENT', value: parseFloat(lh) * 100 };
    else if (Number.isFinite(parseFloat(lh))) lineHeight = { unit: 'PIXELS', value: parseFloat(lh) };
  }
  const autoResize: FText['textAutoResize'] = sizingH === 'HUG' ? 'WIDTH_AND_HEIGHT' : sizingV === 'HUG' ? 'HEIGHT' : 'NONE';
  return {
    characters: n.text ?? '',
    family,
    weight,
    italic,
    fontSize: size.value,
    lineHeight,
    letterSpacing: n.letterSpacing ?? 0,
    textAlignHorizontal: n.textAlign === 'center' ? 'CENTER' : n.textAlign === 'right' ? 'RIGHT' : n.textAlign === 'justify' ? 'JUSTIFIED' : 'LEFT',
    textDecoration: n.textDecoration === 'underline' ? 'UNDERLINE' : n.textDecoration === 'line-through' ? 'STRIKETHROUGH' : 'NONE',
    textCase: n.textTransform === 'uppercase' ? 'UPPER' : n.textTransform === 'lowercase' ? 'LOWER' : n.textTransform === 'capitalize' ? 'TITLE' : 'ORIGINAL',
    textAutoResize: autoResize,
  };
}

function layoutSpec(ctx: Ctx, n: FrameNode, bindings: Record<string, string>): FLayout | undefined {
  const l = n.layout;
  if (!l || l.mode === 'none') return undefined;
  const gap = num(ctx, l.gap);
  if (gap.variable) bindings.itemSpacing = gap.variable;
  const pad = (l.padding ?? [0, 0, 0, 0]).map((p, i) => {
    const r = num(ctx, p);
    if (r.variable) bindings[['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'][i]] = r.variable;
    return r.value;
  }) as [number, number, number, number];
  const horizontal = l.mode === 'row';
  const wrap = !!l.wrap && horizontal;
  if (l.wrap && !horizontal) warn(ctx, 'Wrapping column layouts have no Figma equivalent; exported without wrap.');
  if (wrap && gap.variable) bindings.counterAxisSpacing = gap.variable;
  let counter: FLayout['counterAxisAlignItems'] = 'MIN';
  if (l.align === 'center') counter = 'CENTER';
  else if (l.align === 'end') counter = 'MAX';
  else if (l.align === 'baseline') counter = horizontal ? 'BASELINE' : 'MIN';
  return {
    mode: horizontal ? 'HORIZONTAL' : 'VERTICAL',
    wrap,
    itemSpacing: gap.value,
    counterAxisSpacing: wrap ? gap.value : 0,
    padding: pad,
    primaryAxisAlignItems: l.justify === 'center' ? 'CENTER' : l.justify === 'end' ? 'MAX' : l.justify === 'space-between' ? 'SPACE_BETWEEN' : 'MIN',
    counterAxisAlignItems: counter,
  };
}

function radiusSpec(ctx: Ctx, n: SceneNode, bindings: Record<string, string>): [number, number, number, number] | undefined {
  if (n.type === 'ellipse' || n.radius === undefined || n.radius === null) return undefined;
  const corners = Array.isArray(n.radius) ? n.radius : [n.radius, n.radius, n.radius, n.radius];
  const keys = ['topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius'];
  const out = corners.map((c, i) => {
    const r = num(ctx, c);
    if (r.variable) bindings[keys[i]] = r.variable;
    return r.value;
  }) as [number, number, number, number];
  return out.every((v) => v === 0) && !Object.keys(bindings).some((k) => k.endsWith('Radius')) ? undefined : out;
}

/** Can this node size itself to its content in CSS (width/height: auto)? */
function canHug(ctx: Ctx, n: SceneNode): boolean {
  if (n.type === 'text') return true;
  if (hasLayout(n)) return true;
  if (n.type === 'instance') return hasLayout(ctx.doc.nodes[n.componentId]);
  return false;
}

function sizing(ctx: Ctx, n: SceneNode, parent: SceneNode | null, inFlow: boolean, axis: 'w' | 'h'): Sizing {
  const mode = sizeMode(n, axis);
  if (mode === 'fill' && inFlow) return 'FILL';
  if (mode === 'hug' && canHug(ctx, n)) {
    // align-items: stretch stretches in-flow children whose cross size is auto.
    const pl = hasLayout(parent) ? parent.layout! : null;
    const cross = pl && ((pl.mode === 'row' && axis === 'h') || (pl.mode === 'column' && axis === 'w'));
    if (inFlow && cross && pl!.align === 'stretch') return 'FILL';
    return 'HUG';
  }
  if (mode === 'fill' && !inFlow && parent) warn(ctx, `"${n.name}" fills its parent but isn't in an auto-layout flow; exported at its measured size.`);
  return 'FIXED';
}

function nodeSpec(ctx: Ctx, n: SceneNode, parent: SceneNode | null): FigmaSpec {
  ctx.stats.nodes++;
  const pl = hasLayout(parent);
  const inFlow = pl && n.position !== 'absolute';
  const bindings: Record<string, string> = {};
  const sizingH = sizing(ctx, n, parent, inFlow, 'w');
  const sizingV = sizing(ctx, n, parent, inFlow, 'h');
  const spec: FigmaSpec = {
    key: n.id,
    kind: 'FRAME',
    name: n.name || n.type,
    x: n.x,
    y: n.y,
    width: Math.max(0.01, n.width),
    height: Math.max(0.01, n.height),
    rotation: n.rotation ?? 0,
    visible: n.visible !== false,
    locked: !!n.locked,
    opacity: n.opacity ?? 1,
    blendMode: BLEND[n.blendMode ?? 'normal'] ?? 'NORMAL',
    sizingH,
    sizingV,
    absolute: pl && n.position === 'absolute',
    inFlow,
  };
  if (n.blendMode && !BLEND[n.blendMode]) warn(ctx, `Blend mode "${n.blendMode}" has no Figma equivalent.`);
  if (n.rotation && inFlow) warn(ctx, `"${n.name}" is rotated inside auto layout: CSS rotation doesn't affect layout, Figma's does.`);
  for (const k of ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'] as const) if (n[k] !== undefined) spec[k] = n[k];
  if (n.description) spec.description = n.description;

  const fx = effects(ctx, n);
  if (fx.length) spec.effects = fx;
  const radius = radiusSpec(ctx, n, bindings);
  if (radius) spec.radius = radius;

  if (n.stroke && n.stroke.width > 0) {
    if (n.type === 'text') warn(ctx, `"${n.name}": strokes on text boxes draw an outline in CSS but stroke the glyphs in Figma; skipped.`);
    else {
      const { color, variable } = col(ctx, n.stroke.color);
      spec.strokes = [{ type: 'SOLID', color, visible: true, ...(variable ? { variable } : {}) }];
      spec.strokeWeight = n.stroke.width;
      spec.strokeAlign = n.stroke.align === 'center' ? 'CENTER' : n.stroke.align === 'outside' ? 'OUTSIDE' : 'INSIDE';
      const w = n.stroke.width;
      if (n.stroke.style === 'dashed') spec.dashPattern = [w * 3, w * 3];
      else if (n.stroke.style === 'dotted') spec.dashPattern = [w, w];
    }
  }

  switch (n.type) {
    case 'frame':
    case 'component': {
      spec.kind = n.type === 'component' ? 'COMPONENT' : 'FRAME';
      spec.fills = paints(ctx, n.fills, n.width, n.height);
      spec.clipsContent = !!n.clip;
      const layout = layoutSpec(ctx, n, bindings);
      if (layout) spec.layout = layout;
      spec.children = n.children.map((c) => ctx.doc.nodes[c]).filter(Boolean).map((c) => nodeSpec(ctx, c, n));
      if (n.type === 'component') {
        ctx.stats.components++;
        if (n.codeConnect?.name) spec.codeConnect = { ...n.codeConnect };
      }
      break;
    }
    case 'instance':
      instanceSpec(ctx, n, spec);
      break;
    case 'rect':
    case 'ellipse':
      spec.kind = n.type === 'rect' ? 'RECTANGLE' : 'ELLIPSE';
      spec.fills = paints(ctx, n.fills, n.width, n.height);
      break;
    case 'image': {
      spec.kind = 'RECTANGLE';
      const base = paints(ctx, n.fills, n.width, n.height);
      spec.fills = n.src ? [...base, imagePaint(ctx, n.src, n.fit)] : [...base, { type: 'SOLID', color: parseColor('#E5E7EB')!, visible: true }];
      break;
    }
    case 'svg':
      spec.kind = 'SVG';
      spec.svg = n.svg || '<svg xmlns="http://www.w3.org/2000/svg"/>';
      spec.fills = paints(ctx, n.fills, n.width, n.height);
      break;
    case 'text': {
      spec.kind = 'TEXT';
      const fills = (n.fills ?? []).length ? n.fills : [{ type: 'solid' as const, color: '#000000' }];
      spec.fills = paints(ctx, fills, n.width, n.height);
      spec.text = textSpec(ctx, n, sizingH, sizingV, bindings);
      break;
    }
  }
  if (Object.keys(bindings).length) spec.bindings = bindings;
  if (spec.kind === 'COMPONENT') ctx.components[n.id] = { ...spec, external: false };
  return spec;
}

function instanceSpec(ctx: Ctx, inst: InstanceNode, spec: FigmaSpec) {
  const comp = ctx.doc.nodes[inst.componentId];
  if (!comp || comp.type !== 'component') {
    warn(ctx, `Instance "${inst.name}" points to a missing component; exported as an empty frame.`);
    spec.kind = 'FRAME';
    spec.fills = [];
    spec.children = [];
    return;
  }
  ctx.stats.instances++;
  spec.kind = 'INSTANCE';
  spec.componentKey = comp.id;
  ctx.wantedComponents.add(comp.id);
  // Instance-level visuals override the component root (same as instanceRoot()).
  if (inst.fills) spec.fills = paints(ctx, inst.fills, inst.width, inst.height);
  if (!inst.stroke) {
    delete spec.strokes;
    delete spec.strokeWeight;
    delete spec.strokeAlign;
    delete spec.dashPattern;
  }
  if (inst.radius === undefined) delete spec.radius;
  if (!inst.shadows && !inst.blur && !inst.backdropBlur) delete spec.effects;
  const overrides: FOverride[] = [];
  for (const [path, o] of Object.entries(inst.overrides ?? {})) {
    const ids = path === comp.id ? [] : path.split(':');
    const target = ids.length ? ctx.doc.nodes[ids[ids.length - 1]] : comp;
    if (!target) continue;
    const fo: FOverride = { path: ids };
    if (o.text !== undefined && target.type === 'text') {
      fo.characters = o.text;
      const t = target as TextNode;
      const family = fontFamily(ctx, t.fontFamily);
      ctx.fonts.set(`${family}|${t.fontWeight ?? 400}|${!!t.italic}`, { family, weight: t.fontWeight ?? 400, italic: !!t.italic });
    }
    if (o.visible !== undefined) fo.visible = o.visible;
    if (o.fills !== undefined) fo.fills = paints(ctx, o.fills, target.width, target.height);
    if (o.src !== undefined && target.type === 'image') fo.fills = [...paints(ctx, target.fills, target.width, target.height), imagePaint(ctx, o.src, (target as any).fit)];
    if (!ids.length) {
      if (fo.fills) spec.fills = fo.fills;
      if (fo.visible !== undefined) spec.visible = fo.visible;
      continue;
    }
    overrides.push(fo);
  }
  if (overrides.length) spec.overrides = overrides;
}

function variableSpec(ctx: Ctx, v: Variable): FVariable {
  const name = v.group ? `${v.group}/${v.name}` : v.name;
  const base = { token: v.name, name, ...(v.description ? { description: v.description } : {}) };
  if (v.type === 'color') {
    const c = parseColor(String(v.value));
    if (c) return { ...base, type: 'COLOR', value: c };
    warn(ctx, `Color token "${v.name}" (${v.value}) exported as a string variable.`);
    return { ...base, type: 'STRING', value: String(v.value) };
  }
  if (v.type === 'number') {
    const n = parseFloat(String(v.value));
    if (Number.isFinite(n)) return { ...base, type: 'FLOAT', value: n };
  }
  return { ...base, type: 'STRING', value: String(v.value) };
}

/**
 * Build the export for some nodes (default: every top-level layer of the page).
 * Nested selections are reduced to their outermost nodes.
 */
export function buildFigmaExport(doc: DesignDoc, opts: { nodeIds?: string[]; pageId?: string; assetBase: string }): FigmaExport {
  const pageId = opts.pageId && doc.pages[opts.pageId] ? opts.pageId : doc.pageOrder[0];
  let ids = (opts.nodeIds ?? []).filter((id) => doc.nodes[id]);
  if (!ids.length) ids = [...(doc.pages[pageId]?.children ?? [])];
  const set = new Set(ids);
  const isNested = (id: string) => {
    let p = doc.nodes[id]?.parentId;
    while (p && doc.nodes[p]) {
      if (set.has(p)) return true;
      p = doc.nodes[p].parentId;
    }
    return false;
  };
  ids = ids.filter((id) => !isNested(id));

  const ctx: Ctx = {
    doc,
    vars: new Map(Object.values(doc.variables ?? {}).map((v) => [v.name, v])),
    assetBase: opts.assetBase,
    warnings: new Set(),
    fonts: new Map(),
    images: new Set(),
    components: {},
    wantedComponents: new Set(),
    stats: { nodes: 0, components: 0, instances: 0 },
  };

  const roots = ids.map((id) => {
    const n = doc.nodes[id];
    const parent = doc.nodes[n.parentId] ?? null;
    const spec = nodeSpec(ctx, n, null);
    // Roots are placed on the Figma page: use page coordinates.
    const abs = absolutePosition(doc, id);
    spec.x = abs.x;
    spec.y = abs.y;
    if (parent) {
      spec.inFlow = false;
      spec.absolute = false;
    }
    return spec;
  });

  // Components used by instances but not part of the export go to a components page.
  for (let guard = 0; guard < 50; guard++) {
    const missing = [...ctx.wantedComponents].filter((k) => !ctx.components[k]);
    if (!missing.length) break;
    for (const k of missing) {
      const comp = doc.nodes[k];
      const spec = nodeSpec(ctx, comp, null);
      const abs = absolutePosition(doc, k);
      ctx.components[k] = { ...spec, x: abs.x, y: abs.y, inFlow: false, absolute: false, external: true };
    }
  }

  return {
    format: FIGMA_FORMAT,
    docId: doc.id,
    docName: doc.name,
    pageName: doc.pages[pageId]?.name ?? 'Page',
    exportedAt: Date.now(),
    variables: Object.values(doc.variables ?? {}).map((v) => variableSpec(ctx, v)),
    components: ctx.components,
    roots,
    fonts: [...ctx.fonts.values()],
    images: [...ctx.images],
    warnings: [...ctx.warnings],
    stats: { ...ctx.stats, variables: Object.keys(doc.variables ?? {}).length },
  };
}

/** Page coordinates of a node (sum of ancestor offsets; good for top-level placement). */
function absolutePosition(doc: DesignDoc, id: string): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let n: SceneNode | undefined = doc.nodes[id];
  while (n) {
    x += n.x;
    y += n.y;
    n = doc.nodes[n.parentId];
  }
  return { x, y };
}
