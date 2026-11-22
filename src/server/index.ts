import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer } from 'ws';
import { ASSETS_DIR, DATA_DIR, HOST, loadSettings, PORT, PROJECT_DIR, PUBLIC_URL, saveSettings, type Settings } from './config.ts';
import { DocStore, normalizeFolder } from './store.ts';
import { Hub } from './hub.ts';
import { createMcpHandlers } from './mcp.ts';
import { cancelRun, providerStatus, runChat, type ChatRequest } from './ai.ts';
import { TOOLS } from './tools.ts';
import { seedWelcome } from './seed.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = path.join(ROOT, 'dist');

const store = new DocStore();
const hub = new Hub(store);
if (!store.list().length) seedWelcome(store);

const app = express();
app.disable('x-powered-by');

// --- Security: this server can edit files and launch local agents, so only
// accept requests addressed to localhost (blocks DNS rebinding) from local
// pages (blocks cross-site requests from arbitrary websites).
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin || origin === 'null') return !origin;
  try {
    const u = new URL(origin);
    return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}
app.use((req: Request, res: Response, next: NextFunction) => {
  const host = req.headers.host ?? '';
  if (!LOCAL_HOST.test(host)) {
    res.status(403).send('Forbidden host');
    return;
  }
  if (req.headers.origin && !isLocalOrigin(req.headers.origin)) {
    res.status(403).send('Forbidden origin');
    return;
  }
  next();
});

// --- MCP (Streamable HTTP) -------------------------------------------------
const mcp = createMcpHandlers(store, hub);
app.post('/mcp', express.json({ limit: '25mb' }), (req, res) => {
  mcp.post(req, res).catch((err) => {
    console.error('[mcp]', err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: String(err?.message ?? err) }, id: null });
  });
});
app.get('/mcp', (req, res) => void mcp.getOrDelete(req, res));
app.delete('/mcp', (req, res) => void mcp.getOrDelete(req, res));

// --- REST API ----------------------------------------------------------------
const api = express.Router();
api.use(express.json({ limit: '50mb' }));

api.get('/info', (_req, res) => {
  res.json({
    version: '0.1.0',
    port: PORT,
    url: PUBLIC_URL,
    mcpUrl: `${PUBLIC_URL}/mcp`,
    dataDir: DATA_DIR,
    projectDir: PROJECT_DIR,
    bridgePath: path.join(ROOT, 'bin', 'design-canvas-mcp.mjs'),
    nodePath: process.execPath,
    tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description })),
    mcpClients: [...hub.mcpClients.values()],
  });
});

api.get('/docs', (_req, res) => res.json(store.list()));
api.post('/docs', (req, res) => {
  try {
    const doc = store.create(typeof req.body?.name === 'string' ? req.body.name : 'Untitled', undefined, req.body?.folder);
    hub.broadcast(null, { t: 'docs-changed' });
    res.json({ id: doc.id, name: doc.name });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
api.get('/docs/:id/meta', (req, res) => {
  const meta = store.list().find((d) => d.id === req.params.id);
  if (meta) res.json(meta);
  else res.status(404).json({ error: 'Not found' });
});

// Folders are real subdirectories of the designs dir.
api.get('/folders', (_req, res) => res.json(store.folders()));
api.post('/folders', (req, res) => {
  try {
    const parent = typeof req.body?.parent === 'string' ? req.body.parent : '';
    const name = String(req.body?.name ?? '').trim();
    const target = req.body?.path ?? (parent ? `${parent}/${name}` : name);
    const folder = store.createFolder(target);
    hub.broadcast(null, { t: 'docs-changed' });
    res.json({ folder });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
api.patch('/folders', (req, res) => {
  try {
    const folder = store.moveFolder(req.body?.from, req.body?.to);
    hub.broadcast(null, { t: 'docs-changed' });
    res.json({ folder });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
api.delete('/folders', (req, res) => {
  try {
    const r = store.deleteFolder(req.body?.path ?? String(req.query.path ?? ''));
    hub.broadcast(null, { t: 'docs-changed' });
    res.json(r);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
api.post('/docs/:id/duplicate', (req, res) => {
  try {
    const doc = store.duplicate(req.params.id);
    hub.broadcast(null, { t: 'docs-changed' });
    res.json({ id: doc.id, name: doc.name });
  } catch (e: any) {
    res.status(404).json({ error: e.message });
  }
});
api.delete('/docs/:id', (req, res) => {
  try {
    store.delete(req.params.id);
    hub.broadcast(null, { t: 'docs-changed' });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(404).json({ error: e.message });
  }
});
api.patch('/docs/:id', (req, res) => {
  try {
    if (!store.exists(req.params.id)) throw Object.assign(new Error('Document not found'), { status: 404 });
    if (typeof req.body?.name === 'string' && req.body.name.trim()) store.applyPatch(req.params.id, { name: req.body.name.trim().slice(0, 120) }, { kind: 'system' });
    if (typeof req.body?.folder === 'string') store.moveDoc(req.params.id, req.body.folder);
    hub.broadcast(null, { t: 'docs-changed' });
    res.json({ ok: true, folder: store.folderOfDoc(req.params.id) });
  } catch (e: any) {
    res.status(e.status ?? 400).json({ error: e.message });
  }
});
api.get('/docs/:id/export', (req, res) => {
  try {
    const doc = store.getDoc(req.params.id);
    res.setHeader('content-disposition', `attachment; filename="${doc.name.replace(/[^\w.-]+/g, '_')}.design.json"`);
    res.json(doc);
  } catch (e: any) {
    res.status(404).json({ error: e.message });
  }
});
api.post('/docs/import', (req, res) => {
  const body = req.body;
  if (!body || !body.nodes || !body.pages || !body.pageOrder) {
    res.status(400).json({ error: 'Not a Design Canvas document' });
    return;
  }
  let folder = '';
  try {
    folder = normalizeFolder(req.query.folder);
  } catch {
    /* import into the root */
  }
  const doc = store.create(
    String(body.name ?? 'Imported'),
    (d) => {
      d.pages = body.pages;
      d.pageOrder = body.pageOrder;
      d.nodes = body.nodes;
      d.variables = body.variables ?? {};
      d.comments = body.comments ?? {};
    },
    folder,
  );
  hub.broadcast(null, { t: 'docs-changed' });
  res.json({ id: doc.id, name: doc.name });
});

// Assets (images) are stored content-addressed next to the documents.
const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
};
api.post('/assets', express.raw({ type: 'image/*', limit: '30mb' }), (req, res) => {
  const type = String(req.headers['content-type'] ?? '').split(';')[0];
  const ext = MIME_EXT[type];
  if (!ext || !Buffer.isBuffer(req.body)) {
    res.status(400).json({ error: 'Unsupported image type' });
    return;
  }
  const hash = crypto.createHash('sha1').update(req.body).digest('hex').slice(0, 20);
  const name = `${hash}.${ext}`;
  fs.writeFileSync(path.join(ASSETS_DIR, name), req.body);
  res.json({ url: `/assets/${name}` });
});

api.get('/settings', (_req, res) => {
  const s = loadSettings();
  res.json({
    anthropicApiKey: s.anthropicApiKey ? '••••' + s.anthropicApiKey.slice(-4) : process.env.ANTHROPIC_API_KEY ? '(from env)' : '',
    openaiApiKey: s.openaiApiKey ? '••••' + s.openaiApiKey.slice(-4) : process.env.OPENAI_API_KEY ? '(from env)' : '',
    anthropicModel: s.anthropicModel ?? '',
    openaiModel: s.openaiModel ?? '',
    claudeCodeModel: s.claudeCodeModel ?? '',
    codexModel: s.codexModel ?? '',
  });
});
api.put('/settings', (req, res) => {
  const cur = loadSettings();
  const next: Settings = { ...cur };
  for (const k of ['anthropicApiKey', 'openaiApiKey', 'anthropicModel', 'openaiModel', 'claudeCodeModel', 'codexModel'] as const) {
    const v = req.body?.[k];
    if (typeof v !== 'string') continue;
    if (k.endsWith('ApiKey') && (v.startsWith('••••') || v === '(from env)')) continue;
    if (v.trim()) next[k] = v.trim();
    else delete next[k];
  }
  saveSettings(next);
  res.json({ ok: true });
});

api.get('/ai/providers', async (_req, res) => res.json(await providerStatus()));
api.post('/ai/chat', (req, res) => {
  const body = req.body as ChatRequest;
  if (!body?.prompt || !body?.provider) {
    res.status(400).json({ error: 'provider and prompt are required' });
    return;
  }
  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('x-accel-buffering', 'no');
  res.flushHeaders();
  let runId: string | null = null;
  let finished = false;
  res.on('close', () => {
    if (!finished && runId) cancelRun(runId);
  });
  runChat(body, { store, hub }, (e) => {
    if (e.type === 'start') runId = e.runId;
    if (!res.writableEnded) res.write(JSON.stringify(e) + '\n');
  }).finally(() => {
    finished = true;
    if (!res.writableEnded) res.end();
  });
});
api.post('/ai/cancel', (req, res) => res.json({ ok: cancelRun(String(req.body?.runId ?? '')) }));

app.use('/api', api);
app.use('/assets', express.static(ASSETS_DIR, { maxAge: '365d', immutable: true }));

// --- Static editor (production build) ---------------------------------------
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST, { index: false }));
  // `root` keeps send's dotfile check off the absolute prefix (e.g. a checkout under ~/.something).
  app.get(/^\/(?!api|mcp|assets|ws).*/, (_req, res) => res.sendFile('index.html', { root: DIST }));
} else {
  app.get('/', (_req, res) =>
    res
      .type('html')
      .send(`<p style="font-family:system-ui;padding:24px">Design Canvas server is running. In development open <a href="http://localhost:5173">http://localhost:5173</a>, or run <code>npm run build</code> to serve the editor here.</p>`),
  );
}

// --- HTTP + WebSocket ---------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const url = req.url ?? '';
  if (!url.startsWith('/ws') || !LOCAL_HOST.test(req.headers.host ?? '') || (req.headers.origin && !isLocalOrigin(req.headers.origin))) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => hub.handleConnection(ws));
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Design Canvas  →  ${PUBLIC_URL}${fs.existsSync(DIST) ? '' : '   (dev editor: http://localhost:5173)'}`);
  console.log(`  MCP endpoint   →  ${PUBLIC_URL}/mcp`);
  console.log(`  Documents      →  ${DATA_DIR}\n`);
  console.log(`  Connect Claude Code:  claude mcp add --transport http design-canvas ${PUBLIC_URL}/mcp`);
  console.log(`  Connect Codex:        codex mcp add design-canvas -- ${process.execPath} ${path.join(ROOT, 'bin', 'design-canvas-mcp.mjs')}\n`);
});

const shutdown = () => {
  store.flushAll();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
