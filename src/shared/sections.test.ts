import { test } from 'node:test';
import assert from 'node:assert/strict';
import { produce } from 'immer';
import { createDoc, firstPageId, repairDoc, resolvePageId, sectionOf } from './doc.ts';
import { addPage, createNodes, deletePage, movePages } from './ops.ts';
import type { DesignDoc } from './types.ts';

/** Builds: [S1] A B [S2] C, with a layer on A. Returns the doc and ids by name. */
function setup() {
  const ids: Record<string, string> = {};
  const doc = produce(createDoc('t'), (draft) => {
    const d = draft as DesignDoc;
    ids.home = d.pageOrder[0];
    d.pages[ids.home].name = 'Home';
    ids.S1 = addPage(d, 'Ideation', { section: true });
    ids.A = addPage(d, 'A');
    ids.B = addPage(d, 'B');
    ids.S2 = addPage(d, 'Ready', { section: true });
    ids.C = addPage(d, 'C');
    createNodes(d, [{ type: 'rect', name: 'R' }], ids.A);
  });
  return { doc, ids };
}
const names = (d: DesignDoc) => d.pageOrder.map((p) => d.pages[p].name);

test('sections are list entries without layers', () => {
  const { doc, ids } = setup();
  assert.deepEqual(names(doc), ['Home', 'Ideation', 'A', 'B', 'Ready', 'C']);
  assert.equal(doc.pages[ids.S1].kind, 'section');
  assert.equal(sectionOf(doc, ids.B), ids.S1);
  assert.equal(sectionOf(doc, ids.home), null);
  assert.equal(resolvePageId(doc, ids.S2), ids.home, 'a section id falls back to a real page');
  assert.throws(() => produce(doc, (d) => void createNodes(d as DesignDoc, [{ type: 'rect' }], ids.S1)), /section/);
});

test('first page skips leading sections', () => {
  const { doc, ids } = setup();
  const d2 = produce(doc, (d) => void movePages(d as DesignDoc, [ids.S1], d.pageOrder[0]));
  assert.deepEqual(names(d2), ['Ideation', 'A', 'B', 'Home', 'Ready', 'C']);
  assert.equal(firstPageId(d2), ids.A);
});

test('new pages can be inserted after a given entry', () => {
  const { doc, ids } = setup();
  const d2 = produce(doc, (d) => void addPage(d as DesignDoc, 'A2', { after: ids.A }));
  assert.deepEqual(names(d2), ['Home', 'Ideation', 'A', 'A2', 'B', 'Ready', 'C']);
  assert.equal(names(d2).filter((n) => n.startsWith('Page')).length, 0);
  const d3 = produce(doc, (d) => void addPage(d as DesignDoc));
  assert.equal(d3.pages[d3.pageOrder.at(-1)!].name, 'Page 5', 'default names count pages only');
});

test('moving a section carries its pages; moving a page changes its section', () => {
  const { doc, ids } = setup();
  const d2 = produce(doc, (d) => void movePages(d as DesignDoc, [ids.S2], ids.S1));
  assert.deepEqual(names(d2), ['Home', 'Ready', 'C', 'Ideation', 'A', 'B']);
  const d3 = produce(doc, (d) => void movePages(d as DesignDoc, [ids.A], null));
  assert.deepEqual(names(d3), ['Home', 'Ideation', 'B', 'Ready', 'C', 'A']);
  assert.equal(sectionOf(d3, ids.A), ids.S2);
  const same = produce(doc, (d) => void movePages(d as DesignDoc, [ids.S1], ids.A));
  assert.deepEqual(names(same), names(doc), 'cannot drop a section inside itself');
});

test('deleting a section keeps its pages; the last page cannot be deleted', () => {
  const { doc, ids } = setup();
  const d2 = produce(doc, (d) => void deletePage(d as DesignDoc, ids.S1));
  assert.deepEqual(names(d2), ['Home', 'A', 'B', 'Ready', 'C']);
  assert.ok(d2.nodes[d2.pages[ids.A].children[0]], 'layers on its pages survive');
  let only = produce(createDoc('t'), (d) => void addPage(d as DesignDoc, 'S', { section: true }));
  assert.throws(() => produce(only, (d) => void deletePage(d as DesignDoc, firstPageId(d as DesignDoc))), /at least one page/);
  only = produce(only, (d) => void deletePage(d as DesignDoc, d.pageOrder[1]));
  assert.equal(only.pageOrder.length, 1);
});

test('repair moves layers out of a section', () => {
  const { doc, ids } = setup();
  const broken = produce(doc, (draft) => {
    const d = draft as DesignDoc;
    const rid = d.pages[ids.A].children[0];
    d.pages[ids.A].children = [];
    d.pages[ids.S1].children = [rid];
    d.nodes[rid].parentId = ids.S1;
  });
  const fixed = produce(broken, (d) => void repairDoc(d as DesignDoc));
  assert.equal(fixed.pages[ids.S1].children.length, 0);
  assert.equal(fixed.pages[ids.home].children.length, 1);
});
