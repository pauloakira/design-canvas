import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DESIGN_CANVAS_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'dc-config-'));
const { DocStore, normalizeFolder } = await import('./store.ts');

test('normalizeFolder cleans paths and rejects unsafe names', () => {
  assert.equal(normalizeFolder(' Marketing // Landing/ '), 'Marketing/Landing');
  assert.equal(normalizeFolder(undefined), '');
  assert.equal(normalizeFolder(''), '');
  for (const bad of ['..', 'a/../b', '.git', 'assets', 'x/.hidden', 'a:b']) assert.throws(() => normalizeFolder(bad), bad);
});

test('folders are real directories: create, move docs, rename, delete keeps designs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-store-'));
  try {
    const store = new DocStore(dir);
    const a = store.create('A');
    const b = store.create('B', undefined, 'Mobile/Onboarding');
    assert.ok(fs.existsSync(path.join(dir, 'Mobile', 'Onboarding', `${b.id}.design.json`)));
    assert.deepEqual(store.folders(), ['Mobile', 'Mobile/Onboarding']);
    assert.equal(store.list().find((d) => d.id === b.id)?.folder, 'Mobile/Onboarding');

    // Move a doc (pending edits are flushed to the new location).
    store.mutate(a.id, { kind: 'system' }, (d) => void (d.name = 'A2'));
    store.moveDoc(a.id, 'Mobile');
    assert.ok(!fs.existsSync(path.join(dir, `${a.id}.design.json`)));
    store.flushAll();
    const moved = JSON.parse(fs.readFileSync(path.join(dir, 'Mobile', `${a.id}.design.json`), 'utf8'));
    assert.equal(moved.name, 'A2');

    // A fresh store (server restart) finds everything by scanning.
    const again = new DocStore(dir);
    assert.equal(again.getDoc(b.id).name, 'B');
    assert.equal(again.folderOfDoc(a.id), 'Mobile');

    // Rename a folder with its subfolders.
    store.moveFolder('Mobile', 'App');
    assert.deepEqual(store.folders(), ['App', 'App/Onboarding']);
    assert.equal(store.folderOfDoc(b.id), 'App/Onboarding');
    assert.throws(() => store.moveFolder('App', 'App/Onboarding/X'), /into itself/);

    // Edits after a folder rename still save to the right file.
    store.mutate(b.id, { kind: 'system' }, (d) => void (d.name = 'B2'));
    store.flushAll();
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'App', 'Onboarding', `${b.id}.design.json`), 'utf8')).name, 'B2');

    // Deleting a folder moves its contents up instead of deleting them.
    const r = store.deleteFolder('App');
    assert.equal(r.movedTo, '');
    assert.deepEqual(store.folders(), ['Onboarding']);
    assert.equal(store.folderOfDoc(a.id), '');
    assert.equal(store.folderOfDoc(b.id), 'Onboarding');
    assert.equal(store.list().length, 2);
    assert.ok(!store.folders().includes('assets'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
