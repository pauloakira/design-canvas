import { test } from 'node:test';
import assert from 'node:assert/strict';
import { produce } from 'immer';
import { createDoc, repairDoc } from './doc.ts';
import { applyPatch, diffDocs, invertPatch } from './patch.ts';
import { normalizeProps, toPadding, toShadows } from './normalize.ts';
import { createComponent, createInstance, createNodes, detachInstance, moveNodes, upsertVariable, wrapInFrame } from './ops.ts';
import { cssToTailwind, generateCode } from './codegen.ts';
import { nodeStyle } from './style.ts';
import type { DesignDoc, FrameNode, TextNode } from './types.ts';

function docWith(fn: (d: DesignDoc, page: string) => void): DesignDoc {
  return produce(createDoc('t'), (d) => fn(d as DesignDoc, d.pageOrder[0]));
}

test('normalize accepts LLM-friendly shorthands', () => {
  const p = normalizeProps({ type: 'frame', fill: '#fff', padding: [8, 16], gap: 12, direction: 'row', radius: '$radius-md', width: 'fill', stroke: '1px dashed #ccc' });
  assert.deepEqual(p.fills, [{ type: 'solid', color: '#fff' }]);
  assert.deepEqual((p as any).layout, { mode: 'row', gap: 12, padding: [8, 16, 8, 16] });
  assert.equal(p.radius, '$radius-md');
  assert.equal(p.widthMode, 'fill');
  assert.deepEqual(p.stroke, { color: '#ccc', width: 1, style: 'dashed', align: 'inside' });
  const t = normalizeProps({ type: 'text', content: 'Hi', color: 'var(--primary)', fontWeight: 'semibold', lineHeight: 1.5 });
  assert.equal(t.text, 'Hi');
  assert.deepEqual(t.fills, [{ type: 'solid', color: '$primary' }]);
  assert.equal(t.fontWeight, 600);
  assert.equal(t.lineHeight, '150%');
  assert.deepEqual(toPadding({ x: 4, y: 2 }), [2, 4, 2, 4]);
});

test('Tailwind placeholder shadows are dropped', () => {
  const s = toShadows('0 0 #0000, 0 0 #0000, 0 4px 6px -1px rgba(0,0,0,0.1)');
  assert.equal(s!.length, 1);
  assert.equal(s![0].blur, 6);
});

test('createNodes builds nested trees with auto-layout defaults', () => {
  const doc = docWith((d, page) => {
    createNodes(d, [{ type: 'frame', name: 'Card', layout: { mode: 'column', gap: 8 }, children: [{ type: 'text', text: 'Hello' }, { type: 'rect', width: 'fill', height: 4 }] }], page);
  });
  const card = Object.values(doc.nodes).find((n) => n.name === 'Card') as FrameNode;
  assert.equal(card.children.length, 2);
  assert.equal(card.widthMode, 'hug');
  assert.deepEqual(card.fills, [{ type: 'solid', color: '#FFFFFF' }], 'top-level frames get a white fill');
  const rect = doc.nodes[card.children[1]];
  assert.equal(rect.widthMode, 'fill');
  assert.equal(rect.parentId, card.id);
});

test('patch diff / apply / invert round-trips', () => {
  const a = docWith((d, page) => {
    createNodes(d, [{ type: 'rect', name: 'A', x: 0, y: 0 }], page);
  });
  const id = Object.keys(a.nodes)[0];
  const b = produce(a, (d) => {
    d.nodes[id].x = 50;
  });
  const p = diffDocs(a, b);
  assert.deepEqual(Object.keys(p.nodes!), [id]);
  assert.equal(applyPatch(a, p).nodes[id].x, 50);
  assert.equal(applyPatch(b, invertPatch(a, p)).nodes[id].x, 0);
});

test('repairDoc fixes orphans and dangling children', () => {
  const doc = docWith((d, page) => {
    createNodes(d, [{ type: 'frame', name: 'F', children: [{ type: 'rect', name: 'R' }] }], page);
  });
  const broken = produce(doc, (d) => {
    const f = Object.values(d.nodes).find((n) => n.name === 'F') as FrameNode;
    f.children = ['ghost'];
    repairDoc(d as DesignDoc);
  });
  const f = Object.values(broken.nodes).find((n) => n.name === 'F') as FrameNode;
  const r = Object.values(broken.nodes).find((n) => n.name === 'R')!;
  assert.deepEqual(f.children, [r.id]);
});

test('components, instances with overrides, and detach', () => {
  let instId = '';
  let labelId = '';
  const doc = docWith((d, page) => {
    const [btn] = createNodes(d, [{ type: 'frame', name: 'Button', layout: { mode: 'row', padding: 8 }, children: [{ type: 'text', name: 'Label', text: 'Go' }] }], page).ids;
    createComponent(d, btn);
    labelId = (d.nodes[btn] as FrameNode).children[0];
    instId = createInstance(d, btn, page, { x: 200 });
    (d.nodes[instId] as any).overrides = { [labelId]: { text: 'Buy now' } };
    (d.nodes[btn] as any).codeConnect = { name: 'Button', importPath: '@/ui/button' };
  });
  const code = generateCode(doc, instId, { framework: 'react-tailwind' }).code;
  assert.match(code, /import \{ Button \} from '@\/ui\/button';/);
  assert.match(code, /<Button>Buy now<\/Button>/);
  const detached = produce(doc, (d) => {
    detachInstance(d as DesignDoc, instId);
  });
  const f = detached.nodes[instId] as FrameNode;
  assert.equal(f.type, 'frame');
  assert.equal((detached.nodes[f.children[0]] as TextNode).text, 'Buy now');
});

test('codegen: React + Tailwind and HTML use the canvas styles', () => {
  let id = '';
  const doc = docWith((d, page) => {
    upsertVariable(d, { name: 'brand', value: '#0EA5E9' });
    id = createNodes(d, [{ type: 'frame', name: 'Hero section', width: 640, fill: '$brand', layout: { mode: 'column', gap: 16, padding: 24, align: 'center' }, children: [{ type: 'text', text: 'Hello {world}', fontSize: 32, fontWeight: 700, color: '#fff' }] }], page).ids[0];
  });
  const r = generateCode(doc, id, { framework: 'react-tailwind' });
  assert.equal(r.componentName, 'HeroSection');
  assert.match(r.code, /w-\[640px\] flex flex-col gap-4 p-6 items-center bg-\[var\(--brand\)\]/);
  assert.match(r.code, /\{"Hello \{world\}"\}/, 'braces are escaped in JSX');
  assert.equal(r.tokensCss, ':root {\n  --brand: #0EA5E9;\n}');
  const html = generateCode(doc, id, { framework: 'html' }).code;
  assert.match(html, /\.hero-section \{[\s\S]*gap: 16px;/);
  assert.match(html, /fonts\.googleapis\.com/);
});

test('style: fill in auto-layout maps to flex / stretch', () => {
  const parent = { type: 'frame', layout: { mode: 'row' } } as any;
  const s = nodeStyle({ id: 'a', type: 'rect', name: 'r', parentId: 'p', x: 0, y: 0, width: 10, height: 10, widthMode: 'fill', heightMode: 'fill' }, { parent });
  assert.equal(s.flex, '1 1 0px');
  assert.equal(s.alignSelf, 'stretch');
  assert.equal(s.width, undefined);
  assert.deepEqual(cssToTailwind({ padding: '8px 16px', borderRadius: '50%', opacity: '0.5' }).classes, ['px-4', 'py-2', 'rounded-full', 'opacity-50']);
});

test('moveNodes preserves visual position across parents and wrapInFrame groups', () => {
  let frame = '';
  let rect = '';
  const doc = docWith((d, page) => {
    frame = createNodes(d, [{ type: 'frame', name: 'F', x: 100, y: 100, width: 300, height: 300 }], page).ids[0];
    rect = createNodes(d, [{ type: 'rect', name: 'R', x: 150, y: 160, width: 20, height: 20 }], page).ids[0];
    moveNodes(d, [rect], frame);
  });
  assert.equal(doc.nodes[rect].x, 50);
  assert.equal(doc.nodes[rect].y, 60);
  const grouped = produce(doc, (d) => {
    wrapInFrame(d as DesignDoc, [rect], { name: 'G' });
  });
  const g = Object.values(grouped.nodes).find((n) => n.name === 'G')!;
  assert.equal(g.parentId, frame);
  assert.equal(g.x, 50);
  assert.equal(grouped.nodes[rect].x, 0);
});
