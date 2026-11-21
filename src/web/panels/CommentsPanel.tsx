import { useState } from 'react';
import { CheckCircle2, MessageCircle } from 'lucide-react';
import { setState, setTool, useEditor } from '../store.ts';
import { Avatar, openThread, timeAgo } from '../canvas/Comments.tsx';
import { getUserName, setUserName } from '../sync.ts';

export function CommentsPanel() {
  const comments = useEditor((s) => s.doc?.comments);
  const pages = useEditor((s) => s.doc?.pages);
  const pageId = useEditor((s) => s.pageId);
  const openId = useEditor((s) => s.openThreadId);
  const showResolved = useEditor((s) => s.showResolved);
  const showComments = useEditor((s) => s.showComments);
  const nodes = useEditor((s) => s.doc?.nodes);
  const [scope, setScope] = useState<'page' | 'all'>('page');
  const [name, setName] = useState(getUserName());
  const all = Object.values(comments ?? {});
  const list = all
    .filter((t) => (scope === 'all' || t.pageId === pageId) && (showResolved || !t.resolved))
    .sort((a, b) => (b.messages[b.messages.length - 1]?.createdAt ?? 0) - (a.messages[a.messages.length - 1]?.createdAt ?? 0));
  const openCount = all.filter((t) => !t.resolved).length;
  return (
    <div className="comments-panel">
      <div className="cp-controls">
        <div className="seg">
          <button className={`iconbtn ${scope === 'page' ? 'active' : ''}`} onClick={() => setScope('page')}>
            This page
          </button>
          <button className={`iconbtn ${scope === 'all' ? 'active' : ''}`} onClick={() => setScope('all')}>
            All pages
          </button>
        </div>
        <span className="grow" />
        <span className="muted small">{openCount} open</span>
      </div>
      <div className="cp-controls">
        <label className="check">
          <input type="checkbox" checked={showResolved} onChange={(e) => setState({ showResolved: e.target.checked })} />
          Show resolved
        </label>
        <label className="check">
          <input type="checkbox" checked={showComments} onChange={(e) => setState({ showComments: e.target.checked })} />
          Pins on canvas
        </label>
      </div>
      {!list.length && (
        <div className="empty-state">
          <MessageCircle size={20} />
          <p>No {showResolved ? '' : 'open '}comments{scope === 'page' ? ' on this page' : ''}.</p>
          <p className="hint">
            Press <kbd>C</kbd> and click anywhere on the design to leave feedback. Agents connected over MCP can read, reply to and resolve comments too.
          </p>
          <button className="btn small" onClick={() => setTool('comment')}>
            Add a comment
          </button>
        </div>
      )}
      <div className="cp-list">
        {list.map((t) => {
          const first = t.messages[0];
          const last = t.messages[t.messages.length - 1];
          const node = t.nodeId ? nodes?.[t.nodeId] : undefined;
          return (
            <button key={t.id} className={`cp-item ${t.id === openId ? 'active' : ''} ${t.resolved ? 'resolved' : ''}`} onClick={() => openThread(t.id)}>
              <div className="cp-head">
                <Avatar name={first.author} agent={first.authorKind === 'agent'} size={20} />
                <b>{first.author}</b>
                <span className="muted">{timeAgo(last.createdAt)}</span>
                <span className="grow" />
                {t.resolved ? <CheckCircle2 size={13} className="ok" /> : <span className="c-num">#{t.number}</span>}
              </div>
              <div className="cp-text">{first.text}</div>
              <div className="cp-foot muted">
                {t.messages.length > 1 ? `${t.messages.length - 1} repl${t.messages.length === 2 ? 'y' : 'ies'} · ` : ''}
                {node ? node.name : 'Page'}
                {scope === 'all' && pages?.[t.pageId] ? ` · ${pages[t.pageId].name}` : ''}
              </div>
            </button>
          );
        })}
      </div>
      <div className="cp-name">
        <span className="muted small">Your name</span>
        <input
          className="text-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setUserName(name)}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </div>
    </div>
  );
}
