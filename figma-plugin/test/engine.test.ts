import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { produce } from 'immer';
import { createFakeFigma } from './fake-figma.mjs';
import { createDoc } from '../../src/shared/doc.ts';
import { createComponent, createInstance, createNodes, upsertVariable } from '../../src/shared/ops.ts';
import { buildFigmaExport } from '../../src/shared/figma.ts';
import type { DesignDoc } from '../../src/shared/types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineSrc = fs.readFileSync(path.join(here, '..', 'src', 'engine.js'), 'utf8');

/** Load the engine exactly like the plugin bundle does, against a fake `figma`. */
function setup() {
  const fake = createFakeFigma();
  (globalThis as any).figma = fake.figma;
  const make = new Function(`${engineSrc}\nreturn dcCreateApplier;`)();
  return { ...fake, applier: make() };
}

function sampleDoc() {
  const ids: Record<string, string> = {};
  const doc = produce(createDoc('Parity'), (d0) => {
    const d = d0 as DesignDoc;
    const page = d.pageOrder[0];
    upsertVariable(d, { name: 'primary', value: '#4F46E5', group: 'color' });
    upsertVariable(d, { name: 'space-4', value: 16 });
    ids.btn = createNodes(d, [{ type: 'frame', name: 'Button', x: 0, y: 500, fill: '$primary', radius: 10, layout: { mode: 'row', padding: [10, 18] }, children: [{ type: 'text', name: 'Label', text: 'Get started', fontWeight: 600, color: '#fff' }] }], page).ids[0];
    createComponent(d, ids.btn);
    (d.nodes[ids.btn] as any).codeConnect = { name: 'Button', importPath: '@/components/ui/button' };
    ids.label = (d.nodes[ids.btn] as any).children[0];
    ids.screen = createNodes(d, [{ type: 'frame', name: 'Screen', width: 400, layout: { mode: 'column', gap: '$space-4', padding: 24, align: 'stretch' }, children: [
      { type: 'text', name: 'Title', text: 'Hello', fontSize: 24, fontWeight: 700 },
      { type: 'rect', name: 'Divider', width: 'fill', height: 1, fill: '#E5E7EB' },
      { type: 'svg', name: 'Icon', width: 20, height: 20, svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#000"/></svg>' },
    ] }], page).ids[0];
    ids.inst = createInstance(d, ids.btn, ids.screen);
    (d.nodes[ids.inst] as any).overrides = { [ids.label]: { text: 'Buy now' } };
  });
  return { doc, ids };
}

const exportOf = (doc: DesignDoc, nodeIds?: string[]) => buildFigmaExport(doc, { nodeIds, assetBase: 'http://localhost:4410' });
const tagged = (figma: any) => figma.root.findAllWithCriteria({ sharedPluginData: { namespace: 'designcanvas', keys: ['key'] } }).filter((n: any) => !n.id.startsWith('I'));

test('engine builds auto layout, components, linked instances and variables', async () => {
  const { figma, applier, variables } = setup();
  const { doc, ids } = sampleDoc();
  const { report, nodes } = await applier.apply(exportOf(doc), {});
  assert.equal(report.warnings.length, 0, report.warnings.join('\n'));
  assert.equal(nodes.length, 2);
  const screen = nodes.find((n: any) => n.name === 'Screen');
  const comp = nodes.find((n: any) => n.type === 'COMPONENT');
  assert.equal(screen.layoutMode, 'VERTICAL');
  assert.equal(screen.layoutSizingVertical, 'HUG');
  assert.equal(screen.bound.itemSpacing, variables.find((v: any) => v.name === 'space-4').id);
  const [title, divider, icon, inst] = screen.children;
  assert.equal(title.layoutSizingHorizontal, 'FILL', 'stretch → fill');
  assert.equal(title.fontName.style, 'Bold');
  assert.deepEqual(title.lineHeight, { unit: 'PERCENT', value: 140 });
  assert.equal(divider.layoutSizingHorizontal, 'FILL');
  assert.equal(icon.getSharedPluginData('designcanvas', 'kind'), 'SVG');
  assert.equal(inst.type, 'INSTANCE');
  assert.equal(inst.mainComponent, comp, 'instance is linked to the exported main component');
  assert.equal(inst.children[0].characters, 'Buy now', 'text override applied');
  assert.equal(comp.children[0].characters, 'Get started');
  assert.equal(comp.description, "Code: <Button /> from '@/components/ui/button'");
  assert.equal(comp.fills[0].boundVariables.color.id, variables.find((v: any) => v.name === 'color/primary').id);
  assert.equal(variables.find((v: any) => v.name === 'color/primary').codeSyntax.WEB, 'var(--primary)');
  assert.equal(figma.currentPage.children.length, 2);
  void ids;
});

test('sending again updates in place: same layers, component edits, removals, user layers kept', async () => {
  const { figma, applier } = setup();
  let { doc, ids } = sampleDoc();
  await applier.apply(exportOf(doc), {});
  const before = new Map(tagged(figma).map((n: any) => [n.getSharedPluginData('designcanvas', 'key'), n]));
  const screen = figma.currentPage.children.find((n: any) => n.name === 'Screen');
  // A designer moves the frame and adds their own sticky note in Figma.
  screen.x = 1234;
  const note = figma.createText();
  screen.appendChild(note);

  // Idempotent: nothing created or removed.
  const again = await applier.apply(exportOf(doc), {});
  assert.equal(again.report.created, 0);
  assert.equal(again.report.removed, 0);
  assert.equal(again.report.foreignKept, 1);
  assert.equal(screen.x, 1234, 'user position of an existing root is kept');
  for (const n of tagged(figma)) assert.equal(before.get(n.getSharedPluginData('designcanvas', 'key')), n, 'same Figma node reused');

  // Change the component, delete a layer, add a layer.
  doc = produce(doc, (d) => {
    (d.nodes[ids.label] as any).text = 'Start now';
    (d.nodes[ids.btn] as any).name = 'Button / primary';
    const scr = d.nodes[ids.screen] as any;
    const divider = scr.children[1];
    scr.children.splice(1, 1);
    delete d.nodes[divider];
    createNodes(d as DesignDoc, [{ type: 'text', name: 'Subtitle', text: 'Welcome back' }], ids.screen, 1);
  });
  const third = await applier.apply(exportOf(doc), {});
  assert.equal(third.report.created, 1);
  assert.equal(third.report.removed, 1);
  const comp = figma.currentPage.children.find((n: any) => n.type === 'COMPONENT');
  assert.equal(comp, before.get(`${doc.id}/${ids.btn}`), 'main component keeps its identity');
  assert.equal(comp.name, 'Button / primary');
  assert.equal(comp.children[0].characters, 'Start now');
  assert.deepEqual(
    screen.children.map((c: any) => c.name),
    ['Title', 'Subtitle', 'Icon', 'Button', 'TEXT'], // instances keep their own layer name
  );
  const inst = screen.children[3];
  assert.equal(inst.mainComponent, comp);
  assert.equal(inst.children[0].characters, 'Buy now', 'override survives the update');
});

test('a component sent on its own lands on the components page and is reused later', async () => {
  const { figma, applier } = setup();
  const { doc, ids } = sampleDoc();
  await applier.apply(exportOf(doc, [ids.screen]), {});
  const compPage = figma.root.children.find((p: any) => p.name === 'Design Canvas components');
  assert.ok(compPage, 'components page created');
  assert.equal(compPage.children[0].type, 'COMPONENT');
  // Sending the whole page later moves the same component next to the screen.
  const r = await applier.apply(exportOf(doc), {});
  assert.equal(r.report.created, 0);
  assert.equal(r.report.components, 1);
  assert.equal(applier.syncedDocs()[doc.id].keys.length, 2);
});
