import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Copy, FileUp, Folder, FolderInput, FolderPlus, Pencil, Plus, Plug, Search, Trash2, X } from 'lucide-react';
import type { DocMeta } from '../shared/types.ts';
import { folderUrl, navigate } from './App.tsx';
import { CopyButton } from './panels/controls.tsx';

function timeAgo(t: number) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

const leaf = (f: string) => f.split('/').pop() ?? f;
const parentOf = (f: string) => f.split('/').slice(0, -1).join('/');
const isInside = (f: string, scope: string) => f === scope || f.startsWith(scope + '/');
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

const DOC_MIME = 'application/x-dc-doc';
const FOLDER_MIME = 'application/x-dc-folder';

async function api(method: string, url: string, body?: unknown) {
  const r = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? `Request failed (${r.status})`);
  return data;
}

function uniqueName(base: string, taken: string[]) {
  const set = new Set(taken.map((t) => t.toLowerCase()));
  if (!set.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!set.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

export default function Home({ folder }: { folder: string }) {
  const [docs, setDocs] = useState<DocMeta[] | null>(null);
  const [folders, setFolders] = useState<string[]>([]);
  const [info, setInfo] = useState<{ mcpUrl: string; dataDir: string; bridgePath: string; nodePath: string } | null>(null);
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [moveMenu, setMoveMenu] = useState<{ docId: string; x: number; y: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = () =>
    Promise.all([fetch('/api/docs').then((r) => r.json()), fetch('/api/folders').then((r) => r.json())])
      .then(([d, f]) => {
        setDocs(d);
        setFolders(f);
      })
      .catch(() => setDocs([]));

  useEffect(() => {
    load();
    fetch('/api/info')
      .then((r) => r.json())
      .then(setInfo)
      .catch(() => {});
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, []);

  useEffect(() => {
    document.title = folder ? `${leaf(folder)} — Design Canvas` : 'Design Canvas';
    setQuery('');
  }, [folder]);

  // A folder deleted/renamed elsewhere: fall back to the closest existing parent.
  useEffect(() => {
    if (!docs || !folder || folders.includes(folder)) return;
    let f = parentOf(folder);
    while (f && !folders.includes(f)) f = parentOf(f);
    navigate(folderUrl(f));
  }, [docs, folders, folder]);

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    }
    await load();
  };

  const subfolders = folders.filter((f) => parentOf(f) === folder);
  const q = query.trim().toLowerCase();
  const visibleDocs = useMemo(() => {
    if (!docs) return [];
    if (q) return docs.filter((d) => d.name.toLowerCase().includes(q) && (!folder || isInside(d.folder, folder)));
    return docs.filter((d) => d.folder === folder);
  }, [docs, folder, q]);
  const visibleFolders = q ? folders.filter((f) => (!folder || f.startsWith(folder + '/')) && leaf(f).toLowerCase().includes(q)) : subfolders;
  const countIn = (f: string) => ({
    docs: docs?.filter((d) => isInside(d.folder, f)).length ?? 0,
    folders: folders.filter((x) => parentOf(x) === f).length,
  });

  const create = async () => {
    const r = await api('POST', '/api/docs', { name: 'Untitled', folder });
    navigate(`/d/${r.id}`);
  };
  const newFolder = () =>
    run(async () => {
      const name = uniqueName('Untitled folder', subfolders.map(leaf));
      const r = await api('POST', '/api/folders', { parent: folder, name });
      setRenaming(r.folder);
    });
  const renameFolder = (from: string, name: string) => {
    setRenaming(null);
    const n = name.trim();
    if (!n || n === leaf(from)) return;
    run(() => api('PATCH', '/api/folders', { from, to: parentOf(from) ? `${parentOf(from)}/${n}` : n }));
  };
  const deleteFolder = (f: string) => {
    const c = countIn(f);
    const where = parentOf(f) ? `"${leaf(parentOf(f))}"` : 'Your designs';
    const what = c.docs || c.folders ? ` Its ${[c.docs && plural(c.docs, 'design'), c.folders && plural(c.folders, 'folder')].filter(Boolean).join(' and ')} will move to ${where}.` : '';
    if (!confirm(`Delete folder "${leaf(f)}"?${what}`)) return;
    run(() => api('DELETE', '/api/folders', { path: f }));
  };
  const moveDoc = (id: string, to: string) => run(() => api('PATCH', `/api/docs/${id}`, { folder: to }));
  const moveFolder = (from: string, toParent: string) => {
    const to = toParent ? `${toParent}/${leaf(from)}` : leaf(from);
    if (to === from || isInside(toParent, from)) return;
    run(() => api('PATCH', '/api/folders', { from, to }));
  };

  /** Props that make an element a drop target for designs and folders. */
  const dropProps = (target: string) => ({
    onDragOver: (e: React.DragEvent) => {
      const types = e.dataTransfer.types;
      if (!types.includes(DOC_MIME) && !types.includes(FOLDER_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dropTarget !== target) setDropTarget(target);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!(e.currentTarget as Node).contains(e.relatedTarget as Node)) setDropTarget((t) => (t === target ? null : t));
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDropTarget(null);
      const doc = e.dataTransfer.getData(DOC_MIME);
      const f = e.dataTransfer.getData(FOLDER_MIME);
      if (doc) moveDoc(doc, target);
      else if (f) moveFolder(f, target);
    },
  });

  const importFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      const body = await f.text();
      const r = await fetch(`/api/docs/import?folder=${encodeURIComponent(folder)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      if (r.ok) navigate(`/d/${(await r.json()).id}`);
      else alert('Not a Design Canvas file');
    };
    input.click();
  };

  const crumbs = folder ? folder.split('/').map((name, i, all) => ({ name, path: all.slice(0, i + 1).join('/') })) : [];

  return (
    <div className="home">
      <header className="home-head">
        <button className="brand" onClick={() => navigate('/')}>
          <span className="brand-mark" />
          Design Canvas
        </button>
        <div className="grow" />
        <label className="home-search">
          <Search size={13} />
          <input placeholder={folder ? `Search in ${leaf(folder)}` : 'Search designs'} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQuery('')} />
          {query && (
            <button className="iconbtn" onClick={() => setQuery('')} title="Clear">
              <X size={12} />
            </button>
          )}
        </label>
        <button className="btn" onClick={importFile}>
          <FileUp size={14} /> Import
        </button>
        <button className="btn" onClick={newFolder}>
          <FolderPlus size={14} /> New folder
        </button>
        <button className="btn primary" onClick={create}>
          <Plus size={14} /> New design
        </button>
      </header>
      <main className="home-main">
        {!folder && (
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
        )}

        <nav className="crumbs">
          <button className={`crumb ${dropTarget === '' && folder ? 'drop' : ''}`} onClick={() => navigate('/')} {...(folder ? dropProps('') : {})}>
            Your designs
          </button>
          {crumbs.map((c, i) => (
            <span key={c.path} className="crumb-wrap">
              <ChevronRight size={14} className="muted" />
              <button
                className={`crumb ${i === crumbs.length - 1 ? 'current' : ''} ${dropTarget === c.path && i < crumbs.length - 1 ? 'drop' : ''}`}
                onClick={() => navigate(folderUrl(c.path))}
                onDoubleClick={() => i === crumbs.length - 1 && setRenaming(c.path)}
                {...(i < crumbs.length - 1 ? dropProps(c.path) : {})}
              >
                {renaming === c.path ? <RenameInput value={c.name} onDone={(v) => renameFolder(c.path, v)} /> : c.name}
              </button>
            </span>
          ))}
          {q && <span className="muted small crumb-note">· results for “{query.trim()}”</span>}
        </nav>
        {error && (
          <div className="home-error" onClick={() => setError('')}>
            {error}
          </div>
        )}

        {docs === null && <p className="muted">Loading…</p>}

        {visibleFolders.length > 0 && (
          <div className="folder-grid">
            {visibleFolders.map((f) => {
              const c = countIn(f);
              return (
                <div
                  key={f}
                  className={`folder-card ${dropTarget === f ? 'drop' : ''}`}
                  draggable={renaming !== f}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(FOLDER_MIME, f);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onClick={() => renaming !== f && navigate(folderUrl(f))}
                  {...dropProps(f)}
                >
                  <Folder size={20} className="folder-icon" />
                  <div className="folder-meta">
                    {renaming === f ? <RenameInput value={leaf(f)} onDone={(v) => renameFolder(f, v)} /> : <div className="doc-title">{leaf(f)}</div>}
                    <div className="muted small">
                      {q && parentOf(f) ? `${parentOf(f)} · ` : ''}
                      {[plural(c.docs, 'design'), c.folders ? plural(c.folders, 'folder') : ''].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <div className="folder-actions" onClick={(e) => e.stopPropagation()}>
                    <button className="iconbtn" title="Rename" onClick={() => setRenaming(f)}>
                      <Pencil size={13} />
                    </button>
                    <button className="iconbtn" title="Delete folder (keeps its designs)" onClick={() => deleteFolder(f)}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="doc-grid">
          {!q && (
            <button className="doc-card new" onClick={create}>
              <Plus size={22} />
              <span>New design{folder ? ` in ${leaf(folder)}` : ''}</span>
            </button>
          )}
          {visibleDocs.map((d) => (
            <div
              key={d.id}
              className="doc-card"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DOC_MIME, d.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onClick={() => navigate(`/d/${d.id}`)}
            >
              <div className="doc-thumb">
                <span>{d.name.slice(0, 1).toUpperCase()}</span>
              </div>
              <div className="doc-meta">
                <div className="doc-title">{d.name}</div>
                <div className="muted small">
                  {q && d.folder !== folder ? `${d.folder || 'Your designs'} · ` : ''}
                  {timeAgo(d.updatedAt)} · {d.nodes} layers
                </div>
              </div>
              <div className="doc-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className="iconbtn"
                  title="Move to folder"
                  onClick={(e) => {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setMoveMenu({ docId: d.id, x: r.right, y: r.bottom + 4 });
                  }}
                >
                  <FolderInput size={13} />
                </button>
                <button className="iconbtn" title="Duplicate" onClick={() => run(() => api('POST', `/api/docs/${d.id}/duplicate`))}>
                  <Copy size={13} />
                </button>
                <button
                  className="iconbtn"
                  title="Delete"
                  onClick={() => {
                    if (!confirm(`Delete "${d.name}"? (The file is renamed to .deleted in the designs folder.)`)) return;
                    run(() => api('DELETE', `/api/docs/${d.id}`));
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
        {docs && q && visibleDocs.length === 0 && visibleFolders.length === 0 && <p className="muted">Nothing matches “{query.trim()}”.</p>}
        {docs && !q && folder && visibleDocs.length === 0 && subfolders.length === 0 && <p className="muted small empty-note">This folder is empty. Create a design here, or drag designs onto it from another folder.</p>}
        {info && (
          <p className="muted small footer-note">
            Files are plain JSON in {info.dataDir}
            {folder ? `/${folder}` : ''} — folders are real directories, so commit them with your code.
          </p>
        )}
      </main>
      {moveMenu && docs && (
        <MoveMenu
          at={moveMenu}
          current={docs.find((d) => d.id === moveMenu.docId)?.folder ?? ''}
          folders={folders}
          onClose={() => setMoveMenu(null)}
          onPick={(to) => {
            setMoveMenu(null);
            moveDoc(moveMenu.docId, to);
          }}
          onNew={(name) => {
            setMoveMenu(null);
            moveDoc(moveMenu.docId, folder ? `${folder}/${name}` : name);
          }}
        />
      )}
    </div>
  );
}

function RenameInput({ value, onDone, onCancel }: { value: string; onDone: (v: string) => void; onCancel?: () => void }) {
  const done = useRef(false);
  const finish = (v: string) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  return (
    <input
      className="folder-rename"
      autoFocus
      defaultValue={value}
      onFocus={(e) => e.target.select()}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => finish(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish((e.target as HTMLInputElement).value);
        if (e.key === 'Escape') {
          if (onCancel) {
            done.current = true;
            onCancel();
          } else finish(value);
        }
      }}
    />
  );
}

function MoveMenu(props: { at: { x: number; y: number }; current: string; folders: string[]; onClose: () => void; onPick: (f: string) => void; onNew: (name: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && props.onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
    };
  }, []);
  const left = Math.max(8, Math.min(props.at.x - 240, window.innerWidth - 248));
  const options = ['', ...props.folders];
  return (
    <div ref={ref} className="move-menu" style={{ left, top: Math.min(props.at.y, window.innerHeight - 300) }}>
      <div className="move-menu-title">Move to…</div>
      <div className="move-menu-list">
        {options.map((f) => (
          <button key={f || '(root)'} className={`move-item ${f === props.current ? 'current' : ''}`} disabled={f === props.current} style={{ paddingLeft: 10 + (f ? f.split('/').length : 0) * 14 }} onClick={() => props.onPick(f)}>
            <Folder size={13} />
            <span>{f ? leaf(f) : 'Your designs'}</span>
            {f === props.current && <span className="muted small">current</span>}
          </button>
        ))}
      </div>
      {adding ? (
        <div className="move-new">
          <RenameInput value="New folder" onDone={(v) => (v.trim() ? props.onNew(v.trim()) : setAdding(false))} onCancel={() => setAdding(false)} />
        </div>
      ) : (
        <button className="move-item new" onClick={() => setAdding(true)}>
          <FolderPlus size={13} /> New folder…
        </button>
      )}
    </div>
  );
}
