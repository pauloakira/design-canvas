/**
 * Design → code. Uses the same `nodeStyle()` as the canvas renderer, so the
 * generated code renders exactly like the design.
 */
import type { DesignDoc, FrameNode, ImageNode, SceneNode, SvgNode, TextNode } from './types.ts';
import { buildRenderTree, type RenderNode } from './tree.ts';
import { camelToKebab, cssMapToText, nodeStyle, sizeMode, variableCssValue, type CSSMap } from './style.ts';
import { isFrameLike } from './doc.ts';

export type Framework = 'react-tailwind' | 'html' | 'react-css';

export interface CodegenOptions {
  framework: Framework;
  /** Add data-name attributes and instance comments (useful for LLMs). */
  annotate?: boolean;
  /** Prefix for relative asset URLs (e.g. http://localhost:4410). */
  assetBase?: string;
}

export interface CodegenResult {
  code: string;
  componentName: string;
  tokens: Array<{ name: string; value: string }>;
  tokensCss: string;
  fonts: string[];
  assets: string[];
  components: Array<{ id: string; name: string; codeConnect?: FrameNode['codeConnect'] }>;
  imports: string[];
}

export const GOOGLE_FONTS = [
  'Inter',
  'Roboto',
  'Open Sans',
  'Lato',
  'Montserrat',
  'Poppins',
  'Plus Jakarta Sans',
  'DM Sans',
  'Manrope',
  'Space Grotesk',
  'IBM Plex Sans',
  'IBM Plex Mono',
  'JetBrains Mono',
  'Geist',
  'Geist Mono',
  'Nunito',
  'Work Sans',
  'Outfit',
  'Raleway',
  'Rubik',
  'Sora',
  'Figtree',
  'Playfair Display',
  'Merriweather',
  'Source Serif 4',
  'Lora',
  'Fira Code',
  'Space Mono',
];

export function pascalCase(s: string): string {
  const out = s
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  if (!out) return 'Component';
  return /^[A-Za-z]/.test(out) ? out : 'C' + out;
}

export function kebabCase(s: string): string {
  const out = s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  if (!out) return 'el';
  return /^[a-z]/.test(out) ? out : 'el-' + out;
}

// ---------------------------------------------------------------------------
// Tailwind
// ---------------------------------------------------------------------------

const SPACING: Record<number, string> = {
  0: '0', 1: 'px', 2: '0.5', 4: '1', 6: '1.5', 8: '2', 10: '2.5', 12: '3', 14: '3.5', 16: '4', 20: '5', 24: '6', 28: '7',
  32: '8', 36: '9', 40: '10', 44: '11', 48: '12', 56: '14', 64: '16', 80: '20', 96: '24', 112: '28', 128: '32', 144: '36',
  160: '40', 176: '44', 192: '48', 208: '52', 224: '56', 240: '60', 256: '64', 288: '72', 320: '80', 384: '96',
};
const WEIGHT_CLASS: Record<string, string> = {
  '100': 'font-thin', '200': 'font-extralight', '300': 'font-light', '400': 'font-normal', '500': 'font-medium',
  '600': 'font-semibold', '700': 'font-bold', '800': 'font-extrabold', '900': 'font-black',
};
const OPACITY = new Set([0, 5, 10, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90, 95, 100]);

function arb(v: string): string {
  return v.replace(/\s*,\s*/g, ',').replace(/\s+/g, '_');
}

function spacing(prefix: string, v: string): string {
  const m = v.match(/^(-?\d+(?:\.\d+)?)px$/);
  if (m) {
    const n = parseFloat(m[1]);
    const key = SPACING[Math.abs(n)];
    if (key !== undefined) return `${n < 0 ? '-' : ''}${prefix}-${key}`;
  }
  return `${prefix}-[${arb(v)}]`;
}

function colorClass(prefix: string, v: string): string {
  if (v === 'transparent') return `${prefix}-transparent`;
  const lower = v.toLowerCase();
  if (lower === '#ffffff' || lower === '#fff' || lower === 'white') return `${prefix}-white`;
  if (lower === '#000000' || lower === '#000' || lower === 'black') return `${prefix}-black`;
  return `${prefix}-[${arb(v)}]`;
}

function boxValues(v: string): [string, string, string, string] {
  const p = v.trim().split(/\s+/);
  if (p.length === 1) return [p[0], p[0], p[0], p[0]];
  if (p.length === 2) return [p[0], p[1], p[0], p[1]];
  if (p.length === 3) return [p[0], p[1], p[2], p[1]];
  return [p[0], p[1], p[2], p[3]];
}

export function cssToTailwind(css: CSSMap): { classes: string[]; rest: CSSMap } {
  const c: string[] = [];
  const rest: CSSMap = {};
  for (const [k, v] of Object.entries(css)) {
    switch (k) {
      case 'boxSizing':
      case 'WebkitBackgroundClip':
        break;
      case 'margin':
        if (v !== '0px') c.push(spacing('m', v));
        break;
      case 'position':
        c.push(v);
        break;
      case 'left':
      case 'top':
      case 'right':
      case 'bottom':
        c.push(spacing(k, v));
        break;
      case 'width':
      case 'height': {
        const p = k === 'width' ? 'w' : 'h';
        if (v === '100%') c.push(`${p}-full`);
        else if (v === 'fit-content') c.push(`${p}-fit`);
        else if (v === 'max-content') c.push(`${p}-max`);
        else c.push(spacing(p, v));
        break;
      }
      case 'minWidth':
      case 'maxWidth':
      case 'minHeight':
      case 'maxHeight': {
        const p = { minWidth: 'min-w', maxWidth: 'max-w', minHeight: 'min-h', maxHeight: 'max-h' }[k];
        c.push(v === '0px' ? `${p}-0` : `${p}-[${arb(v)}]`);
        break;
      }
      case 'flex':
        c.push(v === '1 1 0px' ? 'flex-1' : `flex-[${arb(v)}]`);
        break;
      case 'flexShrink':
        c.push(v === '0' ? 'shrink-0' : `shrink-[${v}]`);
        break;
      case 'alignSelf':
        c.push(`self-${v.replace('flex-', '')}`);
        break;
      case 'display':
        c.push(v === 'none' ? 'hidden' : v);
        break;
      case 'flexDirection':
        if (v === 'column') c.push('flex-col');
        break;
      case 'flexWrap':
        c.push('flex-wrap');
        break;
      case 'gap':
        c.push(spacing('gap', v));
        break;
      case 'padding': {
        const [t, r, b, l] = boxValues(v);
        if (t === r && r === b && b === l) c.push(spacing('p', t));
        else if (t === b && r === l) c.push(spacing('px', r), spacing('py', t));
        else {
          if (t !== '0px') c.push(spacing('pt', t));
          if (r !== '0px') c.push(spacing('pr', r));
          if (b !== '0px') c.push(spacing('pb', b));
          if (l !== '0px') c.push(spacing('pl', l));
        }
        break;
      }
      case 'justifyContent':
        if (v === 'center') c.push('justify-center');
        else if (v === 'flex-end') c.push('justify-end');
        else if (v === 'space-between') c.push('justify-between');
        break;
      case 'alignItems':
        if (v === 'flex-start') c.push('items-start');
        else if (v === 'center') c.push('items-center');
        else if (v === 'flex-end') c.push('items-end');
        else if (v === 'baseline') c.push('items-baseline');
        break;
      case 'overflow':
        c.push(`overflow-${v}`);
        break;
      case 'backgroundColor':
        c.push(colorClass('bg', v));
        break;
      case 'backgroundSize':
        if (v === 'cover' || v === 'contain') c.push(`bg-${v}`);
        else rest[k] = v;
        break;
      case 'backgroundPosition':
        if (v === 'center') c.push('bg-center');
        else rest[k] = v;
        break;
      case 'backgroundRepeat':
        if (v === 'no-repeat') c.push('bg-no-repeat');
        else rest[k] = v;
        break;
      case 'backgroundClip':
        c.push(v === 'text' ? 'bg-clip-text' : `bg-clip-${v}`);
        break;
      case 'color':
        c.push(colorClass('text', v));
        break;
      case 'fontFamily': {
        const fam = v.split(',')[0].trim().replace(/"/g, '');
        c.push(`font-['${fam.replace(/\s+/g, '_')}']`);
        break;
      }
      case 'fontSize':
        c.push(v.startsWith('var(') ? `text-[length:${v}]` : `text-[${arb(v)}]`);
        break;
      case 'fontWeight':
        c.push(WEIGHT_CLASS[v] ?? `font-[${v}]`);
        break;
      case 'fontStyle':
        if (v === 'italic') c.push('italic');
        break;
      case 'lineHeight':
        c.push(`leading-[${arb(v)}]`);
        break;
      case 'letterSpacing':
        c.push(`tracking-[${arb(v)}]`);
        break;
      case 'textAlign':
        c.push(`text-${v}`);
        break;
      case 'textDecoration':
        c.push(v === 'underline' ? 'underline' : v === 'line-through' ? 'line-through' : `[text-decoration:${arb(v)}]`);
        break;
      case 'textTransform':
        c.push(v === 'capitalize' ? 'capitalize' : v);
        break;
      case 'whiteSpace':
        c.push(v === 'nowrap' ? 'whitespace-nowrap' : `whitespace-${v}`);
        break;
      case 'overflowWrap':
        if (v === 'break-word') c.push('break-words');
        break;
      case 'outline': {
        const [w, style, ...col] = v.split(' ');
        c.push('outline', `outline-[${w}]`);
        if (style === 'dashed') c.push('outline-dashed');
        if (style === 'dotted') c.push('outline-dotted');
        c.push(colorClass('outline', col.join(' ')));
        break;
      }
      case 'outlineOffset':
        c.push(`outline-offset-[${v}]`);
        break;
      case 'borderRadius': {
        if (v === '50%' || v === '9999px') c.push('rounded-full');
        else {
          const parts = v.split(/\s+/);
          if (parts.length === 1) c.push(`rounded-[${v}]`);
          else {
            const [tl, tr, br, bl] = boxValues(v);
            c.push(`rounded-tl-[${tl}]`, `rounded-tr-[${tr}]`, `rounded-br-[${br}]`, `rounded-bl-[${bl}]`);
          }
        }
        break;
      }
      case 'boxShadow':
        c.push(`shadow-[${arb(v)}]`);
        break;
      case 'opacity': {
        const pct = Math.round(parseFloat(v) * 100);
        c.push(OPACITY.has(pct) && Math.abs(parseFloat(v) * 100 - pct) < 0.01 ? `opacity-${pct}` : `opacity-[${v}]`);
        break;
      }
      case 'transform': {
        const m = v.match(/^rotate\((-?[\d.]+)deg\)$/);
        if (m) c.push(`${parseFloat(m[1]) < 0 ? '-' : ''}rotate-[${Math.abs(parseFloat(m[1]))}deg]`);
        else c.push(`[transform:${arb(v)}]`);
        break;
      }
      case 'filter': {
        const m = v.match(/^blur\((.+)\)$/);
        c.push(m ? `blur-[${m[1]}]` : `[filter:${arb(v)}]`);
        break;
      }
      case 'backdropFilter': {
        const m = v.match(/^blur\((.+)\)$/);
        c.push(m ? `backdrop-blur-[${m[1]}]` : `[backdrop-filter:${arb(v)}]`);
        break;
      }
      case 'mixBlendMode':
        c.push(`mix-blend-${v}`);
        break;
      case 'objectFit':
        c.push(`object-${v}`);
        break;
      case 'backgroundImage':
        rest[k] = v;
        break;
      default:
        if (/["'_]/.test(v)) rest[k] = v;
        else c.push(`[${camelToKebab(k)}:${arb(v)}]`);
    }
  }
  return { classes: c, rest };
}

// ---------------------------------------------------------------------------
// Tree → code
// ---------------------------------------------------------------------------

interface GenNode {
  rn: RenderNode;
  tag: string;
  css: CSSMap;
  className: string;
  children: GenNode[];
  text?: string;
}

function escapeJsxText(t: string): string {
  const lines = t.split('\n');
  return lines
    .map((line) => {
      if (!line) return '';
      if (/[{}<>]/.test(line) || /^\s|\s$/.test(line)) return `{${JSON.stringify(line)}}`;
      return line.replace(/&/g, '&amp;');
    })
    .join('<br />');
}

function escapeHtml(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br />');
}

function attrEscape(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function svgToJsx(svg: string): string {
  return svg
    .replace(/<\?xml[^>]*>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\sclass=/g, ' className=')
    .replace(/\sstyle="[^"]*"/g, '')
    .replace(/\s(xlink|xml|xmlns):([a-z]+)=/g, (_, ns, a) => ` ${ns}${a.charAt(0).toUpperCase()}${a.slice(1)}=`)
    .replace(/\s([a-z]+(?:-[a-z]+)+)=/g, (m, a: string) => (a.startsWith('data-') || a.startsWith('aria-') ? m : ' ' + a.replace(/-([a-z])/g, (_x, ch) => ch.toUpperCase()) + '='))
    .trim();
}

function prepareSvg(svg: string): string {
  // Make the root svg fill its wrapper.
  return svg.replace(/<svg\b([^>]*)>/i, (_m, attrs: string) => {
    let a = attrs.replace(/\s(width|height)="[^"]*"/g, '');
    return `<svg${a} width="100%" height="100%">`;
  });
}

export function generateCode(doc: DesignDoc, nodeId: string, opts: CodegenOptions): CodegenResult {
  const tree = buildRenderTree(doc, nodeId);
  if (!tree) throw new Error(`Node "${nodeId}" not found`);
  const usedVars = new Set<string>();
  const fonts = new Set<string>();
  const assets = new Set<string>();
  const components = new Map<string, { id: string; name: string; codeConnect?: FrameNode['codeConnect'] }>();
  const imports = new Set<string>();
  const classNames = new Set<string>();
  const assetUrl = (src: string) => (src.startsWith('/') && opts.assetBase ? opts.assetBase.replace(/\/$/, '') + src : src);

  const uniqueClass = (name: string) => {
    let base = kebabCase(name);
    let n = base;
    let i = 2;
    while (classNames.has(n)) n = `${base}-${i++}`;
    classNames.add(n);
    return n;
  };

  const build = (rn: RenderNode, parent: SceneNode | null, isRoot: boolean): GenNode => {
    const node = rn.node;
    const css = nodeStyle(node, { parent, isRoot });
    if (rn.instanceOf) components.set(rn.instanceOf.id, { id: rn.instanceOf.id, name: rn.instanceOf.name, codeConnect: rn.instanceOf.codeConnect });
    // Collect tokens/fonts/assets.
    for (const v of Object.values(css)) for (const m of v.matchAll(/var\(--([\w-]+)\)/g)) usedVars.add(m[1]);
    if (node.type === 'text') fonts.add((node as TextNode).fontFamily || 'Inter');
    if (node.type === 'image' && (node as ImageNode).src) assets.add(assetUrl((node as ImageNode).src));
    for (const f of node.fills ?? []) if (f.type === 'image' && f.src) assets.add(assetUrl(f.src));
    if (css.backgroundImage) css.backgroundImage = css.backgroundImage.replace(/url\("(\/[^"]+)"\)/g, (_m, u) => `url("${assetUrl(u)}")`);

    // Clean up redundant declarations for readable code.
    const hasAbsChildren = rn.children.some((c) => !(isFrameLike(node) && node.layout && node.layout.mode !== 'none') || c.node.position === 'absolute');
    if (css.position === 'relative' && !hasAbsChildren && !isRoot) delete css.position;
    if (node.type === 'text') {
      const t = (node as TextNode).text ?? '';
      const wm = sizeMode(node, 'w');
      if (!t.includes('\n')) {
        if (wm === 'hug') css.whiteSpace = 'nowrap';
        else delete css.whiteSpace;
      }
      if (css.margin === '0px') delete css.margin;
      if (css.overflowWrap && !/\S{30,}/.test(t)) delete css.overflowWrap;
    }
    let tag = 'div';
    if (node.type === 'text') tag = sizeMode(node, 'w') === 'hug' ? 'span' : 'p';
    else if (node.type === 'image') tag = 'img';
    const g: GenNode = { rn, tag, css, className: uniqueClass(node.name || node.type), children: [] };
    if (node.type === 'text') g.text = (node as TextNode).text ?? '';
    const childParent = node;
    g.children = rn.children.map((c) => build(c, childParent, false));
    return g;
  };
  const root = build(tree, null, true);

  // Hoist the dominant font family to the root.
  const textNodes: GenNode[] = [];
  const collect = (g: GenNode) => {
    if (g.rn.node.type === 'text') textNodes.push(g);
    g.children.forEach(collect);
  };
  collect(root);
  if (textNodes.length > 1 || (textNodes.length === 1 && textNodes[0] !== root)) {
    const counts = new Map<string, number>();
    for (const t of textNodes) counts.set(t.css.fontFamily, (counts.get(t.css.fontFamily) ?? 0) + 1);
    const [dominant] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
    if (dominant && root.rn.node.type !== 'text') {
      root.css.fontFamily = dominant;
      for (const t of textNodes) if (t.css.fontFamily === dominant) delete t.css.fontFamily;
    }
  }

  const componentName = pascalCase(tree.node.name || 'Design');
  const tokens = [...usedVars].sort().map((name) => {
    const v = Object.values(doc.variables).find((x) => x.name === name);
    return { name, value: v ? variableCssValue(v) : '/* undefined token */' };
  });
  const tokensCss = tokens.length ? `:root {\n${tokens.map((t) => `  --${t.name}: ${t.value};`).join('\n')}\n}` : '';

  let code = '';
  if (opts.framework === 'html') code = emitHtml(root, componentName, tokensCss, [...fonts], opts);
  else code = emitReact(root, componentName, opts, imports, assetUrl);

  return {
    code,
    componentName,
    tokens,
    tokensCss,
    fonts: [...fonts],
    assets: [...assets],
    components: [...components.values()],
    imports: [...imports],
  };
}

function codeConnectUsage(g: GenNode, imports: Set<string>, ind: string): string | null {
  const comp = g.rn.instanceOf;
  if (!comp?.codeConnect?.name || g.rn.virtual) return null;
  const cc = comp.codeConnect;
  if (cc.importPath) imports.add(`import { ${cc.name} } from '${cc.importPath}';`);
  // Single text layer → children.
  const texts: GenNode[] = [];
  const walk = (x: GenNode) => {
    if (x.rn.node.type === 'text') texts.push(x);
    x.children.forEach(walk);
  };
  walk(g);
  const visibleTexts = texts.filter((t) => t.rn.node.visible !== false);
  if (visibleTexts.length === 1) return `${ind}<${cc.name}>${escapeJsxText(visibleTexts[0].text ?? '')}</${cc.name}>`;
  if (visibleTexts.length > 1) {
    const props = visibleTexts
      .map((t) => `${camelProp(t.rn.node.name)}=${JSON.stringify(t.text ?? '')}`)
      .join(' ');
    return `${ind}<${cc.name} ${props} />`;
  }
  return `${ind}<${cc.name} />`;
}

function camelProp(name: string): string {
  const p = pascalCase(name);
  return p.charAt(0).toLowerCase() + p.slice(1);
}

function emitReact(root: GenNode, componentName: string, opts: CodegenOptions, imports: Set<string>, assetUrl: (s: string) => string): string {
  const tailwind = opts.framework === 'react-tailwind';
  const lines: string[] = [];
  const styleObj = (css: CSSMap) =>
    '{{ ' +
    Object.entries(css)
      .map(([k, v]) => `${/^[a-zA-Z]\w*$/.test(k) ? k : JSON.stringify(k)}: ${JSON.stringify(v)}`)
      .join(', ') +
    ' }}';
  const attrs = (g: GenNode) => {
    const parts: string[] = [];
    if (tailwind) {
      const css = { ...g.css };
      const { classes, rest } = cssToTailwind(css);
      if (classes.length) parts.push(`className="${classes.join(' ')}"`);
      if (Object.keys(rest).length) parts.push(`style=${styleObj(rest)}`);
    } else if (Object.keys(g.css).length) {
      const css = { ...g.css };
      delete css.boxSizing;
      parts.push(`style=${styleObj(css)}`);
    }
    if (opts.annotate && g.rn.node.type !== 'text') parts.push(`data-name=${JSON.stringify(g.rn.node.name)}`);
    return parts.length ? ' ' + parts.join(' ') : '';
  };
  const emit = (g: GenNode, depth: number) => {
    const ind = '  '.repeat(depth);
    const n = g.rn.node;
    if (g.rn.instanceOf && !g.rn.virtual) {
      const usage = codeConnectUsage(g, imports, ind);
      if (usage) {
        lines.push(usage);
        return;
      }
      if (opts.annotate) lines.push(`${ind}{/* Instance of component "${g.rn.instanceOf.name}" */}`);
    }
    if (n.type === 'image') {
      const img = n as ImageNode;
      lines.push(`${ind}<img src=${JSON.stringify(assetUrl(img.src || ''))} alt=${JSON.stringify(img.alt ?? img.name)}${attrs(g)} />`);
      return;
    }
    if (n.type === 'svg') {
      const svg = svgToJsx(prepareSvg((n as SvgNode).svg || '<svg />'));
      lines.push(`${ind}<div${attrs(g)}>`);
      for (const l of svg.split('\n')) lines.push(`${ind}  ${l.trim()}`);
      lines.push(`${ind}</div>`);
      return;
    }
    if (n.type === 'text') {
      lines.push(`${ind}<${g.tag}${attrs(g)}>${escapeJsxText(g.text ?? '')}</${g.tag}>`);
      return;
    }
    if (!g.children.length) {
      lines.push(`${ind}<${g.tag}${attrs(g)} />`);
      return;
    }
    lines.push(`${ind}<${g.tag}${attrs(g)}>`);
    for (const c of g.children) emit(c, depth + 1);
    lines.push(`${ind}</${g.tag}>`);
  };
  emit(root, 2);
  const body = lines.join('\n');
  const head = imports.size ? [...imports].join('\n') + '\n\n' : '';
  return `${head}export default function ${componentName}() {\n  return (\n${body}\n  );\n}\n`;
}

function emitHtml(root: GenNode, componentName: string, tokensCss: string, fonts: string[], opts: CodegenOptions): string {
  const rules: string[] = [];
  const lines: string[] = [];
  const emit = (g: GenNode, depth: number) => {
    const ind = '  '.repeat(depth);
    const n = g.rn.node;
    const css = { ...g.css };
    delete css.boxSizing;
    if (Object.keys(css).length) rules.push(`.${g.className} {\n${cssMapToText(css)}\n}`);
    const cls = ` class="${g.className}"`;
    const dataName = opts.annotate ? ` data-name="${attrEscape(n.name)}"` : '';
    if (g.rn.instanceOf && !g.rn.virtual && opts.annotate) lines.push(`${ind}<!-- Instance of component "${g.rn.instanceOf.name}" -->`);
    if (n.type === 'image') {
      const img = n as ImageNode;
      lines.push(`${ind}<img${cls} src="${attrEscape(opts.assetBase && img.src?.startsWith('/') ? opts.assetBase + img.src : img.src || '')}" alt="${attrEscape(img.alt ?? img.name)}" />`);
      return;
    }
    if (n.type === 'svg') {
      lines.push(`${ind}<div${cls}${dataName}>${prepareSvg((n as SvgNode).svg || '')}</div>`);
      return;
    }
    if (n.type === 'text') {
      lines.push(`${ind}<${g.tag}${cls}>${escapeHtml(g.text ?? '')}</${g.tag}>`);
      return;
    }
    if (!g.children.length) {
      lines.push(`${ind}<div${cls}${dataName}></div>`);
      return;
    }
    lines.push(`${ind}<div${cls}${dataName}>`);
    for (const c of g.children) emit(c, depth + 1);
    lines.push(`${ind}</div>`);
  };
  emit(root, 2);
  const google = fonts.filter((f) => GOOGLE_FONTS.includes(f));
  const fontLink = google.length
    ? `  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?${google.map((f) => `family=${f.replace(/ /g, '+')}:ital,wght@0,100..900;1,100..900`).join('&')}&display=swap" />\n`
    : '';
  const css = [`*, *::before, *::after { box-sizing: border-box; }`, `body { margin: 0; }`, `p { margin: 0; }`, tokensCss, ...rules].filter(Boolean).join('\n\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${attrEscape(componentName)}</title>
${fontLink}  <style>
${css
  .split('\n')
  .map((l) => (l ? '    ' + l : l))
  .join('\n')}
  </style>
</head>
<body>
${lines.join('\n')}
</body>
</html>
`;
}

/** CSS declarations for a single node (Dev panel "Inspect"). */
export function inspectCss(doc: DesignDoc, nodeId: string): string {
  const tree = buildRenderTree(doc, nodeId);
  if (!tree) return '';
  const parent = doc.nodes[doc.nodes[nodeId]?.parentId] ?? null;
  const css = nodeStyle(tree.node, { parent });
  delete css.boxSizing;
  return cssMapToText(css, '');
}
