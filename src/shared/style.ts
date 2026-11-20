import type { Color, DesignDoc, FrameNode, Num, Paint, SceneNode, Shadow, SizeMode, TextNode, Variable } from './types.ts';
import { isFrameLike } from './doc.ts';

/** camelCase CSS declarations with string values. */
export type CSSMap = Record<string, string>;

export const DEFAULT_FONT = 'Inter';
export const DEFAULT_FONT_SIZE = 16;
export const DEFAULT_TEXT_COLOR = '#000000';

const SERIF = /serif|georgia|times|playfair|merriweather|lora|garamond|crimson|libre baskerville/i;
const MONO = /mono|code|courier|menlo|consolas/i;

export function isTokenRef(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('$') && v.length > 1;
}

export function tokenName(v: string): string {
  return v.slice(1);
}

export function cssVar(name: string): string {
  return `var(--${name})`;
}

export function px(v: Num | undefined): string {
  if (v === undefined || v === null) return '0px';
  if (typeof v === 'number') return `${round(v)}px`;
  if (isTokenRef(v)) return cssVar(tokenName(v));
  if (/^-?\d+(\.\d+)?$/.test(v)) return `${v}px`;
  return v;
}

export function color(v: Color | undefined): string {
  if (!v) return 'transparent';
  if (isTokenRef(v)) return cssVar(tokenName(v));
  return v;
}

export function round(n: number, p = 2): number {
  const f = Math.pow(10, p);
  return Math.round(n * f) / f;
}

export function defaultSizeMode(node: SceneNode, axis: 'w' | 'h'): SizeMode {
  if (node.type === 'text') return 'hug';
  return 'fixed';
}

export function sizeMode(node: SceneNode, axis: 'w' | 'h'): SizeMode {
  return (axis === 'w' ? node.widthMode : node.heightMode) ?? defaultSizeMode(node, axis);
}

export function fontStack(family: string | undefined): string {
  const f: string = family || DEFAULT_FONT;
  if (f.startsWith('$') && f.length > 1) return cssVar(tokenName(f));
  if (f.includes(',')) return f;
  const generic = ['sans-serif', 'serif', 'monospace', 'system-ui', 'cursive'];
  if (generic.includes(f)) return f;
  const fallback = MONO.test(f) ? 'monospace' : SERIF.test(f) ? 'serif' : 'sans-serif';
  return `"${f}", ${fallback}`;
}

const JUSTIFY: Record<string, string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  'space-between': 'space-between',
};
const ALIGN: Record<string, string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  stretch: 'stretch',
  baseline: 'baseline',
};

export function paintToCss(p: Paint): string {
  if (p.type === 'solid') return `linear-gradient(${color(p.color)}, ${color(p.color)})`;
  if (p.type === 'gradient') {
    const stops = (p.stops ?? []).map((s) => `${color(s.color)} ${round(s.position * 100)}%`).join(', ');
    if (p.kind === 'radial') return `radial-gradient(circle, ${stops})`;
    return `linear-gradient(${p.angle ?? 180}deg, ${stops})`;
  }
  return `url("${p.src}")`;
}

export function fillsToCss(fills: Paint[] | undefined): CSSMap {
  const s: CSSMap = {};
  const visible = (fills ?? []).filter((f) => f.visible !== false);
  if (!visible.length) return s;
  if (visible.length === 1 && visible[0].type === 'solid') {
    s.backgroundColor = color(visible[0].color);
    return s;
  }
  // CSS stacks backgrounds first-on-top; our fills are bottom-to-top.
  const layers = [...visible].reverse();
  const last = layers[layers.length - 1];
  if (last.type === 'solid' && layers.length > 1) {
    // Bottom solid layer can be the background-color.
    s.backgroundColor = color(last.color);
    layers.pop();
  }
  if (layers.length) {
    s.backgroundImage = layers.map(paintToCss).join(', ');
    const hasImage = layers.some((l) => l.type === 'image');
    if (hasImage) {
      s.backgroundSize = layers
        .map((l) => (l.type === 'image' ? (l.fit === 'contain' ? 'contain' : l.fit === 'fill' ? '100% 100%' : 'cover') : 'auto'))
        .join(', ');
      s.backgroundPosition = 'center';
      s.backgroundRepeat = 'no-repeat';
    }
  }
  return s;
}

export function shadowToCss(sh: Shadow, text = false): string {
  if (text) return `${round(sh.x)}px ${round(sh.y)}px ${round(sh.blur)}px ${color(sh.color)}`;
  return `${sh.type === 'inner' ? 'inset ' : ''}${round(sh.x)}px ${round(sh.y)}px ${round(sh.blur)}px ${round(sh.spread ?? 0)}px ${color(sh.color)}`;
}

export function radiusToCss(r: FrameNode['radius']): string | undefined {
  if (r === undefined || r === null) return undefined;
  if (Array.isArray(r)) {
    if (r.every((v) => v === r[0])) return r[0] === 0 ? undefined : px(r[0]);
    return r.map((v) => px(v)).join(' ');
  }
  if (r === 0) return undefined;
  return px(r);
}

export function paddingToCss(p: [Num, Num, Num, Num] | undefined): string | undefined {
  if (!p) return undefined;
  const [t, r, b, l] = p.map((v) => px(v));
  if ([t, r, b, l].every((v) => v === '0px')) return undefined;
  if (t === b && r === l) return t === r ? t : `${t} ${r}`;
  return `${t} ${r} ${b} ${l}`;
}

export interface StyleContext {
  /** The parent node (null for top-level nodes / export root). */
  parent: SceneNode | null;
  /** Export root: positioned relatively instead of absolutely. */
  isRoot?: boolean;
  /** Editor rendering (adds a few editor-only tweaks). */
  editor?: boolean;
}

/** The single source of truth for how a node looks. */
export function nodeStyle(node: SceneNode, ctx: StyleContext): CSSMap {
  const s: CSSMap = {};
  const parent = ctx.parent;
  const pl = parent && isFrameLike(parent) && parent.layout && parent.layout.mode !== 'none' ? parent.layout : null;
  const inFlow = !ctx.isRoot && !!pl && node.position !== 'absolute';
  const row = pl?.mode === 'row';

  s.boxSizing = 'border-box';
  if (ctx.isRoot) s.position = 'relative';
  else if (inFlow) {
    s.position = 'relative';
    s.flexShrink = '0';
  } else {
    s.position = 'absolute';
    s.left = px(node.x);
    s.top = px(node.y);
  }

  const wm = sizeMode(node, 'w');
  const hm = sizeMode(node, 'h');
  const isText = node.type === 'text';
  const isLayoutFrame = isFrameLike(node) && !!node.layout && node.layout.mode !== 'none';
  const isInstance = node.type === 'instance';

  const applySize = (dim: 'width' | 'height', mode: SizeMode, value: number) => {
    const minKey = dim === 'width' ? 'minWidth' : 'minHeight';
    const canHug = isText || isLayoutFrame || isInstance;
    if (mode === 'fill' && inFlow) {
      const main = (dim === 'width') === row;
      if (main) {
        s.flex = '1 1 0px';
        s[minKey] = '0px';
      } else {
        s.alignSelf = 'stretch';
      }
      return;
    }
    if (mode === 'hug' && canHug) return; // auto
    s[dim] = px(value);
  };
  applySize('width', wm, node.width);
  applySize('height', hm, node.height);
  if (node.minWidth !== undefined) s.minWidth = px(node.minWidth);
  if (node.maxWidth !== undefined) s.maxWidth = px(node.maxWidth);
  if (node.minHeight !== undefined) s.minHeight = px(node.minHeight);
  if (node.maxHeight !== undefined) s.maxHeight = px(node.maxHeight);

  if (isFrameLike(node)) {
    const l = node.layout;
    if (l && l.mode !== 'none') {
      s.display = 'flex';
      s.flexDirection = l.mode === 'column' ? 'column' : 'row';
      if (l.wrap) s.flexWrap = 'wrap';
      if (l.gap !== undefined && l.gap !== 0) s.gap = px(l.gap);
      const pad = paddingToCss(l.padding);
      if (pad) s.padding = pad;
      s.justifyContent = JUSTIFY[l.justify ?? 'start'];
      s.alignItems = ALIGN[l.align ?? 'start'];
    }
    if (node.clip) s.overflow = 'hidden';
  }

  if (isText) Object.assign(s, textStyle(node as TextNode, wm));
  else Object.assign(s, fillsToCss(node.fills));

  if (node.stroke && node.stroke.width > 0) {
    const st = node.stroke;
    s.outline = `${round(st.width)}px ${st.style ?? 'solid'} ${color(st.color)}`;
    const align = st.align ?? 'inside';
    const off = align === 'inside' ? -st.width : align === 'center' ? -st.width / 2 : 0;
    if (off !== 0) s.outlineOffset = `${round(off)}px`;
  }

  if (node.type === 'ellipse') s.borderRadius = '50%';
  else {
    const r = radiusToCss(node.radius);
    if (r) s.borderRadius = r;
  }

  const shadows = (node.shadows ?? []).filter((x) => x.visible !== false);
  if (shadows.length) {
    if (isText) s.textShadow = shadows.map((x) => shadowToCss(x, true)).join(', ');
    else s.boxShadow = shadows.map((x) => shadowToCss(x)).join(', ');
  }
  if (node.opacity !== undefined && node.opacity < 1) s.opacity = String(round(node.opacity, 3));
  if (node.rotation) s.transform = `rotate(${round(node.rotation)}deg)`;
  if (node.blur) s.filter = `blur(${round(node.blur)}px)`;
  if (node.backdropBlur) s.backdropFilter = `blur(${round(node.backdropBlur)}px)`;
  if (node.blendMode && node.blendMode !== 'normal') s.mixBlendMode = node.blendMode;
  if (node.type === 'image') s.objectFit = (node as any).fit ?? 'cover';
  if (node.visible === false) s.display = 'none';
  return s;
}

export function textStyle(node: TextNode, wm: SizeMode): CSSMap {
  const s: CSSMap = {};
  s.fontFamily = fontStack(node.fontFamily);
  s.fontSize = px(node.fontSize ?? DEFAULT_FONT_SIZE);
  if (node.fontWeight && node.fontWeight !== 400) s.fontWeight = String(node.fontWeight);
  if (node.italic) s.fontStyle = 'italic';
  if (node.lineHeight !== undefined && node.lineHeight !== 'auto') s.lineHeight = px(node.lineHeight);
  if (node.letterSpacing) s.letterSpacing = `${round(node.letterSpacing)}px`;
  if (node.textAlign && node.textAlign !== 'left') s.textAlign = node.textAlign;
  if (node.textDecoration && node.textDecoration !== 'none') s.textDecoration = node.textDecoration;
  if (node.textTransform && node.textTransform !== 'none') s.textTransform = node.textTransform;
  const fills = (node.fills ?? []).filter((f) => f.visible !== false);
  const solid = fills.find((f) => f.type === 'solid');
  const grad = fills.find((f) => f.type === 'gradient');
  if (grad && !solid) {
    s.backgroundImage = paintToCss(grad);
    s.backgroundClip = 'text';
    s.WebkitBackgroundClip = 'text';
    s.color = 'transparent';
  } else {
    s.color = color(solid && solid.type === 'solid' ? solid.color : fills.length ? undefined : DEFAULT_TEXT_COLOR);
  }
  s.whiteSpace = wm === 'hug' ? 'pre' : 'pre-wrap';
  if (wm !== 'hug') s.overflowWrap = 'break-word';
  s.margin = '0px';
  return s;
}

export function variablesToCss(vars: Record<string, Variable>, selector = ':root'): string {
  const lines = Object.values(vars)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((v) => `  --${v.name}: ${variableCssValue(v)};`);
  if (!lines.length) return '';
  return `${selector} {\n${lines.join('\n')}\n}`;
}

export function variableCssValue(v: Variable): string {
  if (v.type === 'number') return typeof v.value === 'number' ? `${v.value}px` : String(v.value);
  return String(v.value);
}

export function variablesStyleMap(vars: Record<string, Variable>): CSSMap {
  const s: CSSMap = {};
  for (const v of Object.values(vars)) s[`--${v.name}`] = variableCssValue(v);
  return s;
}

/** Resolve a color that might be a token into a concrete value (best effort). */
export function resolveColor(doc: DesignDoc, c: Color | undefined): string | undefined {
  if (!c) return c;
  if (!isTokenRef(c)) return c;
  const name = tokenName(c);
  const v = Object.values(doc.variables).find((x) => x.name === name);
  return v ? String(v.value) : undefined;
}

export function camelToKebab(k: string): string {
  if (k.startsWith('--')) return k;
  if (k.startsWith('Webkit')) return '-webkit-' + camelToKebab(k.slice(6)).replace(/^-/, '');
  return k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
}

export function cssMapToText(s: CSSMap, indent = '  '): string {
  return Object.entries(s)
    .map(([k, v]) => `${indent}${camelToKebab(k)}: ${v};`)
    .join('\n');
}
