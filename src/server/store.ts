import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { produce } from 'immer';
import type { DesignDoc, DocMeta, DocPatch, Origin } from '../shared/types.ts';
import { createDoc, repairDoc } from '../shared/doc.ts';
import { cleanupThreads } from '../shared/comments.ts';
import { applyPatch, diffDocs, isEmptyPatch } from '../shared/patch.ts';
import { DATA_DIR } from './config.ts';

interface Entry {
  doc: DesignDoc;
  version: number;
  saveTimer?: NodeJS.Timeout;
}

export interface PatchEvent {
  docId: string;
  patch: DocPatch;
  version: number;
  origin: Origin;
}

const ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

export class DocStore extends EventEmitter {
  private docs = new Map<string, Entry>();
  /** Most recently opened/edited doc — the default target for AI tools. */
  lastActiveDocId: string | null = null;

  constructor(private dir: string = DATA_DIR) {
    super();
    fs.mkdirSync(dir, { recursive: true });
  }

  private file(id: string) {
    if (!ID_RE.test(id)) throw new Error(`Invalid document id "${id}"`);
    return path.join(this.dir, `${id}.design.json`);
  }

  list(): DocMeta[] {
    const out: DocMeta[] = [];
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.design.json')) continue;
      const id = f.replace('.design.json', '');
      try {
        const doc = this.docs.get(id)?.doc ?? (JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as DesignDoc);
        out.push({
          id: doc.id,
          name: doc.name,
          updatedAt: doc.updatedAt,
          createdAt: doc.createdAt,
          pages: doc.pageOrder.length,
          nodes: Object.keys(doc.nodes).length,
        });
      } catch {
        /* skip broken file */
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  exists(id: string): boolean {
    return this.docs.has(id) || (ID_RE.test(id) && fs.existsSync(this.file(id)));
  }

  get(id: string): Entry {
    let e = this.docs.get(id);
    if (e) return e;
    const f = this.file(id);
    if (!fs.existsSync(f)) throw new Error(`Document "${id}" not found`);
    const doc = JSON.parse(fs.readFileSync(f, 'utf8')) as DesignDoc;
    doc.variables ??= {};
    doc.comments ??= {};
    e = { doc, version: 1 };
    this.docs.set(id, e);
    return e;
  }

  getDoc(id: string): DesignDoc {
    return this.get(id).doc;
  }

  create(name?: string, seed?: (d: DesignDoc) => void): DesignDoc {
    let doc = createDoc(name ?? 'Untitled');
    if (seed) doc = produce(doc, seed);
    this.docs.set(doc.id, { doc, version: 1 });
    this.writeNow(doc.id);
    this.lastActiveDocId = doc.id;
    this.emit('list');
    return doc;
  }

  delete(id: string) {
    const f = this.file(id);
    this.docs.delete(id);
    if (fs.existsSync(f)) fs.renameSync(f, f + '.deleted');
    if (this.lastActiveDocId === id) this.lastActiveDocId = null;
    this.emit('list');
  }

  duplicate(id: string): DesignDoc {
    const src = this.getDoc(id);
    const doc = createDoc(src.name + ' copy');
    const copy: DesignDoc = { ...structuredClone(src), id: doc.id, name: doc.name, createdAt: doc.createdAt, updatedAt: doc.updatedAt };
    this.docs.set(copy.id, { doc: copy, version: 1 });
    this.writeNow(copy.id);
    this.emit('list');
    return copy;
  }

  /** Apply a patch from any origin; returns the patch actually applied (incl. repairs). */
  applyPatch(id: string, patch: DocPatch, origin: Origin): { applied: DocPatch; version: number } {
    const e = this.get(id);
    const before = e.doc;
    let next = applyPatch(before, patch);
    // Repair structural inconsistencies produced by concurrent edits.
    next = produce(next, (d) => {
      repairDoc(d);
      cleanupThreads(d);
    });
    next = { ...next, updatedAt: Date.now() };
    const applied = diffDocs(before, next);
    if (isEmptyPatch(applied)) return { applied, version: e.version };
    e.doc = next;
    e.version++;
    this.scheduleSave(id);
    if (origin.kind !== 'system') this.lastActiveDocId = id;
    this.emit('patch', { docId: id, patch: applied, version: e.version, origin } satisfies PatchEvent);
    return { applied, version: e.version };
  }

  /** Mutate via an immer recipe (used by AI tools). */
  mutate<T>(id: string, origin: Origin, recipe: (draft: DesignDoc) => T): { result: T; patch: DocPatch } {
    const e = this.get(id);
    let result!: T;
    const next = produce(e.doc, (d) => {
      result = recipe(d as DesignDoc);
    });
    const patch = diffDocs(e.doc, next);
    if (!isEmptyPatch(patch)) this.applyPatch(id, patch, origin);
    return { result, patch };
  }

  private scheduleSave(id: string) {
    const e = this.docs.get(id);
    if (!e) return;
    clearTimeout(e.saveTimer);
    e.saveTimer = setTimeout(() => this.writeNow(id), 400);
  }

  writeNow(id: string) {
    const e = this.docs.get(id);
    if (!e) return;
    const f = this.file(id);
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(e.doc, null, 2));
    fs.renameSync(tmp, f);
  }

  flushAll() {
    for (const [id, e] of this.docs) {
      if (e.saveTimer) {
        clearTimeout(e.saveTimer);
        this.writeNow(id);
      }
    }
  }
}
