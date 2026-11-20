import { toPng } from 'html-to-image';
import { getState, setState } from '../store.ts';
import { pageOf } from '../../shared/doc.ts';
import { GOOGLE_FONTS } from '../../shared/codegen.ts';
import { getViewportEl, measure, nodeEl, unionRects, type Rect } from './viewport.ts';

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Embedding every web font on the page is slow, so build @font-face CSS only
// for the families a capture uses (Latin subset), and cache it.
const familyCss = new Map<string, Promise<string>>();

async function buildFamilyCss(family: string): Promise<string> {
  const key = `family=${family.replace(/ /g, '+')}`;
  const link = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].find((l) => l.href.includes(key + ':') || l.href.includes(key + '&'));
  const url = link?.href ?? `https://fonts.googleapis.com/css2?${key}:wght@400;700&display=swap`;
  const css = await (await fetch(url)).text();
  const blocks = css.match(/@font-face\s*{[^}]*}/g) ?? [];
  const latin = blocks.filter((b) => !/unicode-range/.test(b) || /U\+0000-00FF/i.test(b));
  const out = await Promise.all(
    latin.map(async (b) => {
      const m = b.match(/url\((https:[^)]+)\)/);
      if (!m) return '';
      const buf = await (await fetch(m[1])).arrayBuffer();
      return b.replace(m[1], `data:font/woff2;base64,${toBase64(buf)}`);
    }),
  );
  return out.join('\n');
}

async function fontCssFor(el: HTMLElement): Promise<string> {
  const families = new Set<string>();
  for (const e of [el, ...Array.from(el.querySelectorAll<HTMLElement>('*'))]) {
    const fam = getComputedStyle(e).fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '');
    if (GOOGLE_FONTS.includes(fam)) families.add(fam);
  }
  const parts = await Promise.all(
    [...families].map((f) => {
      if (!familyCss.has(f)) familyCss.set(f, buildFamilyCss(f).catch(() => ''));
      return familyCss.get(f)!;
    }),
  );
  return parts.join('\n');
}

async function render(el: HTMLElement, opts: Parameters<typeof toPng>[1]): Promise<string> {
  const base = {
    cacheBust: false,
    imagePlaceholder: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    ...opts,
  };
  try {
    const fontEmbedCSS = await withTimeout(fontCssFor(el), 6000);
    return await withTimeout(toPng(el, { ...base, fontEmbedCSS }), 10000);
  } catch {
    return await toPng(el, { ...base, skipFonts: true });
  }
}

/** Render a node (or the whole page) to a PNG data URL, exactly as on canvas. */
export async function captureScreenshot(payload: { nodeId?: string; pageId?: string; scale?: number; maxSize?: number }) {
  const s = getState();
  const doc = s.doc;
  if (!doc) throw new Error('No document loaded');
  const targetPage = payload.nodeId ? pageOf(doc, payload.nodeId) : payload.pageId ?? s.pageId;
  const originalPage = s.pageId;
  const switchPage = targetPage && targetPage !== s.pageId && doc.pages[targetPage];
  if (switchPage) {
    setState({ pageId: targetPage! });
    await nextFrame();
    await nextFrame();
  }
  try {
    await document.fonts?.ready;
    const maxSize = payload.maxSize ?? 1600;
    if (payload.nodeId) {
      const el = nodeEl(payload.nodeId);
      if (!el) throw new Error(`Node ${payload.nodeId} is not rendered (hidden?)`);
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const scale = payload.scale ?? Math.min(2, maxSize / Math.max(width, height, 1));
      const dataUrl = await render(el, {
        width,
        height,
        pixelRatio: scale,
        // Computed `inset` (incl. right/bottom) is copied onto the clone; reset it or the node renders off-frame.
        style: { inset: '0px auto auto 0px', margin: '0px', transform: 'none', opacity: '1' },
      });
      return { dataUrl, width: Math.round(width * scale), height: Math.round(height * scale) };
    }
    // Whole page.
    const page = getState().doc!.pages[getState().pageId];
    const rects = page.children.map(measure).filter((r): r is Rect => !!r);
    const u = unionRects(rects);
    if (!u) throw new Error('Page is empty');
    const world = getViewportEl()?.querySelector('[data-world]') as HTMLElement | null;
    if (!world) throw new Error('Canvas not ready');
    const pad = 40;
    const width = Math.ceil(u.width + pad * 2);
    const height = Math.ceil(u.height + pad * 2);
    const scale = payload.scale ?? Math.min(2, maxSize / Math.max(width, height, 1));
    const dataUrl = await render(world, {
      width,
      height,
      pixelRatio: scale,
      backgroundColor: page.background ?? '#1E1E1E',
      style: { inset: '0px auto auto 0px', transform: `translate(${-u.x + pad}px, ${-u.y + pad}px)`, width: `${width}px`, height: `${height}px` },
    });
    return { dataUrl, width: Math.round(width * scale), height: Math.round(height * scale) };
  } finally {
    if (switchPage) setState({ pageId: originalPage });
  }
}

export async function downloadPng(nodeId: string, scale = 2) {
  const { dataUrl } = await captureScreenshot({ nodeId, scale });
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = `${getState().doc?.nodes[nodeId]?.name ?? 'export'}@${scale}x.png`;
  a.click();
}
