import { useEffect, useState } from 'react';
import { Copy, FileUp, Plus, Trash2, Plug } from 'lucide-react';
import type { DocMeta } from '../shared/types.ts';
import { navigate } from './App.tsx';
import { CopyButton } from './panels/controls.tsx';

function timeAgo(t: number) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

export default function Home() {
  const [docs, setDocs] = useState<DocMeta[] | null>(null);
  const [info, setInfo] = useState<{ mcpUrl: string; dataDir: string; bridgePath: string; nodePath: string } | null>(null);
  const load = () =>
    fetch('/api/docs')
      .then((r) => r.json())
      .then(setDocs)
      .catch(() => setDocs([]));
  useEffect(() => {
    document.title = 'Design Canvas';
    load();
    fetch('/api/info')
      .then((r) => r.json())
      .then(setInfo)
      .catch(() => {});
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, []);
  const create = async () => {
    const r = await fetch('/api/docs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Untitled' }) });
    const { id } = await r.json();
    navigate(`/d/${id}`);
  };
  const importFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      const body = await f.text();
      const r = await fetch('/api/docs/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      if (r.ok) navigate(`/d/${(await r.json()).id}`);
      else alert('Not a Design Canvas file');
    };
    input.click();
  };
  return (
    <div className="home">
      <header className="home-head">
        <div className="brand">
          <span className="brand-mark" />
          Design Canvas
        </div>
        <div className="grow" />
        <button className="btn" onClick={importFile}>
          <FileUp size={14} /> Import
        </button>
        <button className="btn primary" onClick={create}>
          <Plus size={14} /> New design
        </button>
      </header>
      <main className="home-main">
        <section className="hero-card">
          <div>
            <h1>Design like Figma. Ship with your agent.</h1>
            <p>
              Every frame is real flexbox, every token a CSS variable. Connect <b>Claude Code</b> or <b>Codex</b> over MCP and they can read, implement — and design — right here. Free, local, yours.
            </p>
          </div>
          {info && (
            <div className="hero-cmds">
              <div className="small muted">
                <Plug size={12} /> Claude Code
              </div>
              <div className="cmd">
                <code>claude mcp add --transport http design-canvas {info.mcpUrl}</code>
                <CopyButton text={`claude mcp add --transport http --scope user design-canvas ${info.mcpUrl}`} />
              </div>
              <div className="small muted">
                <Plug size={12} /> Codex
              </div>
              <div className="cmd">
                <code>codex mcp add design-canvas -- node {info.bridgePath.split('/').slice(-2).join('/')}</code>
                <CopyButton text={`codex mcp add design-canvas -- ${info.nodePath} ${info.bridgePath}`} />
              </div>
            </div>
          )}
        </section>
        <h2>Your designs</h2>
        {docs === null && <p className="muted">Loading…</p>}
        <div className="doc-grid">
          <button className="doc-card new" onClick={create}>
            <Plus size={22} />
            <span>New design</span>
          </button>
          {docs?.map((d) => (
            <div key={d.id} className="doc-card" onClick={() => navigate(`/d/${d.id}`)}>
              <div className="doc-thumb">
                <span>{d.name.slice(0, 1).toUpperCase()}</span>
              </div>
              <div className="doc-meta">
                <div className="doc-title">{d.name}</div>
                <div className="muted small">
                  {timeAgo(d.updatedAt)} · {d.nodes} layers
                </div>
              </div>
              <div className="doc-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className="iconbtn"
                  title="Duplicate"
                  onClick={async () => {
                    await fetch(`/api/docs/${d.id}/duplicate`, { method: 'POST' });
                    load();
                  }}
                >
                  <Copy size={13} />
                </button>
                <button
                  className="iconbtn"
                  title="Delete"
                  onClick={async () => {
                    if (!confirm(`Delete "${d.name}"? (The file is renamed to .deleted in the designs folder.)`)) return;
                    await fetch(`/api/docs/${d.id}`, { method: 'DELETE' });
                    load();
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
        {info && <p className="muted small footer-note">Files are plain JSON in {info.dataDir} — commit them with your code.</p>}
      </main>
    </div>
  );
}
