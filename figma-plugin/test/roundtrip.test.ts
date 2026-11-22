import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { produce } from 'immer';
import { createFakeFigma } from './fake-figma.mjs';
import { createDoc } from '../../src/shared/doc.ts';
import { createComponent, createInstance, createNodes, upsertVariable } from '../../src/shared/ops.ts';
import { buildFigmaExport, linearGradientTransform, type FigmaSpec } from '../../src/shared/figma.ts';
import { cssAngleFromTransform, importFromFigma, rgbaToCss } from '../../src/shared/figma-import.ts';
import type { DesignDoc } from '../../src/shared/types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineSrc = fs.readFileSync(path.join(here, '..', 'src', 'engine.js'), 'utf8');

function setup() {
  const fake = createFakeFigma();
  (globalThis as any).figma = fake.figma;
  const make = new Function(`${engineSrc}\nreturn dcCreateApplier;`)();
  return { ...fake, engine: make() };
}

function sampleDoc() {
  const ids: Record<string, string> = {};
  const doc = produce(createDoc('Round trip'), (d0) => {
    const d = d0 as DesignDoc;
    const page = d.pageOrder[0];
    upsertVariable(d, { name: 'primary', value: '#4F46E5', group: 'color' });
    upsertVariable(d, { name: 'space-4', value: 16 });
    upsertVariable(d, { name: 'radius-lg', value: 16 });
    ids.btn = createNodes(d, [{ type: 'frame', name: 'Button', x: 0, y: 600, fill: '$primary', radius: 10, layout: { mode: 'row', padding: [10, 18], align: 'center' }, children: [{ type: 'text', name: 'Label', text: 'Get started', fontWeight: 600, color: '#FFFFFF' }] }], page).ids[0];
    createComponent(d, ids.btn);
    (d.nodes[ids.btn] as any).codeConnect = { name: 'Button', importPath: '@/components/ui/button' };
    ids.label = (d.nodes[ids.btn] as any).children[0];
    ids.screen = createNodes(
      d,
      [
        {
          type: 'frame',
          name: 'Card',
          width: 360,
          radius: '$radius-lg',
          stroke: '1px dashed #E2E8F0',
          shadows: '0 8px 24px rgba(15,23,42,0.12)',
          fills: [{ type: 'gradient', angle: 135, stops: [{ color: '#EEF2FF', position: 0 }, { color: '#FFFFFF', position: 1 }] }],
          layout: { mode: 'column', gap: '$space-4', padding: 24, align: 'stretch', justify: 'space-between' },
          children: [
            { type: 'text', name: 'Title', text: 'Upgrade', fontSize: 24, fontWeight: 700, lineHeight: 32, letterSpacing: -0.4, color: '#0F172A', textTransform: 'uppercase' },
            { type: 'text', name: 'Body', text: 'Unlock everything.', width: 'fill', color: 'rgba(15, 23, 42, 0.6)', textAlign: 'center' },
            { type: 'rect', name: 'Divider', width: 'fill', height: 1, fill: '#E2E8F0' },
            { type: 'ellipse', name: 'Dot', position: 'absolute', x: 320, y: 12, width: 12, height: 12, fill: '#22C55E', opacity: 0.8 },
          ],
        },
      ],
      page,
    ).ids[0];
    ids.inst = createInstance(d, ids.btn, ids.screen);
    (d.nodes[ids.inst] as any).overrides = { [ids.label]: { text: 'Buy now' } };
  });
  return { doc, ids };
}

/** Comparable view of an export: no ids, keys or root positions; SVG markup and component keys by name. */
function comparable(specs: FigmaSpec[], names: Record<string, string>): unknown[] {
  return specs.map((s) => {
    const { key, figmaId, x, y, svg, componentKey, overrides, children, ...rest } = s as any;
    // Auto-sized text dimensions are measured by the renderer (browser or Figma), not designed.
    const ar = s.text?.textAutoResize;
    if (ar === 'WIDTH_AND_HEIGHT') delete rest.width;
    if (ar === 'WIDTH_AND_HEIGHT' || ar === 'HEIGHT') delete rest.height;
    return {
      ...rest,
      ...(s.inFlow ? {} : { x: Math.round(x), y: Math.round(y) }),
      ...(componentKey ? { component: names[componentKey] } : {}),
      ...(overrides ? { overrides: overrides.map((o: any) => ({ ...o, path: o.path.map((k: string) => names[k]) })) } : {}),
      ...(children ? { children: comparable(children, names) } : {}),
    };
  });
}
function namesOf(doc: DesignDoc): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of Object.values(doc.nodes)) out[n.id] = n.name;
  return out;
}

test('inverse helpers mirror the export', () => {
  assert.equal(rgbaToCss({ r: 0.3098, g: 0.2745, b: 0.898, a: 1 }), '#4F46E5');
  assert.equal(rgbaToCss({ r: 0, g: 0, b: 0, a: 0.5 }), 'rgba(0, 0, 0, 0.5)');
  for (const [angle, w, h] of [
    [180, 200, 100],
    [90, 50, 300],
    [135, 360, 220],
    [20, 100, 100],
    [300, 640, 120],
  ])
    assert.ok(Math.abs(cssAngleFromTransform(linearGradientTransform(angle, w, h), w, h) - angle) < 0.05, `${angle}deg`);
});

test('canvas → Figma → canvas round trip preserves the design (parity)', async () => {
  const { engine, figma } = setup();
  const { doc } = sampleDoc();
  const original = buildFigmaExport(doc, { assetBase: 'http://localhost:4410' });
  await engine.apply(original, {});

  // Copy the Figma layers into a brand-new design.
  const { payload } = await engine.serialize(figma.currentPage.children.slice());
  assert.deepEqual(payload.warnings, []);
  let copy = produce(createDoc('Copy'), () => {});
  let result: ReturnType<typeof importFromFigma> | undefined;
  copy = produce(copy, (d) => {
    result = importFromFigma(d as DesignDoc, payload, { pageId: d.pageOrder[0] });
  });
  assert.equal(result!.created, Object.keys(doc.nodes).length);
  assert.deepEqual(result!.warnings, []);

  // Tokens come back by name, with values.
  const vars = Object.fromEntries(Object.values(copy.variables).map((v) => [v.name, [v.value, v.group]]));
  assert.deepEqual(vars, { primary: ['#4F46E5', 'color'], 'space-4': [16, undefined], 'radius-lg': [16, undefined] });

  // Exporting the copy gives the same Figma spec as the original: nothing was lost either way.
  const again = buildFigmaExport(copy, { assetBase: 'http://localhost:4410' });
  const a = comparable(original.roots, namesOf(doc));
  const b = comparable(again.roots, namesOf(copy));
  // The canvas default line height comes back explicit (140%) — same rendering.
  assert.deepEqual(b, a);
  const card = Object.values(copy.nodes).find((n) => n.name === 'Card') as any;
  assert.equal(card.layout.gap, '$space-4');
  assert.equal(card.radius, '$radius-lg');
  const inst = Object.values(copy.nodes).find((n) => n.type === 'instance') as any;
  const comp = copy.nodes[inst.componentId] as any;
  assert.equal(comp.type, 'component');
  assert.deepEqual(comp.codeConnect, { name: 'Button', importPath: '@/components/ui/button' });
  assert.deepEqual(Object.values(inst.overrides), [{ text: 'Buy now' }]);
});

test('copying back into the original design updates layers in place', async () => {
  const { engine, figma } = setup();
  const { doc, ids } = sampleDoc();
  await engine.apply(buildFigmaExport(doc, { assetBase: 'http://localhost:4410' }), {});

  // A designer edits in Figma: new title text, removes the divider, moves nothing else.
  const card = figma.currentPage.children.find((n: any) => n.name === 'Card');
  const title = card.children.find((n: any) => n.name === 'Title');
  title.characters = 'Go Pro';
  card.children.find((n: any) => n.name === 'Divider').remove();
  const sticker = figma.createRectangle();
  sticker.name = 'New in Figma';
  card.appendChild(sticker);

  const { payload } = await engine.serialize([card]);
  let result: any;
  const next = produce(doc, (d) => {
    result = importFromFigma(d as DesignDoc, payload, { pageId: d.pageOrder[0] });
  });
  assert.equal(result.created, 1, 'only the layer added in Figma is new');
  assert.equal(result.removed, 1, 'the divider deleted in Figma is deleted');
  assert.deepEqual(result.rootIds, [ids.screen], 'same canvas frame');
  assert.equal((next.nodes[ids.screen] as any).children.length, 5, 'Title, Body, Dot, Button, New in Figma');
  const t = Object.values(next.nodes).find((n) => n.name === 'Title') as any;
  assert.equal(t.text, 'Go Pro');
  assert.equal(next.nodes[ids.inst]?.type, 'instance', 'instance keeps its id');
  assert.equal((next.nodes[ids.inst] as any).componentId, ids.btn, 'and stays linked to the same component');
  // Figma layers created from Figma get tagged so the next copy updates them too.
  await engine.tagImported(next.id, next.name, result.keyMap, [card.id]);
  const again = await engine.serialize([card]);
  const r2: any = {};
  produce(next, (d) => {
    Object.assign(r2, importFromFigma(d as DesignDoc, again.payload, { pageId: d.pageOrder[0] }));
  });
  assert.equal(r2.created, 0);
  assert.equal(r2.removed, 0);
});

test('plain Figma layers (not from Design Canvas) import as new layers', async () => {
  const { engine, figma } = setup();
  const f = figma.createFrame();
  f.name = 'Hero';
  f.resize(400, 200);
  f.x = 900;
  f.y = 300;
  f.layoutMode = 'HORIZONTAL';
  f.itemSpacing = 12;
  f.paddingTop = f.paddingBottom = 8;
  f.paddingLeft = f.paddingRight = 16;
  f.primaryAxisAlignItems = 'MIN';
  f.counterAxisAlignItems = 'CENTER';
  f.layoutWrap = 'NO_WRAP';
  f.fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 0.5, visible: true }];
  const vec = figma.createRectangle();
  vec.type = 'VECTOR';
  f.appendChild(vec);
  const { payload } = await engine.serialize([f]);
  let result: any;
  const doc = produce(createDoc('X'), (d) => {
    result = importFromFigma(d as DesignDoc, payload, { pageId: d.pageOrder[0] });
  });
  const hero = doc.nodes[result.rootIds[0]] as any;
  assert.equal(hero.x, 0, 'placed at the origin of an empty page');
  assert.deepEqual(hero.layout, { mode: 'row', gap: 12, padding: [8, 16, 8, 16], justify: 'start', align: 'center' });
  assert.deepEqual(hero.fills, [{ type: 'solid', color: 'rgba(0, 0, 0, 0.5)' }]);
  assert.equal(doc.nodes[hero.children[0]].type, 'svg', 'vectors become SVG');
  assert.equal(result.keyMap[f.id], hero.id);
});
