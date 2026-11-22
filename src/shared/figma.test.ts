import { test } from 'node:test';
import assert from 'node:assert/strict';
import { produce } from 'immer';
import { createDoc } from './doc.ts';
import { createComponent, createInstance, createNodes, upsertVariable } from './ops.ts';
import { buildFigmaExport, linearGradientTransform, parseColor, radialGradientTransform, type FigmaSpec } from './figma.ts';
import type { DesignDoc } from './types.ts';

function docWith(fn: (d: DesignDoc, page: string) => void): DesignDoc {
  return produce(createDoc('t'), (d) => fn(d as DesignDoc, d.pageOrder[0]));
}
const find = (specs: FigmaSpec[], name: string): FigmaSpec | undefined => {
  for (const s of specs) {
    if (s.name === name) return s;
    const c = find(s.children ?? [], name);
    if (c) return c;
  }
};

test('parseColor handles hex, rgb(a), hsl and names', () => {
  assert.deepEqual(parseColor('#fff'), { r: 1, g: 1, b: 1, a: 1 });
  assert.deepEqual(parseColor('#00000080'), { r: 0, g: 0, b: 0, a: 0.502 });
  assert.deepEqual(parseColor('rgba(255, 0, 0, 0.5)'), { r: 1, g: 0, b: 0, a: 0.5 });
  assert.deepEqual(parseColor('rgb(0 128 255 / 25%)'), { r: 0, g: 0.502, b: 1, a: 0.25 });
  assert.deepEqual(parseColor('hsl(0, 100%, 50%)'), { r: 1, g: 0, b: 0, a: 1 });
  assert.deepEqual(parseColor('white'), { r: 1, g: 1, b: 1, a: 1 });
  assert.equal(parseColor('color-mix(in srgb, red, blue)'), null);
});

test('gradient transforms reproduce CSS geometry', () => {
  // 180deg = top → bottom: gradient position equals v.
  assert.deepEqual(linearGradientTransform(180, 200, 100)[0], [0, 1, 0]);
  // 90deg = left → right: position equals u.
  assert.deepEqual(linearGradientTransform(90, 200, 100)[0].map((n) => Math.round(n * 1000) / 1000), [1, 0, 0]);
  // 45deg on a square: bottom-left corner → 0, top-right corner → 1.
  const [[a, b, c]] = linearGradientTransform(45, 100, 100);
  assert.ok(Math.abs(a * 0 + b * 1 + c) < 1e-3);
  assert.ok(Math.abs(a * 1 + b * 0 + c - 1) < 1e-3);
  // radial-gradient(circle) reaches the farthest corner.
  const r = radialGradientTransform(100, 100);
  assert.ok(Math.abs(r[0][0] - 0.7071) < 1e-3);
});

test('auto layout, sizing rules and tokens map to Figma', () => {
  const doc = docWith((d, page) => {
    upsertVariable(d, { name: 'brand', value: '#0EA5E9', group: 'color' });
    upsertVariable(d, { name: 'space-4', value: 16 });
    createNodes(
      d,
      [
        {
          type: 'frame',
          name: 'Card',
          width: 320,
          fill: '$brand',
          layout: { mode: 'column', gap: '$space-4', padding: [24, 16], align: 'stretch', justify: 'space-between' },
          radius: 12,
          shadows: '0 4px 12px rgba(0,0,0,0.1)',
          stroke: '1px dashed #E5E7EB',
          children: [
            { type: 'text', name: 'Title', text: 'Hello', fontSize: 20, fontWeight: 600, lineHeight: '150%', textTransform: 'uppercase' },
            { type: 'rect', name: 'Bar', width: 'fill', height: 4 },
            { type: 'rect', name: 'Badge', position: 'absolute', x: 8, y: 8, width: 10, height: 10 },
          ],
        },
      ],
      page,
    );
  });
  const ex = buildFigmaExport(doc, { assetBase: 'http://localhost:4410' });
  const card = find(ex.roots, 'Card')!;
  assert.equal(card.kind, 'FRAME');
  assert.deepEqual(card.layout, {
    mode: 'VERTICAL',
    wrap: false,
    itemSpacing: 16,
    counterAxisSpacing: 0,
    padding: [24, 16, 24, 16],
    primaryAxisAlignItems: 'SPACE_BETWEEN',
    counterAxisAlignItems: 'MIN',
  });
  assert.equal(card.bindings?.itemSpacing, 'space-4');
  assert.deepEqual(card.fills, [{ type: 'SOLID', color: { r: 0.0549, g: 0.6471, b: 0.9137, a: 1 }, visible: true, variable: 'brand' }]);
  assert.deepEqual(card.radius, [12, 12, 12, 12]);
  assert.equal(card.strokeAlign, 'INSIDE');
  assert.deepEqual(card.dashPattern, [3, 3]);
  assert.equal(card.effects?.[0].type, 'DROP_SHADOW');
  assert.equal(card.sizingH, 'FIXED');
  assert.equal(card.sizingV, 'HUG');

  const title = find(ex.roots, 'Title')!;
  // align-items: stretch stretches the hugging text across the column.
  assert.equal(title.sizingH, 'FILL');
  assert.equal(title.text?.textCase, 'UPPER');
  assert.deepEqual(title.text?.lineHeight, { unit: 'PERCENT', value: 150 });
  assert.equal(title.text?.textAutoResize, 'HEIGHT');
  assert.deepEqual(ex.fonts, [{ family: 'Inter', weight: 600, italic: false }]);

  assert.equal(find(ex.roots, 'Bar')!.sizingH, 'FILL');
  const badge = find(ex.roots, 'Badge')!;
  assert.equal(badge.absolute, true);
  assert.equal(badge.inFlow, false);

  assert.deepEqual(
    ex.variables.map((v) => [v.name, v.type]),
    [
      ['color/brand', 'COLOR'],
      ['space-4', 'FLOAT'],
    ],
  );
});

test('components and instances keep their link, overrides and Code Connect', () => {
  let btn = '';
  let label = '';
  let screen = '';
  const doc = docWith((d, page) => {
    btn = createNodes(d, [{ type: 'frame', name: 'Button', x: 900, layout: { mode: 'row', padding: 8 }, children: [{ type: 'text', name: 'Label', text: 'Go' }] }], page).ids[0];
    createComponent(d, btn);
    (d.nodes[btn] as any).codeConnect = { name: 'Button', importPath: '@/ui/button' };
    label = (d.nodes[btn] as any).children[0];
    screen = createNodes(d, [{ type: 'frame', name: 'Screen', layout: { mode: 'column', gap: 8 } }], page).ids[0];
    const inst = createInstance(d, btn, screen);
    (d.nodes[inst] as any).overrides = { [label]: { text: 'Buy now' } };
  });
  // Export only the screen: the component is pulled in as an external component.
  const ex = buildFigmaExport(doc, { nodeIds: [screen], assetBase: 'http://localhost:4410' });
  const inst = ex.roots[0].children![0];
  assert.equal(inst.kind, 'INSTANCE');
  assert.equal(inst.componentKey, btn);
  assert.deepEqual(inst.overrides, [{ path: [label], characters: 'Buy now' }]);
  const comp = ex.components[btn];
  assert.equal(comp.kind, 'COMPONENT');
  assert.equal(comp.external, true);
  assert.equal(comp.x, 900);
  assert.deepEqual(comp.codeConnect, { name: 'Button', importPath: '@/ui/button' });
  assert.equal(ex.stats.instances, 1);

  // Exporting the whole page keeps the component in place (not external).
  const all = buildFigmaExport(doc, { assetBase: 'http://localhost:4410' });
  assert.equal(all.components[btn].external, false);
  assert.equal(find(all.roots, 'Button')!.kind, 'COMPONENT');
});

test('images use absolute URLs and unsupported things become warnings', () => {
  const doc = docWith((d, page) => {
    createNodes(
      d,
      [
        { type: 'image', name: 'Photo', src: '/assets/abc.png', fit: 'contain', width: 100, height: 80 },
        { type: 'text', name: 'Outlined', text: 'x', stroke: '1px solid #000' },
        { type: 'rect', name: 'Missing token', fill: '$nope' },
      ],
      page,
    );
  });
  const ex = buildFigmaExport(doc, { assetBase: 'http://localhost:4410/' });
  assert.deepEqual(ex.images, ['http://localhost:4410/assets/abc.png']);
  const photo = find(ex.roots, 'Photo')!;
  assert.equal(photo.kind, 'RECTANGLE');
  assert.deepEqual(photo.fills, [{ type: 'IMAGE', url: 'http://localhost:4410/assets/abc.png', scaleMode: 'FIT', visible: true }]);
  assert.ok(ex.warnings.some((w) => w.includes('strokes on text')));
  assert.ok(ex.warnings.some((w) => w.includes('$nope')));
});
