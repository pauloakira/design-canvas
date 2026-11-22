import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import type { DocStore } from './store.ts';
import type { Hub } from './hub.ts';
import { ASSETS_DIR, loadSettings, PUBLIC_URL, saveSettings } from './config.ts';
import { buildFigmaExport } from '../shared/figma.ts';
import { importFromFigma, type FigmaImportPayload } from '../shared/figma-import.ts';

/**
 * Bridge to the Design Canvas Figma plugin (figma-plugin/).
 *
 * The plugin's UI runs in an iframe with a `null` origin, so these endpoints
 * can't rely on the same-origin check the rest of the API uses. Instead every
 * plugin request must carry the pairing code shown in the editor
 * (Connect → Figma). Only read access + reporting results is exposed.
 */

export const PLUGIN_PREFIX = '/api/figma/plugin';
const TOKEN_HEADER = 'x-design-canvas-token';

export interface OutboxItem {
  id: string;
  docId: string;
  pageId?: string;
  nodeIds: string[];
  label: string;
  createdAt: number;
  claimedAt?: number;
}

export function figmaToken(): string {
  const s = loadSettings();
  if (s.figmaToken) return s.figmaToken;
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(12);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  const token = `DC-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
  saveSettings({ ...s, figmaToken: token });
  return token;
}

function tokenOk(given: unknown): boolean {
  if (typeof given !== 'string' || !given) return false;
  const a = Buffer.from(given.trim().toUpperCase());
  const b = Buffer.from(figmaToken());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Origins the plugin UI can have: sandboxed iframe (`null`) or figma.com. */
export function isPluginOrigin(origin: string | undefined): boolean {
  return origin === 'null' || origin === 'https://www.figma.com' || origin === 'https://figma.com';
}

export function createFigmaBridge(store: DocStore, hub: Hub, rootDir: string) {
  const outbox: OutboxItem[] = [];
  let lastSeen = 0;
  const pluginConnected = () => Date.now() - lastSeen < 6000;

  // ---------------------------------------------------------------- plugin
  const plugin = express.Router();
  plugin.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && isPluginOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', `content-type, ${TOKEN_HEADER}`);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      // Chrome's Private Network Access: figma.com → localhost needs explicit consent.
      if (req.headers['access-control-request-private-network']) res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    if (!tokenOk(req.headers[TOKEN_HEADER])) {
      res.status(401).json({ error: 'Invalid pairing code' });
      return;
    }
    lastSeen = Date.now();
    next();
  });
  plugin.use((req, res, next) => (req.path === '/asset' || req.path === '/import' ? next() : express.json({ limit: '5mb' })(req, res, next)));

  plugin.get('/hello', (_req, res) => res.json({ ok: true, app: 'design-canvas', url: PUBLIC_URL }));

  plugin.get('/docs', (_req, res) => {
    const out = store.list().map((m) => {
      const doc = store.getDoc(m.id);
      return {
        id: m.id,
        name: m.name,
        folder: m.folder,
        updatedAt: m.updatedAt,
        pages: doc.pageOrder.map((pid) => ({
          id: pid,
          name: doc.pages[pid].name,
          layers: doc.pages[pid].children
            .map((id) => doc.nodes[id])
            .filter(Boolean)
            .map((n) => ({ id: n.id, name: n.name, type: n.type, width: n.width, height: n.height })),
        })),
      };
    });
    res.json(out);
  });

  plugin.get('/export', (req, res) => {
    try {
      const docId = String(req.query.doc ?? '');
      const doc = store.getDoc(docId);
      const nodeIds = String(req.query.nodes ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const missing = nodeIds.filter((id) => !doc.nodes[id]);
      const payload = buildFigmaExport(doc, { nodeIds: nodeIds.filter((id) => doc.nodes[id]), pageId: req.query.page ? String(req.query.page) : undefined, assetBase: PUBLIC_URL });
      if (missing.length) payload.warnings.unshift(`${missing.length} layer(s) no longer exist in Design Canvas and were skipped.`);
      res.json(payload);
    } catch (e: any) {
      res.status(404).json({ error: e.message });
    }
  });

  plugin.get('/image', async (req, res) => {
    const url = String(req.query.url ?? '');
    try {
      const local = url.startsWith(PUBLIC_URL + '/assets/') ? url.slice(PUBLIC_URL.length) : url.startsWith('/assets/') ? url : null;
      if (local) {
        const file = path.join(ASSETS_DIR, path.basename(decodeURIComponent(local)));
        res.setHeader('content-type', 'application/octet-stream');
        res.send(fs.readFileSync(file));
        return;
      }
      if (url.startsWith('data:')) {
        const m = url.match(/^data:([^;,]*)(;base64)?,(.*)$/s);
        if (!m) throw new Error('Bad data URL');
        res.send(m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3])));
        return;
      }
      if (!/^https?:\/\//i.test(url)) throw new Error('Unsupported image URL');
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      res.setHeader('content-type', 'application/octet-stream');
      res.send(Buffer.from(await r.arrayBuffer()));
    } catch (e: any) {
      res.status(404).json({ error: `Image unavailable: ${e.message}` });
    }
  });

  /** Image bytes from a Figma image fill → content-addressed asset URL. */
  plugin.post('/asset', express.raw({ type: () => true, limit: '40mb' }), (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) {
      res.status(400).json({ error: 'Empty image' });
      return;
    }
    const ext =
      buf[0] === 0x89 && buf[1] === 0x50 ? 'png' : buf[0] === 0xff && buf[1] === 0xd8 ? 'jpg' : buf.slice(0, 3).toString() === 'GIF' ? 'gif' : buf.slice(8, 12).toString() === 'WEBP' ? 'webp' : null;
    if (!ext) {
      res.status(400).json({ error: 'Unsupported image format' });
      return;
    }
    const name = `${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20)}.${ext}`;
    const file = path.join(ASSETS_DIR, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
    res.json({ url: `/assets/${name}` });
  });

  /** Import serialized Figma layers into a design (new or existing). */
  plugin.post('/import', express.json({ limit: '50mb' }), (req, res) => {
    try {
      const payload = req.body?.payload as FigmaImportPayload;
      if (!payload || !Array.isArray(payload.roots) || !payload.roots.length) throw new Error('Nothing to import');
      let docId = typeof req.body?.docId === 'string' ? req.body.docId : '';
      if (!docId) {
        const name = String(req.body?.newDocName || payload.roots[0]?.name || payload.fileName || 'From Figma').slice(0, 120);
        docId = store.create(name, undefined, typeof req.body?.folder === 'string' ? req.body.folder : undefined).id;
        hub.broadcast(null, { t: 'docs-changed' });
      }
      const doc = store.getDoc(docId);
      const pageId = req.body?.pageId && doc.pages[req.body.pageId] ? String(req.body.pageId) : doc.pageOrder[0];
      const { result } = store.mutate(docId, { kind: 'agent', name: 'Figma', tool: 'import' }, (d) => importFromFigma(d, payload, { pageId }));
      hub.broadcast(docId, { t: 'reveal', ids: result.rootIds, agent: 'Figma' });
      hub.broadcast(docId, { t: 'figma-imported', created: result.created, updated: result.updated, removed: result.removed, warnings: result.warnings.slice(0, 50) });
      res.json({ ...result, docId, docName: store.getDoc(docId).name, pageId, url: `${PUBLIC_URL}/d/${docId}` });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  plugin.get('/outbox', (_req, res) => {
    const now = Date.now();
    // Drop stale requests (nobody had the plugin open).
    for (let i = outbox.length - 1; i >= 0; i--) if (now - outbox[i].createdAt > 10 * 60_000) outbox.splice(i, 1);
    const items = outbox.filter((i) => !i.claimedAt);
    for (const i of items) i.claimedAt = now;
    res.json(items);
  });

  plugin.post('/result', (req, res) => {
    const id = String(req.body?.id ?? '');
    const item = outbox.find((i) => i.id === id);
    if (item) outbox.splice(outbox.indexOf(item), 1);
    const report = req.body?.report;
    hub.broadcast(item?.docId ?? null, {
      t: 'figma-result',
      id,
      ok: !!req.body?.ok,
      error: req.body?.error ? String(req.body.error) : undefined,
      file: typeof req.body?.file === 'string' ? req.body.file : undefined,
      report: report
        ? {
            created: Number(report.created) || 0,
            updated: Number(report.updated) || 0,
            removed: Number(report.removed) || 0,
            components: Number(report.components) || 0,
            instances: Number(report.instances) || 0,
            warnings: Array.isArray(report.warnings) ? report.warnings.slice(0, 50).map(String) : [],
          }
        : undefined,
    });
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- editor
  /** Queue nodes for the plugin. Used by the editor, the REST API and MCP. */
  function send(docId: string, nodeIds: string[], pageId?: string): { id: string; pluginConnected: boolean; layers: number } {
    const doc = store.getDoc(docId);
    const ids = nodeIds.filter((id) => doc.nodes[id]);
    const page = pageId && doc.pages[pageId] ? pageId : doc.pageOrder[0];
    const layers = ids.length ? ids.length : (doc.pages[page]?.children.length ?? 0);
    if (!layers) throw new Error('Nothing to send: select layers or use a page that has content.');
    const label = ids.length === 1 ? doc.nodes[ids[0]].name : ids.length ? `${doc.name} (${ids.length} layers)` : `${doc.name} — ${doc.pages[page].name}`;
    const item: OutboxItem = { id: crypto.randomUUID(), docId, pageId: page, nodeIds: ids, label, createdAt: Date.now() };
    outbox.push(item);
    return { id: item.id, pluginConnected: pluginConnected(), layers };
  }

  const editor = express.Router();
  editor.use(express.json());
  editor.get('/status', (_req, res) => {
    res.json({ token: figmaToken(), pluginConnected: pluginConnected(), lastSeen: lastSeen || null, manifestPath: path.join(rootDir, 'figma-plugin', 'manifest.json') });
  });
  editor.post('/send', (req, res) => {
    try {
      const ids = Array.isArray(req.body?.nodeIds) ? req.body.nodeIds.map(String) : [];
      res.json(send(String(req.body?.docId ?? ''), ids, req.body?.pageId ? String(req.body.pageId) : undefined));
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });
  editor.post('/token/reset', (_req, res) => {
    const s = loadSettings();
    delete s.figmaToken;
    saveSettings(s);
    res.json({ token: figmaToken() });
  });

  return { plugin, editor, send, pluginConnected };
}
