/**
 * HTML → design layers. Renders the markup in a hidden iframe (with Tailwind
 * available), then walks the DOM using computed styles. Flex containers become
 * auto-layout frames; everything else is positioned absolutely so the result
 * matches the rendering pixel-for-pixel.
 */
import DOMPurify from 'dompurify';
import tailwindUrl from '@tailwindcss/browser?url';
import type { NodeSpec } from '../../shared/normalize.ts';

const INLINE = new Set(['A', 'SPAN', 'STRONG', 'B', 'EM', 'I', 'U', 'CODE', 'SMALL', 'SUP', 'SUB', 'MARK', 'BR', 'ABBR', 'KBD', 'S', 'LABEL', 'TIME']);

function px(v: string): number {
  return parseFloat(v) || 0;
}

let cctx: CanvasRenderingContext2D | null = null;
/** Any CSS color (incl. oklch from Tailwind v4) → #RRGGBB / #RRGGBBAA. */
function hexColor(c: string): string {
  cctx ??= Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
  if (!cctx) return c;
  cctx.clearRect(0, 0, 1, 1);
  cctx.fillStyle = '#000';
  cctx.fillStyle = c;
  cctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = cctx.getImageData(0, 0, 1, 1).data;
  const h = (n: number) => n.toString(16).padStart(2, '0');
  return ('#' + h(r) + h(g) + h(b) + (a < 255 ? h(a) : '')).toUpperCase();
}

function hexColorsIn(s: string): string {
  return s.replace(/(oklch|oklab|lab|lch|rgba?|hsla?|color)\([^()]*(\([^()]*\)[^()]*)*\)/g, (m) => hexColor(m));
}

function isTransparent(c: string) {
  return !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c) || c === 'rgba(0, 0, 0, 0)';
}

function hasBox(cs: CSSStyleDeclaration) {
  return (
    !isTransparent(cs.backgroundColor) ||
    cs.backgroundImage !== 'none' ||
    px(cs.borderTopWidth) + px(cs.borderRightWidth) + px(cs.borderBottomWidth) + px(cs.borderLeftWidth) > 0 ||
    cs.boxShadow !== 'none' ||
    px(cs.paddingTop) + px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.paddingBottom) > 0
  );
}

function textProps(cs: CSSStyleDeclaration): Record<string, any> {
  const lh = cs.lineHeight === 'normal' ? undefined : px(cs.lineHeight);
  const out: Record<string, any> = {
    fontFamily: cs.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, ''),
    fontSize: px(cs.fontSize),
    fontWeight: parseInt(cs.fontWeight) || 400,
    color: hexColor(cs.color),
  };
  if (lh) out.lineHeight = Math.round(lh * 100) / 100;
  const ls = px(cs.letterSpacing);
  if (ls) out.letterSpacing = ls;
  if (cs.textAlign && !['start', 'left', 'auto'].includes(cs.textAlign)) out.textAlign = cs.textAlign === 'end' ? 'right' : cs.textAlign;
  if (cs.fontStyle === 'italic') out.italic = true;
  if (cs.textTransform && cs.textTransform !== 'none') out.textTransform = cs.textTransform;
  const deco = cs.textDecorationLine;
  if (deco && deco !== 'none') out.textDecoration = deco.includes('line-through') ? 'line-through' : 'underline';
  return out;
}

function boxProps(cs: CSSStyleDeclaration): Record<string, any> {
  const out: Record<string, any> = {};
  const fills: any[] = [];
  if (!isTransparent(cs.backgroundColor)) fills.push({ type: 'solid', color: hexColor(cs.backgroundColor) });
  if (cs.backgroundImage && cs.backgroundImage !== 'none') {
    const img = cs.backgroundImage;
    const url = img.match(/url\(["']?([^"')]+)["']?\)/);
    if (url) fills.push({ type: 'image', src: url[1], fit: cs.backgroundSize === 'contain' ? 'contain' : 'cover' });
    else if (img.startsWith('linear-gradient')) fills.push(hexColorsIn(img));
  }
  if (fills.length) out.fills = fills;
  const bw = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map(px);
  const maxBw = Math.max(...bw);
  if (maxBw > 0 && cs.borderTopStyle !== 'none') {
    const color = bw[0] ? cs.borderTopColor : bw[2] ? cs.borderBottomColor : bw[1] ? cs.borderRightColor : cs.borderLeftColor;
    out.stroke = { color: hexColor(color), width: maxBw, style: cs.borderTopStyle === 'dashed' ? 'dashed' : cs.borderTopStyle === 'dotted' ? 'dotted' : 'solid', align: 'inside' };
  }
  const r = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map(px);
  const rr = r.map((x) => Math.min(x, 9999));
  if (rr.some((x) => x > 0)) out.radius = rr.every((x) => x === rr[0]) ? rr[0] : rr;
  if (cs.boxShadow && cs.boxShadow !== 'none') out.shadows = hexColorsIn(cs.boxShadow);
  const op = parseFloat(cs.opacity);
  if (op < 1) out.opacity = op;
  if (cs.overflow === 'hidden' || cs.overflowX === 'hidden' || cs.overflow === 'clip') out.clip = true;
  return out;
}

function nameFor(el: Element): string {
  const aria = el.getAttribute('aria-label') || el.getAttribute('data-name');
  if (aria) return aria;
  const id = el.id;
  if (id) return id;
  const tag = el.tagName.toLowerCase();
  const map: Record<string, string> = { button: 'Button', nav: 'Nav', header: 'Header', footer: 'Footer', main: 'Main', section: 'Section', aside: 'Sidebar', form: 'Form', input: 'Input', ul: 'List', li: 'ListItem', a: 'Link', h1: 'Heading', h2: 'Heading', h3: 'Heading', img: 'Image', textarea: 'Textarea', select: 'Select', table: 'Table' };
  return map[tag] ?? 'Frame';
}

function convert(el: Element, parentRect: DOMRect, parentFlex: { dir: 'row' | 'column' } | null, win: Window, depth: number): NodeSpec | null {
  if (depth > 60) return null;
  const cs = win.getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return null;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0 && el.tagName !== 'svg') return null;
  const abs = cs.position === 'absolute' || cs.position === 'fixed';
  const pos: Record<string, any> = {
    x: Math.round((rect.left - parentRect.left) * 100) / 100,
    y: Math.round((rect.top - parentRect.top) * 100) / 100,
  };
  if (parentFlex && abs) pos.position = 'absolute';
  const tag = el.tagName.toUpperCase();

  if (tag === 'IMG') {
    const img = el as HTMLImageElement;
    return { type: 'image', name: img.alt || 'Image', src: img.currentSrc || img.src, fit: cs.objectFit === 'contain' ? 'contain' : 'cover', width: rect.width, height: rect.height, ...pos, ...boxProps(cs) };
  }
  if (tag === 'SVG') {
    const clone = el.cloneNode(true) as SVGElement;
    const color = cs.color;
    let markup = new XMLSerializer().serializeToString(clone).replace(/currentColor/g, color);
    if (!clone.getAttribute('viewBox') && (clone.getAttribute('width') || rect.width)) {
      markup = markup.replace('<svg', `<svg viewBox="0 0 ${clone.getAttribute('width') ?? rect.width} ${clone.getAttribute('height') ?? rect.height}"`);
    }
    return { type: 'svg', name: el.getAttribute('aria-label') || 'Icon', svg: markup, width: rect.width, height: rect.height, ...pos };
  }

  const elementChildren = Array.from(el.children).filter((c) => !['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT'].includes(c.tagName.toUpperCase()));
  const directText = Array.from(el.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent ?? '')
    .join('')
    .trim();
  const isFlexOrGrid = /flex|grid/.test(cs.display);
  const onlyInline =
    !isFlexOrGrid &&
    elementChildren.every((c) => INLINE.has(c.tagName.toUpperCase()) && !c.querySelector('img,svg,div,p') && /^inline/.test(win.getComputedStyle(c).display));
  const isFormField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  const textContent = isFormField
    ? (el as HTMLInputElement).value || (el as HTMLInputElement).placeholder || ''
    : (el as HTMLElement).innerText?.replace(/ /g, ' ').trim() ?? '';
  const isTextLeaf = (onlyInline && (directText || elementChildren.length) && textContent) || (isFormField && textContent);

  const singleLine = rect.height <= px(cs.lineHeight === 'normal' ? String(px(cs.fontSize) * 1.25) : cs.lineHeight) * 1.5 + px(cs.paddingTop) + px(cs.paddingBottom);

  if (isTextLeaf && !hasBox(cs) && !isFormField) {
    // Pure text element.
    return {
      type: 'text',
      name: textContent.slice(0, 40),
      text: textContent,
      ...textProps(cs),
      ...(singleLine ? {} : { width: Math.ceil(rect.width) }),
      ...pos,
    };
  }

  const isFlex = cs.display === 'flex' || cs.display === 'inline-flex';
  const frame: NodeSpec = {
    type: 'frame',
    name: nameFor(el),
    width: rect.width,
    height: rect.height,
    ...pos,
    ...boxProps(cs),
    children: [],
  };
  const padding = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(px);
  if (isFlex) {
    const dir = cs.flexDirection.startsWith('column') ? 'column' : 'row';
    const gap = px(dir === 'row' ? cs.columnGap : cs.rowGap);
    const jc = cs.justifyContent;
    const ai = cs.alignItems;
    frame.layout = {
      mode: dir,
      gap,
      padding,
      justify: jc.includes('between') ? 'space-between' : jc.includes('center') ? 'center' : jc.includes('end') ? 'end' : 'start',
      align: ai.includes('center') ? 'center' : ai.includes('end') ? 'end' : ai === 'baseline' ? 'baseline' : ai === 'stretch' || ai === 'normal' ? 'stretch' : 'start',
      wrap: cs.flexWrap === 'wrap',
    };
  }

  const childFlex = isFlex ? { dir: frame.layout.mode as 'row' | 'column' } : null;
  if (isTextLeaf || isFormField) {
    // Box with text inside (buttons, badges, inputs).
    const range = win.document.createRange();
    range.selectNodeContents(el);
    const tr = isFormField ? null : range.getBoundingClientRect();
    const textSpec: NodeSpec = {
      type: 'text',
      name: textContent.slice(0, 40),
      text: textContent,
      ...textProps(cs),
      ...(isFormField && !(el as HTMLInputElement).value ? { opacity: 0.55 } : {}),
    };
    if (isFlex) frame.children!.push(textSpec);
    else {
      textSpec.x = tr ? tr.left - rect.left : padding[3];
      textSpec.y = tr ? tr.top - rect.top : padding[0];
      if (!singleLine) textSpec.width = Math.ceil(tr ? tr.width : rect.width - padding[1] - padding[3]);
      frame.children!.push(textSpec);
    }
    return frame;
  }

  // Loose text nodes mixed with elements → text layers.
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const t = (child.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      const range = win.document.createRange();
      range.selectNodeContents(child);
      const tr = range.getBoundingClientRect();
      if (!tr.width) continue;
      const spec: NodeSpec = { type: 'text', name: t.slice(0, 40), text: t, ...textProps(cs) };
      if (!childFlex) {
        spec.x = tr.left - rect.left;
        spec.y = tr.top - rect.top;
      }
      frame.children!.push(spec);
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const spec = convert(child as Element, rect, childFlex, win, depth + 1);
      if (!spec) continue;
      if (childFlex) {
        // Auto layout has no per-item margins: emulate them with spacers.
        const ccs = win.getComputedStyle(child as Element);
        const lead = px(childFlex.dir === 'row' ? ccs.marginLeft : ccs.marginTop);
        if (lead > 0.5 && frame.children!.length) {
          const isLast = child === elementChildren[elementChildren.length - 1];
          const grow = isLast && frame.layout?.justify === 'start';
          frame.children!.push({ type: 'frame', name: 'Spacer', ...(childFlex.dir === 'row' ? { width: grow ? 'fill' : lead, height: 1 } : { height: grow ? 'fill' : lead, width: 1 }) });
        }
      }
      frame.children!.push(spec);
    }
  }
  return frame;
}

export async function htmlToSpec(html: string, width = 1440, name = 'Imported'): Promise<NodeSpec> {
  const clean = DOMPurify.sanitize(html, { WHOLE_DOCUMENT: true, ADD_TAGS: ['style', 'link'], ADD_ATTR: ['class', 'style'], FORCE_BODY: true });
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts');
  iframe.style.cssText = `position:fixed;left:-20000px;top:0;width:${width}px;height:2000px;border:0;visibility:hidden;`;
  const fontsLink = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap">';
  iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8">${fontsLink}<script src="${tailwindUrl}"></script><style>body{margin:0;font-family:Inter,system-ui,sans-serif}</style></head><body>${clean}</body></html>`;
  document.body.appendChild(iframe);
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('HTML render timed out')), 15000);
      iframe.onload = () => {
        clearTimeout(t);
        resolve();
      };
    });
    const win = iframe.contentWindow!;
    const doc = iframe.contentDocument!;
    // Give Tailwind and fonts a moment to apply.
    await new Promise((r) => setTimeout(r, 350));
    await (doc as any).fonts?.ready;
    await new Promise((r) => win.requestAnimationFrame(() => r(null)));
    const body = doc.body;
    const rootEls = Array.from(body.children).filter((c) => !['SCRIPT', 'STYLE', 'LINK'].includes(c.tagName));
    const bodyRect = body.getBoundingClientRect();
    let spec: NodeSpec | null;
    if (rootEls.length === 1) {
      spec = convert(rootEls[0], rootEls[0].getBoundingClientRect(), null, win, 0);
    } else {
      const height = Math.max(doc.documentElement.scrollHeight, body.scrollHeight);
      spec = { type: 'frame', name, width, height, fill: win.getComputedStyle(body).backgroundColor, children: [] };
      for (const el of rootEls) {
        const c = convert(el, bodyRect, null, win, 1);
        if (c) spec.children!.push(c);
      }
    }
    if (!spec) throw new Error('Nothing visible to import');
    spec.name = name;
    // Let the caller place it (auto-placement next to existing content).
    delete spec.x;
    delete spec.y;
    delete spec.position;
    if (!spec.fills && !spec.fill && spec.type === 'frame') spec.fill = '#FFFFFF';
    return spec;
  } finally {
    iframe.remove();
  }
}
