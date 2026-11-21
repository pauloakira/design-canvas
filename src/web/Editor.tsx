import { useEffect } from 'react';
import { Code2, Layers, Palette, Sparkles, SlidersHorizontal, Shapes, MessageCircle } from 'lucide-react';
import { getState, resetEditor, setState, useEditor } from './store.ts';
import { connect, disconnect, sendPresence } from './sync.ts';
import { installShortcuts } from './editor/shortcuts.ts';
import { pasteFromEvent } from './editor/actions.ts';
import { useDocumentFonts } from './fonts.ts';
import { Canvas } from './canvas/Canvas.tsx';
import { Toolbar } from './panels/Toolbar.tsx';
import { LayersPanel } from './panels/LayersPanel.tsx';
import { AssetsPanel } from './panels/AssetsPanel.tsx';
import { TokensPanel } from './panels/TokensPanel.tsx';
import { CommentsPanel } from './panels/CommentsPanel.tsx';
import { DesignPanel } from './panels/DesignPanel.tsx';
import { CodePanel } from './panels/CodePanel.tsx';
import { AIPanel, useAiRunning } from './panels/AIPanel.tsx';
import { ContextMenu } from './panels/ContextMenu.tsx';
import { Dialogs } from './panels/Dialogs.tsx';

export default function Editor({ docId }: { docId: string }) {
  const loaded = useEditor((s) => s.doc?.id === docId);
  const name = useEditor((s) => s.doc?.name);
  useDocumentFonts();

  useEffect(() => {
    resetEditor();
    connect(docId);
    const uninstall = installShortcuts();
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
      void pasteFromEvent(e);
    };
    window.addEventListener('paste', onPaste);
    // Broadcast selection / page to the server (MCP get_selection uses it).
    const unsub = useEditor.subscribe((s, prev) => {
      if (s.selection !== prev.selection || s.pageId !== prev.pageId) sendPresence(true);
    });
    const onFocus = () => sendPresence(true);
    window.addEventListener('focus', onFocus);
    return () => {
      uninstall();
      unsub();
      window.removeEventListener('paste', onPaste);
      window.removeEventListener('focus', onFocus);
      disconnect();
      resetEditor();
    };
  }, [docId]);

  useEffect(() => {
    if (name) document.title = `${name} — Design Canvas`;
  }, [name]);

  if (!loaded) {
    return (
      <div className="loading">
        <div className="spinner" />
        <p>Opening design…</p>
      </div>
    );
  }
  return (
    <div className="editor">
      <Toolbar />
      <LeftPanel />
      <main className="center">
        <Canvas />
      </main>
      <RightPanel />
      <ContextMenu />
      <Dialogs />
      <Toasts />
    </div>
  );
}

function LeftPanel() {
  const tab = useEditor((s) => s.leftTab);
  const set = (leftTab: 'layers' | 'assets' | 'tokens' | 'comments') => setState({ leftTab });
  const open = useEditor((s) => Object.values(s.doc?.comments ?? {}).filter((c) => !c.resolved).length);
  return (
    <aside className="side left">
      <nav className="side-tabs">
        <button className={tab === 'layers' ? 'active' : ''} onClick={() => set('layers')}>
          <Layers size={13} /> Layers
        </button>
        <button className={tab === 'assets' ? 'active' : ''} onClick={() => set('assets')}>
          <Shapes size={13} /> Assets
        </button>
        <button className={tab === 'tokens' ? 'active' : ''} onClick={() => set('tokens')}>
          <Palette size={13} /> Tokens
        </button>
        <button className={tab === 'comments' ? 'active' : ''} onClick={() => set('comments')} title="Comments">
          <MessageCircle size={13} />
          {open > 0 && <span className="tab-count">{open}</span>}
        </button>
      </nav>
      <div className="side-body">
        {tab === 'layers' && <LayersPanel />}
        {tab === 'assets' && <AssetsPanel />}
        {tab === 'tokens' && <TokensPanel />}
        {tab === 'comments' && <CommentsPanel />}
      </div>
    </aside>
  );
}

function RightPanel() {
  const tab = useEditor((s) => s.rightTab);
  const running = useAiRunning();
  const set = (rightTab: 'design' | 'code' | 'ai') => setState({ rightTab });
  return (
    <aside className="side right">
      <nav className="side-tabs">
        <button className={tab === 'design' ? 'active' : ''} onClick={() => set('design')}>
          <SlidersHorizontal size={13} /> Design
        </button>
        <button className={tab === 'code' ? 'active' : ''} onClick={() => set('code')}>
          <Code2 size={13} /> Code
        </button>
        <button className={`${tab === 'ai' ? 'active' : ''} ai-tab`} onClick={() => set('ai')}>
          <Sparkles size={13} /> AI {running && <span className="pulse" />}
        </button>
      </nav>
      <div className="side-body">
        {tab === 'design' && <DesignPanel />}
        {tab === 'code' && <CodePanel />}
        <div style={{ display: tab === 'ai' ? 'contents' : 'none' }}>
          <AIPanel />
        </div>
      </div>
    </aside>
  );
}

function Toasts() {
  const toasts = useEditor((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind ?? ''}`}>
          <span>{t.text}</span>
          {t.action && (
            <button
              className="btn small"
              onClick={() => {
                t.action!.run();
                setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) }));
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

void getState;
