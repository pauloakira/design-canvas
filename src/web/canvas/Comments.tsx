import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, MoreHorizontal, Trash2, X, ArrowUp, RotateCcw } from 'lucide-react';
import type { CommentThread, DesignDoc } from '../../shared/types.ts';
import { addThread, deleteMessage, deleteThread, replyToThread, setResolved } from '../../shared/comments.ts';
import { commit, getState, setState, toast, useEditor } from '../store.ts';
import { measure, viewportSize } from '../editor/viewport.ts';
import { getUserName } from '../sync.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function timeAgo(t: number) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString();
}

const AVATAR_COLORS = ['#F97316', '#22C55E', '#3B82F6', '#A855F7', '#EC4899', '#14B8A6', '#EAB308', '#EF4444'];
export function avatarColor(name: string) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function Avatar({ name, agent, size = 22 }: { name: string; agent?: boolean; size?: number }) {
  return (
    <span className={`c-avatar ${agent ? 'agent' : ''}`} style={{ width: size, height: size, background: agent ? undefined : avatarColor(name), fontSize: size * 0.45 }} title={name}>
      {agent ? '✦' : name.trim().slice(0, 1).toUpperCase()}
    </span>
  );
}

/** World (page) position of a thread's pin, following its layer when possible. */
export function pinWorld(doc: DesignDoc, t: CommentThread): { x: number; y: number } {
  if (t.nodeId && doc.nodes[t.nodeId]) {
    const r = measure(t.nodeId);
    if (r) return { x: r.x + t.x, y: r.y + t.y };
  }
  return { x: t.pageX, y: t.pageY };
}

/** Open a thread: switch page if needed, bring the pin into view. */
export function openThread(id: string) {
  const s = getState();
  const t = s.doc?.comments?.[id];
  if (!t) return;
  const switching = t.pageId !== s.pageId;
  setState({ pageId: t.pageId, openThreadId: id, draftComment: null, showComments: true, ...(t.resolved ? { showResolved: true } : {}) });
  const center = () => {
    const doc = getState().doc!;
    const p = pinWorld(doc, t);
    const { width, height } = viewportSize();
    const v = getState().viewport;
    const sx = p.x * v.zoom + v.x;
    const sy = p.y * v.zoom + v.y;
    if (sx < 60 || sy < 60 || sx > width - 360 || sy > height - 60) {
      setState({ viewport: { ...v, x: width / 2 - 150 - p.x * v.zoom, y: height / 2 - p.y * v.zoom } });
    }
  };
  if (switching) requestAnimationFrame(() => requestAnimationFrame(center));
  else center();
}

function mutate(fn: (d: DesignDoc) => void) {
  try {
    commit(fn, { history: false });
  } catch (e: any) {
    toast(e.message, { kind: 'error' });
  }
}

// ---------------------------------------------------------------------------
// Canvas layer: pins + popover
// ---------------------------------------------------------------------------

interface PinPos {
  t: CommentThread;
  sx: number;
  sy: number;
}

export function CommentsLayer() {
  const doc = useEditor((s) => s.doc);
  const comments = useEditor((s) => s.doc?.comments);
  const pageId = useEditor((s) => s.pageId);
  const viewport = useEditor((s) => s.viewport);
  const tick = useEditor((s) => s.layoutTick);
  const openId = useEditor((s) => s.openThreadId);
  const draft = useEditor((s) => s.draftComment);
  const show = useEditor((s) => s.showComments);
  const showResolved = useEditor((s) => s.showResolved);
  const tool = useEditor((s) => s.tool);
  const [pins, setPins] = useState<PinPos[]>([]);

  useLayoutEffect(() => {
    if (!doc) return;
    const out: PinPos[] = [];
    for (const t of Object.values(comments ?? {})) {
      if (t.pageId !== pageId) continue;
      if (t.resolved && !showResolved && t.id !== openId) continue;
      if (!show && t.id !== openId && tool !== 'comment') continue;
      const p = pinWorld(doc, t);
      out.push({ t, sx: p.x * viewport.zoom + viewport.x, sy: p.y * viewport.zoom + viewport.y });
    }
    out.sort((a, b) => a.t.number - b.t.number);
    setPins(out);
  }, [doc, comments, pageId, viewport, tick, openId, show, showResolved, tool]);

  const open = pins.find((p) => p.t.id === openId);
  const draftPos = draft && draft.pageId === pageId && doc ? draftScreen(doc, draft, viewport) : null;
  return (
    <div className="comments-layer" data-comment>
      {pins.map((p) => (
        <button
          key={p.t.id}
          data-comment
          className={`c-pin ${p.t.resolved ? 'resolved' : ''} ${p.t.id === openId ? 'active' : ''} ${p.t.messages[0]?.authorKind === 'agent' ? 'agent' : ''}`}
          style={{ left: p.sx, top: p.sy, ['--pin' as any]: p.t.messages[0]?.authorKind === 'agent' ? undefined : avatarColor(p.t.messages[0]?.author ?? '') }}
          title={`#${p.t.number} ${p.t.messages[0]?.author}: ${p.t.messages[0]?.text}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            setState({ openThreadId: openId === p.t.id ? null : p.t.id, draftComment: null });
          }}
        >
          <span>{p.t.resolved ? '✓' : p.t.messages[0]?.authorKind === 'agent' ? '✦' : (p.t.messages[0]?.author ?? '?').slice(0, 1).toUpperCase()}</span>
          {p.t.messages.length > 1 && <em>{p.t.messages.length}</em>}
        </button>
      ))}
      {draftPos && (
        <>
          <div className="c-pin draft" style={{ left: draftPos.x, top: draftPos.y }}>
            <span>+</span>
          </div>
          <Popover x={draftPos.x} y={draftPos.y}>
            <Composer
              autoFocus
              placeholder="Add a comment…"
              onCancel={() => setState({ draftComment: null })}
              onSubmit={(text) => {
                const d0 = getState().draftComment;
                if (!d0) return;
                let id = '';
                mutate((d) => {
                  id = addThread(d, { ...d0, text, author: getUserName() }).id;
                });
                if (id) setState({ draftComment: null, openThreadId: id });
              }}
            />
          </Popover>
        </>
      )}
      {open && !draftPos && (
        <Popover x={open.sx} y={open.sy}>
          <ThreadView thread={open.t} />
        </Popover>
      )}
    </div>
  );
}

function draftScreen(doc: DesignDoc, d: NonNullable<ReturnType<typeof getState>['draftComment']>, v: { x: number; y: number; zoom: number }) {
  let wx = d.pageX;
  let wy = d.pageY;
  if (d.nodeId && doc.nodes[d.nodeId]) {
    const r = measure(d.nodeId);
    if (r) {
      wx = r.x + d.x;
      wy = r.y + d.y;
    }
  }
  return { x: wx * v.zoom + v.x, y: wy * v.zoom + v.y };
}

function Popover({ x, y, children }: { x: number; y: number; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x + 22, top: y - 30 });
  useLayoutEffect(() => {
    const { width, height } = viewportSize();
    const h = ref.current?.offsetHeight ?? 200;
    const w = 300;
    let left = x + 22;
    if (left + w > width - 8) left = Math.max(8, x - w - 34);
    let top = y - 30;
    if (top + h > height - 8) top = Math.max(8, height - h - 8);
    if (top < 8) top = 8;
    setPos((p) => (p.left === left && p.top === top ? p : { left, top }));
  });
  return (
    <div
      ref={ref}
      className="c-popover"
      data-comment
      style={pos}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

function Composer({ onSubmit, onCancel, placeholder, autoFocus }: { onSubmit: (text: string) => void; onCancel?: () => void; placeholder: string; autoFocus?: boolean }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  const submit = () => {
    if (!text.trim()) return;
    onSubmit(text);
    setText('');
  };
  return (
    <div className="c-composer">
      <div className="c-composer-row">
        <Avatar name={getUserName()} />
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = Math.min(140, e.target.scrollHeight) + 'px';
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
            if (e.key === 'Escape') onCancel?.();
          }}
        />
        <button className="c-send" disabled={!text.trim()} onClick={submit} title="Post (Enter)">
          <ArrowUp size={14} />
        </button>
      </div>
      <div className="c-hint">
        Commenting as <b>{getUserName()}</b> · Enter to post, ⇧Enter for a new line
      </div>
    </div>
  );
}

export function ThreadView({ thread, compact }: { thread: CommentThread; compact?: boolean }) {
  const [menu, setMenu] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const node = useEditor((s) => (thread.nodeId ? s.doc?.nodes[thread.nodeId] : undefined));
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [thread.messages.length]);
  return (
    <div className="c-thread">
      <header>
        <span className="c-num">#{thread.number}</span>
        <span className="c-where" title={node ? `Pinned to ${node.name}` : 'Pinned to the page'}>
          {node ? node.name : 'Page'}
        </span>
        <span className="grow" />
        <button
          className={`iconbtn ${thread.resolved ? 'active' : ''}`}
          title={thread.resolved ? 'Reopen' : 'Resolve'}
          onClick={() => {
            mutate((d) => setResolved(d, thread.id, !thread.resolved, getUserName()));
            if (!thread.resolved && !getState().showResolved) setState({ openThreadId: null });
          }}
        >
          {thread.resolved ? <RotateCcw size={14} /> : <Check size={14} />}
        </button>
        <div className="c-menu-wrap">
          <button className="iconbtn" title="More" onClick={() => setMenu(!menu)}>
            <MoreHorizontal size={14} />
          </button>
          {menu && (
            <div className="menu c-menu" onMouseLeave={() => setMenu(false)}>
              <button
                onClick={() => {
                  setMenu(false);
                  navigator.clipboard.writeText(`Address Design Canvas comment #${thread.number} (thread ${thread.id}) and resolve it when done.`);
                  toast('Copied a prompt for your agent');
                }}
              >
                Copy prompt for agent
              </button>
              <button
                onClick={() => {
                  setMenu(false);
                  if (!confirm(`Delete comment thread #${thread.number}?`)) return;
                  mutate((d) => deleteThread(d, thread.id));
                  setState({ openThreadId: null });
                }}
              >
                Delete thread
              </button>
            </div>
          )}
        </div>
        {!compact && (
          <button className="iconbtn" title="Close" onClick={() => setState({ openThreadId: null })}>
            <X size={14} />
          </button>
        )}
      </header>
      {thread.resolved && <div className="c-resolved">Resolved{thread.resolvedBy ? ` by ${thread.resolvedBy}` : ''}</div>}
      <div className="c-messages" ref={listRef}>
        {thread.messages.map((m, i) => (
          <div key={m.id} className="c-msg">
            <Avatar name={m.author} agent={m.authorKind === 'agent'} />
            <div className="c-msg-body">
              <div className="c-meta">
                <b>{m.author}</b>
                <span className="muted">
                  {timeAgo(m.createdAt)}
                  {m.editedAt ? ' · edited' : ''}
                </span>
                <button
                  className="iconbtn hover-only c-del"
                  title={i === 0 ? 'Delete thread' : 'Delete reply'}
                  onClick={() => {
                    if (i === 0 && !confirm('Deleting the first message deletes the whole thread. Continue?')) return;
                    mutate((d) => deleteMessage(d, thread.id, m.id));
                    if (i === 0) setState({ openThreadId: null });
                  }}
                >
                  <Trash2 size={11} />
                </button>
              </div>
              <div className="c-text">{m.text}</div>
            </div>
          </div>
        ))}
      </div>
      <Composer placeholder="Reply…" autoFocus={!compact} onSubmit={(text) => mutate((d) => replyToThread(d, thread.id, text, getUserName()))} onCancel={() => setState({ openThreadId: null })} />
    </div>
  );
}
