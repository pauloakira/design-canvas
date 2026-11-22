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
const EXT = '.design.json';
/** Top-level directories of the data dir that are not user folders. */
const RESERVED = new Set(['assets', 'node_modules']);

/**
 * Normalize a folder path ("Marketing/Landing pages"). '' is the root.
 * Folders are real subdirectories of the data dir, so they show up in git as-is.
 */
export function normalizeFolder(input: unknown): string {
  if (input == null) return '';
  if (typeof input !== 'string') throw new Error('Folder must be a string path like "Marketing/Landing"');
  const parts = input
    .split(/[\\/]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  for (const p of parts) {
    if (p === '.' || p === '..' || p.startsWith('.')) throw new Error(`Invalid folder name "${p}"`);
    if (p.length > 80 || /[\x00-\x1f<>:"|?*]/.test(p)) throw new Error(`Invalid folder name "${p}"`);
  }
  if (parts.length > 8) throw new Error('Folders can be nested at most 8 levels deep');
  if (parts.length && RESERVED.has(parts[0].toLowerCase())) throw new Error(`"${parts[0]}" is reserved`);
  return parts.join('/');
}

export function folderName(folder: string) {
  return folder.split('/').pop() ?? '';
}

export function parentFolder(folder: string) {
  return folder.split('/').slice(0, -1).join('/');
}

export class DocStore extends EventEmitter {
  private docs = new Map<string, Entry>();
  /** Document id → folder ('' = root), rebuilt by scanning the data dir. */
  private folderOf = new Map<string, string>();
  private folderSet = new Set<string>();
  /** Most recently opened/edited doc — the default target for AI tools. */
  lastActiveDocId: string | null = null;

  constructor(private dir: string = DATA_DIR) {
    super();
    fs.mkdirSync(dir, { recursive: true });
    this.scan();
  }

  private abs(folder: string) {
    return path.join(this.dir, ...(folder ? folder.split('/') : []));
  }

  /** Walk the data dir: index every document's folder and collect all folders. */
  private scan() {
    this.folderOf.clear();
    this.folderSet.clear();
    const walk = (folder: string, depth: number) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(this.abs(folder), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.isDirectory()) {
          if (e.name.startsWith('.') || (!folder && RESERVED.has(e.name.toLowerCase())) || depth >= 8) continue;
          const sub = folder ? `${folder}/${e.name}` : e.name;
          this.folderSet.add(sub);
          walk(sub, depth + 1);
        } else if (e.isFile() && e.name.endsWith(EXT)) {
          const id = e.name.slice(0, -EXT.length);
          if (ID_RE.test(id) && !this.folderOf.has(id)) this.folderOf.set(id, folder);
        }
      }
    };
    walk('', 0);
  }

  private file(id: string) {
    if (!ID_RE.test(id)) throw new Error(`Invalid document id "${id}"`);
    if (!this.folderOf.has(id)) this.scan();
    return path.join(this.abs(this.folderOf.get(id) ?? ''), `${id}${EXT}`);
  }

  folderOfDoc(id: string): string {
    if (!this.folderOf.has(id)) this.scan();
    return this.folderOf.get(id) ?? '';
  }

  list(): DocMeta[] {
    this.scan();
    const out: DocMeta[] = [];
    for (const [id, folder] of this.folderOf) {
      try {
        const doc = this.docs.get(id)?.doc ?? (JSON.parse(fs.readFileSync(path.join(this.abs(folder), id + EXT), 'utf8')) as DesignDoc);
        out.push({
          id: doc.id,
          name: doc.name,
          folder,
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

  /** All folders (sorted, '/'-separated, root excluded). */
  folders(): string[] {
    this.scan();
    return [...this.folderSet].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
  }

  createFolder(input: string): string {
    const folder = normalizeFolder(input);
    if (!folder) throw new Error('Folder name is required');
    fs.mkdirSync(this.abs(folder), { recursive: true });
    this.scan();
    this.emit('list');
    return folder;
  }

  /** Rename or move a folder (with everything in it). */
  moveFolder(fromInput: string, toInput: string): string {
    const from = normalizeFolder(fromInput);
    const to = normalizeFolder(toInput);
    if (!from || !to) throw new Error('Both folder paths are required');
    if (from === to) return to;
    if (to.startsWith(from + '/')) throw new Error("A folder can't be moved into itself");
    if (!fs.existsSync(this.abs(from))) throw new Error(`Folder "${from}" not found`);
    const caseOnly = from.toLowerCase() === to.toLowerCase();
    if (fs.existsSync(this.abs(to)) && !caseOnly) throw new Error(`A folder named "${to}" already exists`);
    this.flushAll();
    fs.mkdirSync(path.dirname(this.abs(to)), { recursive: true });
    fs.renameSync(this.abs(from), this.abs(to));
    this.scan();
    this.emit('list');
    return to;
  }

  /** Delete a folder. Its designs and subfolders move up to the parent folder — nothing is lost. */
  deleteFolder(input: string): { movedTo: string; moved: number } {
    const folder = normalizeFolder(input);
    if (!folder) throw new Error("The root folder can't be deleted");
    const dir = this.abs(folder);
    if (!fs.existsSync(dir)) throw new Error(`Folder "${folder}" not found`);
    const parent = parentFolder(folder);
    const parentDir = this.abs(parent);
    this.flushAll();
    let moved = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(parentDir, e.name);
      if (fs.existsSync(target)) {
        if (e.isDirectory()) throw new Error(`"${parent || 'the root'}" already has a folder named "${e.name}". Rename it first.`);
        continue; // stale/duplicate file: leave it, rmSync below won't run
      }
      fs.renameSync(path.join(dir, e.name), target);
      if (e.name.endsWith(EXT)) moved++;
    }
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    this.scan();
    this.emit('list');
    return { movedTo: parent, moved };
  }

  /** Move a document into another folder ('' = root). */
  moveDoc(id: string, input: string): string {
    const folder = normalizeFolder(input);
    const src = this.file(id);
    if (!fs.existsSync(src)) throw new Error(`Document "${id}" not found`);
    if ((this.folderOf.get(id) ?? '') === folder) return folder;
    const e = this.docs.get(id);
    if (e?.saveTimer) {
      clearTimeout(e.saveTimer);
      e.saveTimer = undefined;
      this.writeNow(id);
    }
    fs.mkdirSync(this.abs(folder), { recursive: true });
    fs.renameSync(src, path.join(this.abs(folder), id + EXT));
    this.folderOf.set(id, folder);
    this.folderSet.add(folder);
    this.emit('list');
    return folder;
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

  create(name?: string, seed?: (d: DesignDoc) => void, folderInput?: string): DesignDoc {
    const folder = normalizeFolder(folderInput);
    let doc = createDoc(name ?? 'Untitled');
    if (seed) doc = produce(doc, seed);
    if (folder) fs.mkdirSync(this.abs(folder), { recursive: true });
    this.folderOf.set(doc.id, folder);
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
    this.folderOf.delete(id);
    if (this.lastActiveDocId === id) this.lastActiveDocId = null;
    this.emit('list');
  }

  duplicate(id: string): DesignDoc {
    const src = this.getDoc(id);
    const doc = createDoc(src.name + ' copy');
    const copy: DesignDoc = { ...structuredClone(src), id: doc.id, name: doc.name, createdAt: doc.createdAt, updatedAt: doc.updatedAt };
    this.folderOf.set(copy.id, this.folderOfDoc(id));
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
    fs.mkdirSync(path.dirname(f), { recursive: true });
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
