import { useEffect, useState } from 'react';
import { ChevronDown, Circle, MessageCircle, Frame, Hand, Image as ImageIcon, Keyboard, MousePointer2, Plug, Square, Type, Undo2, Redo2, LayoutGrid } from 'lucide-react';
import { commit, getState, redo, setState, setTool, undo, useEditor, type Tool } from '../store.ts';
import { pickImage } from '../editor/actions.ts';
import { setZoom, zoomBy, zoomToFit, zoomToNodes } from '../editor/viewport.ts';
import { folderUrl, navigate } from '../App.tsx';

const TOOLS: Array<{ id: Tool; icon: any; label: string; key: string }> = [
  { id: 'move', icon: MousePointer2, label: 'Move', key: 'V' },
  { id: 'frame', icon: Frame, label: 'Frame', key: 'F' },
  { id: 'rect', icon: Square, label: 'Rectangle', key: 'R' },
  { id: 'ellipse', icon: Circle, label: 'Ellipse', key: 'O' },
  { id: 'text', icon: Type, label: 'Text', key: 'T' },
  { id: 'hand', icon: Hand, label: 'Hand', key: 'H' },
];

export function Toolbar() {
  const tool = useEditor((s) => s.tool);
  const name = useEditor((s) => s.doc?.name ?? '');
  const zoom = useEditor((s) => s.viewport.zoom);
  const connected = useEditor((s) => s.connected);
  const peers = useEditor((s) => s.peers);
  const mcpRaw = useEditor((s) => s.mcpClients);
  const mcp = [...new Set(mcpRaw.map((c) => c.name))];
  const canUndo = useEditor((s) => s.undoStack.length > 0);
  const canRedo = useEditor((s) => s.redoStack.length > 0);
  const openComments = useEditor((s) => Object.values(s.doc?.comments ?? {}).filter((c) => !c.resolved).length);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const docId = useEditor((s) => s.doc?.id);
  const [folder, setFolder] = useState('');
  useEffect(() => {
    if (!docId) return;
    const load = () =>
      fetch(`/api/docs/${docId}/meta`)
        .then((r) => (r.ok ? r.json() : null))
        .then((m) => setFolder(m?.folder ?? ''))
        .catch(() => {});
    load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [docId]);
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className="logo" title={folder ? `Back to ${folder}` : 'All files'} onClick={() => navigate(folderUrl(folder))}>
          <LayoutGrid size={16} />
        </button>
        {folder && (
          <>
            <button className="doc-folder" title={`Open folder ${folder}`} onClick={() => navigate(folderUrl(folder))}>
              {folder.split('/').pop()}
            </button>
            <span className="doc-folder-sep">/</span>
          </>
        )}
        {editingName ? (
          <input
            className="doc-name-input"
            autoFocus
            defaultValue={name}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== name) commit((d) => void (d.name = v));
              setEditingName(false);
            }}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === 'Escape') && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <button className="doc-name" onClick={() => setEditingName(true)} title="Rename">
            {name}
          </button>
        )}
        <span className={`conn ${connected ? 'ok' : 'off'}`} title={connected ? 'Synced with local server' : 'Reconnecting…'} />
      </div>
      <div className="tools">
        {TOOLS.map((t) => (
          <button key={t.id} className={`tool ${tool === t.id ? 'active' : ''}`} title={`${t.label} (${t.key})`} onClick={() => setTool(t.id)}>
            <t.icon size={16} />
          </button>
        ))}
        <button className="tool" title="Image (⇧I)" onClick={pickImage}>
          <ImageIcon size={16} />
        </button>
        <button className={`tool ${tool === 'comment' ? 'active' : ''}`} title="Comment (C) · ⇧C show/hide comments" onClick={() => setTool(tool === 'comment' ? 'move' : 'comment')}>
          <MessageCircle size={16} />
          {openComments > 0 && <span className="tool-badge">{openComments}</span>}
        </button>
        <span className="sep" />
        <button className="tool" title="Undo (⌘Z)" onClick={undo} disabled={!canUndo}>
          <Undo2 size={15} />
        </button>
        <button className="tool" title="Redo (⇧⌘Z)" onClick={redo} disabled={!canRedo}>
          <Redo2 size={15} />
        </button>
      </div>
      <div className="topbar-right">
        <AgentStatus />
        <div className="peers">
          {peers.slice(0, 4).map((p) => (
            <span key={p.id} className="avatar" style={{ background: p.color }} title={p.name}>
              {p.name.slice(0, 1)}
            </span>
          ))}
        </div>
        <button className={`btn small connect ${mcp.length ? 'live' : ''}`} onClick={() => setState({ dialog: 'connect' })} title={mcp.length ? `Connected: ${mcp.join(', ')}` : 'Connect Claude Code, Codex and other MCP clients'}>
          <Plug size={13} /> {mcp.length ? (mcp.length === 1 ? mcp[0] : `${mcp.length} agents`) : 'Connect'}
        </button>
        <button className="iconbtn" title="Keyboard shortcuts (⌘/)" onClick={() => setState({ dialog: 'shortcuts' })}>
          <Keyboard size={15} />
        </button>
        <div className="zoom">
          <button className="btn small ghost" onClick={() => setZoomOpen(!zoomOpen)}>
            {Math.round(zoom * 100)}% <ChevronDown size={12} />
          </button>
          {zoomOpen && (
            <div className="menu" onMouseLeave={() => setZoomOpen(false)}>
              <button onClick={() => (zoomBy(1.25), setZoomOpen(false))}>Zoom in <kbd>⌘+</kbd></button>
              <button onClick={() => (zoomBy(0.8), setZoomOpen(false))}>Zoom out <kbd>⌘−</kbd></button>
              <button onClick={() => (zoomToFit(), setZoomOpen(false))}>Zoom to fit <kbd>⇧1</kbd></button>
              <button onClick={() => (zoomToNodes(getState().selection, 4), setZoomOpen(false))}>Zoom to selection <kbd>⇧2</kbd></button>
              <button onClick={() => (setZoom(0.5), setZoomOpen(false))}>50%</button>
              <button onClick={() => (setZoom(1), setZoomOpen(false))}>100% <kbd>⇧0</kbd></button>
              <button onClick={() => (setZoom(2), setZoomOpen(false))}>200%</button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function AgentStatus() {
  const st = useEditor((s) => s.agentStatus);
  const [, force] = useState(0);
  useEffect(() => {
    if (!st) return;
    const t = setTimeout(() => force((x) => x + 1), 4200);
    return () => clearTimeout(t);
  }, [st]);
  if (!st || Date.now() - st.at > 4000) return null;
  return (
    <div className={`agent-status ${st.status}`}>
      <span className="pulse" />
      {st.name} · {st.tool.replace(/_/g, ' ')}
    </div>
  );
}
