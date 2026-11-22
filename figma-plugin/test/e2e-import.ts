// Manual end-to-end check: fake Figma → serialize → real server import. Usage: DC=http://localhost:4420 npx tsx figma-plugin/test/e2e-import.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { createFakeFigma } from './fake-figma.mjs';

/** A small gradient PNG, generated so the check doesn't need a fixture file. */
function makePng(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = Math.round((x / w) * 255);
      raw[o + 1] = 120;
      raw[o + 2] = Math.round((y / h) * 255);
    }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const base = process.env.DC ?? 'http://localhost:4410';
const token = (await (await fetch(`${base}/api/figma/status`)).json()).token;
const H = { 'x-design-canvas-token': token, origin: 'null' };
const fake = createFakeFigma();
(globalThis as any).figma = fake.figma;
const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'engine.js'), 'utf8');
const engine = new Function(`${src}\nreturn dcCreateApplier;`)()();
const figma = fake.figma;

// A "designer-made" Figma frame: auto layout card with text, an image fill, a vector icon and a variable.
const col = figma.variables.createVariableCollection('Brand');
const brand = figma.variables.createVariable('color/brand', col, 'COLOR');
brand.setValueForMode('m1', { r: 0.93, g: 0.27, b: 0.35, a: 1 });
await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });
await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
const card = figma.createFrame();
Object.assign(card, { name: 'Promo card', x: 40, y: 40, layoutMode: 'VERTICAL', itemSpacing: 12, paddingTop: 20, paddingBottom: 20, paddingLeft: 20, paddingRight: 20, primaryAxisAlignItems: 'MIN', counterAxisAlignItems: 'MIN', layoutWrap: 'NO_WRAP', clipsContent: true, topLeftRadius: 16, topRightRadius: 16, bottomLeftRadius: 16, bottomRightRadius: 16 });
card.resize(320, 300);
card.layoutSizingVertical = 'HUG';
card.fills = [figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 0.93, g: 0.27, b: 0.35 }, opacity: 1, visible: true }, 'color', brand)];
card.effects = [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.2 }, offset: { x: 0, y: 6 }, radius: 18, spread: 0, visible: true }];
const png = makePng(280, 140);
const img = figma.createRectangle();
Object.assign(img, { name: 'Hero image' });
img.resize(280, 140);
img.layoutSizingHorizontal = 'FILL';
img.fills = [{ type: 'IMAGE', imageHash: figma.createImage(new Uint8Array(png)).hash, scaleMode: 'FILL', visible: true }];
const title = figma.createText();
title.fontName = { family: 'Inter', style: 'Bold' };
Object.assign(title, { name: 'Title', fontSize: 22, lineHeight: { unit: 'PIXELS', value: 28 }, textAlignHorizontal: 'LEFT', textAutoResize: 'WIDTH_AND_HEIGHT', fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 1, visible: true }] });
title.characters = 'Summer sale — 40% off';
const icon = figma.createFrame();
Object.assign(icon, { name: 'Arrow icon' });
icon.resize(24, 24);
const v = figma.createRectangle();
v.type = 'VECTOR';
icon.appendChild(v);
for (const n of [img, title, icon]) card.appendChild(n);

const { payload, images } = await engine.serialize([card]);
let json = JSON.stringify(payload);
for (const [hash, bytes] of Object.entries(images)) {
  const r = await fetch(`${base}/api/figma/plugin/asset`, { method: 'POST', headers: { ...H, 'content-type': 'image/png' }, body: bytes as Uint8Array });
  const { url } = await r.json();
  json = json.split(`figma-image:${hash}`).join(url);
}
const r = await fetch(`${base}/api/figma/plugin/import`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ payload: JSON.parse(json), newDocName: 'From Figma (e2e)' }) });
console.log(r.status, JSON.stringify(await r.json(), null, 1));
