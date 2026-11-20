/**
 * LLM- and human-friendly input normalization. Accepts many common
 * shorthands (CSS-ish names, Figma API names) and converts them to the
 * canonical document model.
 */
import type {
  Align,
  AutoLayout,
  Justify,
  LayoutMode,
  Num,
  Paint,
  SceneNode,
  Shadow,
  SizeMode,
  Stroke,
} from './types.ts';

export type NodeSpec = Record<string, any> & { children?: NodeSpec[] };

const TYPE_ALIASES: Record<string, SceneNode['type']> = {
  frame: 'frame',
  group: 'frame',
  div: 'frame',
  container: 'frame',
  box: 'frame',
  stack: 'frame',
  section: 'frame',
  component: 'component',
  instance: 'instance',
  rect: 'rect',
  rectangle: 'rect',
  ellipse: 'ellipse',
  circle: 'ellipse',
  oval: 'ellipse',
  text: 'text',
  label: 'text',
  image: 'image',
  img: 'image',
  svg: 'svg',
  vector: 'svg',
  icon: 'svg',
};

export function normalizeType(t: unknown): SceneNode['type'] | null {
  if (typeof t !== 'string') return null;
  return TYPE_ALIASES[t.toLowerCase()] ?? null;
}

const WEIGHTS: Record<string, number> = {
  thin: 100,
  hairline: 100,
  extralight: 200,
  'extra-light': 200,
  ultralight: 200,
  light: 300,
  normal: 400,
  regular: 400,
  medium: 500,
  semibold: 600,
  'semi-bold': 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  'extra-bold': 800,
  heavy: 800,
  black: 900,
};

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = v.trim().match(/^(-?\d+(?:\.\d+)?)(px)?$/);
    if (m) return parseFloat(m[1]);
  }
  return undefined;
}

/** number | "$token" | "12px" */
function numOrToken(v: unknown): Num | undefined {
  if (typeof v === 'string' && v.startsWith('$')) return v;
  if (typeof v === 'string' && v.startsWith('var(--')) return '$' + v.slice(6, -1);
  return num(v);
}

function colorStr(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (s.startsWith('var(--')) return '$' + s.slice(6, s.indexOf(')'));
  return s;
}

export function toPaint(v: unknown): Paint | null {
  if (!v) return null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === 'none' || s === 'transparent') return null;
    const lg = s.match(/^linear-gradient\((.*)\)$/i);
    if (lg) return parseCssGradient(lg[1]);
    if (/^url\(/i.test(s)) return { type: 'image', src: s.replace(/^url\(["']?|["']?\)$/g, ''), fit: 'cover' };
    return { type: 'solid', color: colorStr(s)! };
  }
  if (typeof v === 'object') {
    const o = v as any;
    const t = (o.type ?? '').toString().toLowerCase();
    if (t === 'solid' || (!t && o.color)) return { type: 'solid', color: colorStr(o.color) ?? '#000000', ...(o.visible === false ? { visible: false } : {}) };
    if (t.includes('gradient') || o.stops || o.gradientStops) {
      const stops = (o.stops ?? o.gradientStops ?? []).map((st: any, i: number, arr: any[]) => ({
        color: colorStr(st.color) ?? '#000000',
        position: typeof st.position === 'number' ? (st.position > 1 ? st.position / 100 : st.position) : arr.length > 1 ? i / (arr.length - 1) : 0,
      }));
      return { type: 'gradient', kind: t.includes('radial') || o.kind === 'radial' ? 'radial' : 'linear', angle: num(o.angle) ?? 180, stops };
    }
    if (t === 'image' || o.src || o.url) return { type: 'image', src: o.src ?? o.url, fit: o.fit ?? o.scaleMode?.toLowerCase?.() ?? 'cover' };
  }
  return null;
}

function parseCssGradient(body: string): Paint {
  const parts = splitTopLevel(body);
  let angle = 180;
  if (parts.length && /deg$|^to /.test(parts[0].trim())) {
    const a = parts.shift()!.trim();
    if (a.endsWith('deg')) angle = parseFloat(a);
    else {
      const dirs: Record<string, number> = { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270, 'to top right': 45, 'to bottom right': 135, 'to bottom left': 225, 'to top left': 315 };
      angle = dirs[a] ?? 180;
    }
  }
  const stops = parts.map((p, i) => {
    const m = p.trim().match(/^(.*?)(?:\s+(-?\d+(?:\.\d+)?)%)?$/);
    const col = (m?.[1] ?? p).trim();
    const pos = m?.[2] !== undefined ? parseFloat(m[2]) / 100 : parts.length > 1 ? i / (parts.length - 1) : 0;
    return { color: colorStr(col)!, position: pos };
  });
  return { type: 'gradient', kind: 'linear', angle, stops };
}

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

export function toFills(v: unknown): Paint[] | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === 'none' || v === false) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.map(toPaint).filter((p): p is Paint => !!p);
}

export function toStroke(v: unknown): Stroke | undefined | null {
  if (v === undefined) return undefined;
  if (v === null || v === 'none' || v === false) return null;
  if (typeof v === 'string') {
    // "1px solid #ccc" or "#ccc"
    const parts = splitTopLevel(v.replace(/\s+/g, ' ')).join(',').split(' ');
    let width = 1;
    let style: Stroke['style'] = 'solid';
    let col = '#000000';
    for (const p of parts) {
      if (/^\d+(\.\d+)?(px)?$/.test(p)) width = parseFloat(p);
      else if (p === 'solid' || p === 'dashed' || p === 'dotted') style = p;
      else if (p) col = colorStr(p)!;
    }
    return { color: col, width, style, align: 'inside' };
  }
  if (typeof v === 'object') {
    const o = v as any;
    const c = o.color ?? (Array.isArray(o.paints) ? o.paints[0]?.color : undefined) ?? '#000000';
    return {
      color: colorStr(c)!,
      width: num(o.width ?? o.weight ?? o.strokeWeight) ?? 1,
      style: o.style ?? (o.dashed ? 'dashed' : 'solid'),
      align: (o.align ?? o.strokeAlign ?? 'inside').toString().toLowerCase(),
    };
  }
  return undefined;
}

function parseCssShadow(s: string): Shadow[] {
  return splitTopLevel(s).map((part) => {
    const p = part.trim();
    const inset = /\binset\b/.test(p);
    const body = p.replace(/\binset\b/, '').trim();
    const colorMatch = body.match(/(rgba?\([^)]*\)|hsla?\([^)]*\)|#[0-9a-fA-F]{3,8}|var\([^)]*\)|\$[\w-]+|\b[a-z]+\b)\s*$/);
    const col = colorMatch ? colorMatch[1] : 'rgba(0,0,0,0.25)';
    const nums = (colorMatch ? body.slice(0, colorMatch.index) : body).trim().split(/\s+/).map((x) => parseFloat(x) || 0);
    return { type: inset ? 'inner' : 'drop', x: nums[0] ?? 0, y: nums[1] ?? 0, blur: nums[2] ?? 0, spread: nums[3] ?? 0, color: colorStr(col)! };
  });
}

function isNoopShadow(s: Shadow): boolean {
  const c = String(s.color).replace(/\s+/g, '').toLowerCase();
  const transparent = c === 'transparent' || /^#[0-9a-f]{6}00$/.test(c) || /^#[0-9a-f]{3}0$/.test(c) || /rgba\([^)]*,0(\.0*)?\)$/.test(c);
  return transparent || (!s.x && !s.y && !s.blur && !s.spread);
}

export function toShadows(v: unknown): Shadow[] | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === 'none' || v === false) return [];
  if (typeof v === 'string') return parseCssShadow(v).filter((s) => !isNoopShadow(s));
  const arr = Array.isArray(v) ? v : [v];
  return arr.map((o: any) => {
    if (typeof o === 'string') return parseCssShadow(o)[0];
    const t = (o.type ?? 'drop').toString().toLowerCase();
    return {
      type: t.includes('inner') || o.inset ? 'inner' : 'drop',
      x: num(o.x ?? o.offsetX ?? o.offset?.x) ?? 0,
      y: num(o.y ?? o.offsetY ?? o.offset?.y) ?? 4,
      blur: num(o.blur ?? o.radius) ?? 8,
      spread: num(o.spread) ?? 0,
      color: colorStr(o.color) ?? 'rgba(0,0,0,0.15)',
      ...(o.visible === false ? { visible: false } : {}),
    } as Shadow;
  });
}

export function toPadding(v: unknown): [Num, Num, Num, Num] | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'object' && !Array.isArray(v)) {
    const o = v as any;
    const x = numOrToken(o.x ?? o.horizontal);
    const y = numOrToken(o.y ?? o.vertical);
    return [
      numOrToken(o.top) ?? y ?? 0,
      numOrToken(o.right) ?? x ?? 0,
      numOrToken(o.bottom) ?? y ?? 0,
      numOrToken(o.left) ?? x ?? 0,
    ];
  }
  if (typeof v === 'string' && !v.startsWith('$') && v.includes(' ')) return toPadding(v.trim().split(/\s+/));
  const arr = (Array.isArray(v) ? v : [v]).map(numOrToken).map((x) => x ?? 0);
  if (arr.length === 1) return [arr[0], arr[0], arr[0], arr[0]];
  if (arr.length === 2) return [arr[0], arr[1], arr[0], arr[1]];
  if (arr.length === 3) return [arr[0], arr[1], arr[2], arr[1]];
  return [arr[0], arr[1], arr[2], arr[3]];
}

function toLayoutMode(v: unknown): LayoutMode | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.toLowerCase();
  if (['row', 'horizontal', 'x', 'hstack', 'flex-row'].includes(s)) return 'row';
  if (['column', 'col', 'vertical', 'y', 'vstack', 'flex-col'].includes(s)) return 'column';
  if (['none', 'absolute', 'free'].includes(s)) return 'none';
  return undefined;
}

function toJustify(v: unknown): Justify | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.toLowerCase().replace('flex-', '');
  if (s === 'min' || s === 'start' || s === 'left' || s === 'top') return 'start';
  if (s === 'center' || s === 'middle') return 'center';
  if (s === 'max' || s === 'end' || s === 'right' || s === 'bottom') return 'end';
  if (s.includes('between')) return 'space-between';
  return undefined;
}

function toAlign(v: unknown): Align | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.toLowerCase().replace('flex-', '');
  if (s === 'stretch') return 'stretch';
  if (s === 'baseline') return 'baseline';
  const j = toJustify(s);
  return j && j !== 'space-between' ? j : undefined;
}

export function toLayout(v: unknown, prev?: AutoLayout, flat?: Record<string, any>): AutoLayout | undefined {
  let out: AutoLayout | undefined = prev ? { ...prev } : undefined;
  const ensure = () => (out ??= { mode: 'column' });
  if (typeof v === 'string') {
    const m = toLayoutMode(v);
    if (m) ensure().mode = m;
  } else if (v && typeof v === 'object') {
    const o = v as any;
    const m = toLayoutMode(o.mode ?? o.direction ?? o.layoutMode ?? o.flexDirection);
    ensure();
    if (m) out!.mode = m;
    else if (!prev) out!.mode = 'column';
    const gap = numOrToken(o.gap ?? o.spacing ?? o.itemSpacing);
    if (gap !== undefined) out!.gap = gap;
    const pad = toPadding(o.padding);
    if (pad) out!.padding = pad;
    const j = toJustify(o.justify ?? o.justifyContent ?? o.primaryAxisAlignItems ?? o.distribute);
    if (j) out!.justify = j;
    const a = toAlign(o.align ?? o.alignItems ?? o.counterAxisAlignItems);
    if (a) out!.align = a;
    if (o.wrap !== undefined) out!.wrap = !!o.wrap;
  } else if (v === null || v === false) {
    out = prev ? { ...prev, mode: 'none' } : undefined;
  }
  // Flat CSS-like props on the node itself.
  if (flat) {
    const m = toLayoutMode(flat.direction ?? flat.flexDirection ?? flat.layoutMode);
    if (m) ensure().mode = m;
    const gap = numOrToken(flat.gap ?? flat.itemSpacing);
    if (gap !== undefined) ensure().gap = gap;
    const pad = toPadding(flat.padding);
    if (pad) ensure().padding = pad;
    for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
      const val = numOrToken(flat['padding' + side]);
      if (val !== undefined) {
        const l = ensure();
        const p = [...(l.padding ?? [0, 0, 0, 0])] as [Num, Num, Num, Num];
        p[['Top', 'Right', 'Bottom', 'Left'].indexOf(side)] = val;
        l.padding = p;
      }
    }
    const j = toJustify(flat.justify ?? flat.justifyContent);
    if (j) ensure().justify = j;
    const a = toAlign(flat.align ?? flat.alignItems);
    if (a) ensure().align = a;
    if (flat.wrap !== undefined) ensure().wrap = !!flat.wrap;
  }
  return out;
}

function toSizeMode(v: unknown): SizeMode | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.toLowerCase();
  if (['fill', 'fill-container', '100%', 'stretch', 'full'].includes(s)) return 'fill';
  if (['hug', 'auto', 'hug-contents', 'fit', 'fit-content'].includes(s)) return 'hug';
  if (s === 'fixed') return 'fixed';
  return undefined;
}

const PASSTHROUGH_NUM = ['x', 'y', 'rotation', 'opacity', 'blur', 'backdropBlur', 'letterSpacing', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight'] as const;

/**
 * Convert an input spec (create or update) into canonical props.
 * `existing` is used for merging layouts on update.
 */
export function normalizeProps(input: Record<string, any>, existing?: SceneNode, warnings: string[] = []): Partial<SceneNode> & Record<string, any> {
  const out: Record<string, any> = {};
  const type = normalizeType(input.type) ?? existing?.type;
  if (input.name !== undefined) out.name = String(input.name);

  for (const k of PASSTHROUGH_NUM) {
    if (input[k] === null) {
      out[k] = undefined;
      continue;
    }
    if (input[k] !== undefined) {
      const v = num(input[k]);
      if (v === undefined) warnings.push(`Ignored non-numeric ${k}: ${JSON.stringify(input[k])}`);
      else out[k] = v;
    }
  }
  if (out.opacity !== undefined && out.opacity > 1) out.opacity = out.opacity / 100;

  // width / height (number, "fill", "hug", "100%")
  for (const [dim, modeKey] of [
    ['width', 'widthMode'],
    ['height', 'heightMode'],
  ] as const) {
    const raw = input[dim];
    if (raw !== undefined) {
      const n = num(raw);
      if (n !== undefined) {
        out[dim] = n;
        if (input[modeKey] === undefined && (existing || type !== 'text' || dim === 'width')) out[modeKey] = 'fixed';
      } else {
        const m = toSizeMode(raw);
        if (m) out[modeKey] = m;
        else warnings.push(`Ignored ${dim}: ${JSON.stringify(raw)}`);
      }
    }
    const mRaw = input[modeKey] ?? input[dim === 'width' ? 'layoutSizingHorizontal' : 'layoutSizingVertical'];
    if (mRaw !== undefined) {
      const m = toSizeMode(mRaw);
      if (m) out[modeKey] = m;
    }
  }
  if (input.position !== undefined) out.position = input.position === 'absolute' ? 'absolute' : 'auto';
  if (input.visible !== undefined) out.visible = !!input.visible;
  if (input.hidden !== undefined) out.visible = !input.hidden;
  if (input.locked !== undefined) out.locked = !!input.locked;
  if (input.description !== undefined) out.description = String(input.description);
  if (input.blendMode !== undefined) out.blendMode = String(input.blendMode).toLowerCase().replace('_', '-');

  // Fills
  const fillInput = input.fills ?? input.fill ?? input.background ?? input.backgroundColor ?? input.bg;
  if (type === 'text') {
    const c = input.color ?? input.textColor ?? fillInput;
    if (c !== undefined) out.fills = toFills(c);
  } else if (fillInput !== undefined) out.fills = toFills(fillInput);

  const stroke = toStroke(input.stroke ?? input.border ?? input.strokes?.[0]);
  if (stroke !== undefined) out.stroke = stroke === null ? undefined : stroke;
  if (input.strokeWidth !== undefined || input.strokeWeight !== undefined) {
    const w = num(input.strokeWidth ?? input.strokeWeight) ?? 1;
    out.stroke = { ...(out.stroke ?? existing?.stroke ?? { color: '#000000' }), width: w };
  }

  const radius = input.radius ?? input.cornerRadius ?? input.borderRadius;
  if (radius !== undefined) {
    if (Array.isArray(radius)) out.radius = radius.map((r) => numOrToken(r) ?? 0);
    else if (typeof radius === 'object' && radius) {
      out.radius = [radius.topLeft ?? 0, radius.topRight ?? 0, radius.bottomRight ?? 0, radius.bottomLeft ?? 0].map((r) => numOrToken(r) ?? 0);
    } else out.radius = numOrToken(radius) ?? 0;
  }
  const shadows = toShadows(input.shadows ?? input.shadow ?? input.boxShadow ?? input.effects?.filter?.((e: any) => /shadow/i.test(e.type)));
  if (shadows !== undefined) out.shadows = shadows;

  // Frames / components
  if (type === 'frame' || type === 'component') {
    const hasFlat = ['direction', 'flexDirection', 'layoutMode', 'gap', 'itemSpacing', 'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'justify', 'justifyContent', 'align', 'alignItems', 'wrap'].some(
      (k) => input[k] !== undefined,
    );
    const prev = existing && (existing as any).layout;
    if (input.layout !== undefined || input.autoLayout !== undefined || hasFlat) {
      const l = toLayout(input.layout ?? input.autoLayout, prev, hasFlat ? input : undefined);
      out.layout = l;
    }
    const clip = input.clip ?? input.clipContent ?? input.clipsContent ?? (input.overflow === 'hidden' ? true : undefined);
    if (clip !== undefined) out.clip = !!clip;
    if (input.codeConnect !== undefined) out.codeConnect = input.codeConnect || undefined;
  }

  if (type === 'text') {
    const t = input.text ?? input.content ?? input.characters ?? input.value;
    if (t !== undefined) out.text = String(t);
    const fam = input.fontFamily ?? input.font ?? input.fontName?.family;
    if (fam !== undefined) out.fontFamily = String(fam).replace(/^["']|["']$/g, '').split(',')[0].trim().replace(/^["']|["']$/g, '');
    const fs = numOrToken(input.fontSize ?? input.size);
    if (fs !== undefined) out.fontSize = fs;
    const fw = input.fontWeight ?? input.weight ?? input.fontName?.style;
    if (fw !== undefined) {
      const n = num(fw);
      if (n !== undefined) out.fontWeight = n;
      else {
        const key = String(fw).toLowerCase().replace(/\s+/g, '').replace('italic', '');
        out.fontWeight = WEIGHTS[key] ?? 400;
        if (/italic/i.test(String(fw))) out.italic = true;
      }
    }
    if (input.italic !== undefined) out.italic = !!input.italic;
    if (input.fontStyle !== undefined) out.italic = input.fontStyle === 'italic';
    const lh = input.lineHeight;
    if (lh !== undefined) {
      if (lh === 'auto' || lh === 'normal' || lh === null) out.lineHeight = undefined;
      else if (typeof lh === 'number') out.lineHeight = lh <= 4 ? `${Math.round(lh * 100)}%` : lh;
      else if (typeof lh === 'object' && lh.value !== undefined) out.lineHeight = lh.unit === 'PERCENT' ? `${lh.value}%` : lh.value;
      else out.lineHeight = String(lh).startsWith('$') || String(lh).endsWith('%') ? String(lh) : num(lh) ?? String(lh);
    }
    const ta = input.textAlign ?? input.textAlignHorizontal;
    if (ta !== undefined) out.textAlign = String(ta).toLowerCase();
    if (input.textDecoration !== undefined) out.textDecoration = String(input.textDecoration).toLowerCase().replace('strikethrough', 'line-through');
    if (input.textTransform !== undefined || input.textCase !== undefined) {
      const tt = String(input.textTransform ?? input.textCase).toLowerCase();
      out.textTransform = tt === 'upper' ? 'uppercase' : tt === 'lower' ? 'lowercase' : tt === 'title' ? 'capitalize' : tt;
    }
  }

  if (type === 'image') {
    const src = input.src ?? input.url ?? input.imageUrl;
    if (src !== undefined) out.src = String(src);
    if (input.fit !== undefined || input.objectFit !== undefined) out.fit = String(input.fit ?? input.objectFit);
    if (input.alt !== undefined) out.alt = String(input.alt);
  }
  if (type === 'svg') {
    const svg = input.svg ?? input.markup ?? input.content;
    if (svg !== undefined) out.svg = String(svg);
  }
  if (type === 'instance') {
    if (input.componentId !== undefined) out.componentId = String(input.componentId);
    if (input.overrides !== undefined) out.overrides = input.overrides;
  }
  return out;
}

/** Default props for a freshly created node of a type. */
export function defaultsFor(type: SceneNode['type'], topLevel: boolean): Record<string, any> {
  switch (type) {
    case 'frame':
    case 'component':
      return { width: 100, height: 100, children: [], fills: topLevel ? [{ type: 'solid', color: '#FFFFFF' }] : [] };
    case 'rect':
    case 'ellipse':
      return { width: 100, height: 100, fills: [{ type: 'solid', color: '#D9D9D9' }] };
    case 'text':
      return { width: 0, height: 0, text: 'Text', fontFamily: 'Inter', fontSize: 16, widthMode: 'hug', heightMode: 'hug', fills: [{ type: 'solid', color: '#000000' }] };
    case 'image':
      return { width: 240, height: 160, src: '', fit: 'cover' };
    case 'svg':
      return { width: 24, height: 24, svg: '' };
    case 'instance':
      return { width: 100, height: 100 };
  }
}
