import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { ArrowUp, Bot, ChevronRight, Loader2, Plus, Settings, Square, Wrench, Check, AlertTriangle } from 'lucide-react';
import { getState, setState, useEditor } from '../store.ts';

type ProviderId = 'claude-code' | 'codex' | 'anthropic' | 'openai';

interface Provider {
  id: ProviderId;
  label: string;
  kind: 'cli' | 'api';
  available: boolean;
  detail: string;
  model: string;
}

type Item =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; status: 'start' | 'end' | 'error'; input?: unknown; summary?: string }
  | { kind: 'log'; text: string }
  | { kind: 'error'; text: string };

interface ChatState {
  items: Item[];
  conversationId: string | null;
  running: boolean;
  runId: string | null;
}

const PROVIDER_META: Record<ProviderId, { name: string; sub: string; models: string[] }> = {
  'claude-code': { name: 'Claude Code', sub: 'Local CLI · your Claude login', models: ['', 'opus', 'sonnet', 'fable', 'haiku'] },
  codex: { name: 'Codex', sub: 'Local CLI · your ChatGPT login', models: ['', 'gpt-5-codex', 'gpt-5'] },
  anthropic: { name: 'Claude', sub: 'Anthropic API key', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'] },
  openai: { name: 'GPT', sub: 'OpenAI API key', models: ['gpt-5', 'gpt-5-mini'] },
};

const SUGGESTIONS = [
  'Design a SaaS pricing page with three tiers, a monthly/yearly toggle and an FAQ',
  'Create a mobile login screen (390×844) with email, password, social sign-in',
  'Make a dark-mode version of the selected frame next to it',
  'Set up design tokens for a calm fintech brand, then a dashboard using them',
  'Turn the selected card into a component and map it to @/components/ui/card',
  'Review the selected screen for spacing, hierarchy and contrast issues and fix them',
];

const useChat = create<Record<string, ChatState>>(() => ({}));

function loadChat(docId: string): ChatState {
  try {
    const raw = localStorage.getItem('dc:chat:' + docId);
    if (raw) return { ...JSON.parse(raw), running: false, runId: null };
  } catch {
    /* ignore */
  }
  return { items: [], conversationId: null, running: false, runId: null };
}

function saveChat(docId: string, c: ChatState) {
  try {
    localStorage.setItem('dc:chat:' + docId, JSON.stringify({ items: c.items.slice(-200), conversationId: c.conversationId }));
  } catch {
    /* ignore */
  }
}

function patchChat(docId: string, fn: (c: ChatState) => ChatState) {
  useChat.setState((s) => {
    const next = fn(s[docId] ?? loadChat(docId));
    saveChat(docId, next);
    return { [docId]: next };
  });
}

export function AIPanel() {
  const docId = useEditor((s) => s.docId)!;
  const chat = useChat((s) => s[docId]) ?? loadChat(docId);
  const selCount = useEditor((s) => s.selection.length);
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [provider, setProvider] = useState<ProviderId>(() => (localStorage.getItem('dc:provider') as ProviderId) || 'claude-code');
  const [model, setModel] = useState<string>(() => localStorage.getItem('dc:model:' + provider) ?? '');
  const [allowRead, setAllowRead] = useState(() => localStorage.getItem('dc:allowRead') !== 'false');
  const [input, setInput] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = () =>
    fetch('/api/ai/providers')
      .then((r) => r.json())
      .then(setProviders)
      .catch(() => setProviders([]));
  useEffect(() => {
    refresh();
  }, []);
  useEffect(() => {
    if (!useChat.getState()[docId]) useChat.setState({ [docId]: loadChat(docId) });
  }, [docId]);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [chat.items.length, chat.items[chat.items.length - 1]]);

  const p = providers?.find((x) => x.id === provider);
  const meta = PROVIDER_META[provider];

  const send = async (text: string) => {
    const prompt = text.trim();
    if (!prompt || chat.running) return;
    setInput('');
    patchChat(docId, (c) => ({ ...c, items: [...c.items, { kind: 'user', text: prompt }], running: true }));
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider, prompt, conversationId: chat.conversationId ?? undefined, docId, model: model || undefined, allowProjectRead: allowRead }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim()) handleEvent(JSON.parse(line));
        }
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') patchChat(docId, (c) => ({ ...c, items: [...c.items, { kind: 'error', text: e.message }] }));
    } finally {
      abortRef.current = null;
      patchChat(docId, (c) => ({ ...c, running: false, runId: null, items: c.items.map((it) => (it.kind === 'tool' && it.status === 'start' ? { ...it, status: 'end' } : it)) }));
    }
  };

  const handleEvent = (e: any) => {
    patchChat(docId, (c) => {
      const items = [...c.items];
      switch (e.type) {
        case 'start':
          return { ...c, runId: e.runId, conversationId: e.conversationId };
        case 'text':
          items.push({ kind: 'text', text: e.text });
          break;
        case 'thinking':
          items.push({ kind: 'thinking', text: e.text });
          break;
        case 'tool': {
          const idx = items.findIndex((it) => it.kind === 'tool' && it.id === e.id);
          if (idx >= 0) items[idx] = { ...(items[idx] as any), status: e.status, summary: e.summary ?? (items[idx] as any).summary };
          else items.push({ kind: 'tool', id: e.id, name: e.name, status: e.status, input: e.input, summary: e.summary });
          break;
        }
        case 'log':
          items.push({ kind: 'log', text: e.text });
          break;
        case 'error':
          items.push({ kind: 'error', text: e.message });
          break;
      }
      return { ...c, items };
    });
  };

  const stop = () => {
    const runId = useChat.getState()[docId]?.runId;
    if (runId) fetch('/api/ai/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId }) });
    abortRef.current?.abort();
  };

  return (
    <div className="ai-panel">
      <div className="ai-head">
        <div className="provider-tabs">
          {(Object.keys(PROVIDER_META) as ProviderId[]).map((id) => {
            const st = providers?.find((x) => x.id === id);
            return (
              <button
                key={id}
                className={`${provider === id ? 'active' : ''} ${st && !st.available ? 'unavailable' : ''}`}
                title={st?.detail ?? ''}
                onClick={() => {
                  setProvider(id);
                  localStorage.setItem('dc:provider', id);
                  setModel(localStorage.getItem('dc:model:' + id) ?? '');
                }}
              >
                <span className={`dot ${st ? (st.available ? 'ok' : 'off') : ''}`} />
                {PROVIDER_META[id].name}
              </button>
            );
          })}
        </div>
        <div className="prow small">
          <span className="muted grow">{meta.sub}</span>
          <select
            className="select narrow"
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              localStorage.setItem('dc:model:' + provider, e.target.value);
            }}
            title="Model"
          >
            {[...new Set([...meta.models, model])].map((m) => (
              <option key={m} value={m}>
                {m || 'default model'}
              </option>
            ))}
          </select>
          <button className="iconbtn" title="New chat" onClick={() => patchChat(docId, () => ({ items: [], conversationId: null, running: false, runId: null }))}>
            <Plus size={14} />
          </button>
          <button className="iconbtn" title="Settings & API keys" onClick={() => setState({ dialog: 'settings' })}>
            <Settings size={14} />
          </button>
        </div>
        {p && !p.available && (
          <div className="ai-warning">
            <AlertTriangle size={13} />
            <span>
              {p.detail}
              {p.kind === 'cli' && (
                <>
                  {' '}
                  — install with <code>{provider === 'codex' ? 'npm i -g @openai/codex' : 'npm i -g @anthropic-ai/claude-code'}</code> and log in.
                </>
              )}
            </span>
            <button className="btn small ghost" onClick={refresh}>
              Recheck
            </button>
          </div>
        )}
      </div>
      <div className="ai-list" ref={listRef}>
        {!chat.items.length && (
          <div className="ai-empty">
            <Bot size={22} />
            <p>
              Ask <b>{meta.name}</b> to design or change anything. It edits this file live through the same tools Claude Code and Codex use over MCP.
            </p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {chat.items.map((it, i) => (
          <ChatItem key={i} item={it} />
        ))}
        {chat.running && (
          <div className="ai-running">
            <Loader2 size={14} className="spin" /> {meta.name} is working…
          </div>
        )}
      </div>
      <div className="ai-input">
        {selCount > 0 && <div className="ai-context">Context: {selCount} selected layer{selCount > 1 ? 's' : ''}</div>}
        <textarea
          value={input}
          placeholder={`Describe a screen or a change… (${selCount ? 'uses your selection' : 'nothing selected'})`}
          rows={3}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
        />
        <div className="prow">
          {p?.kind === 'cli' && (
            <label className="check small" title="Lets the agent read (not write) files in the project folder, e.g. to match your existing UI">
              <input
                type="checkbox"
                checked={allowRead}
                onChange={(e) => {
                  setAllowRead(e.target.checked);
                  localStorage.setItem('dc:allowRead', String(e.target.checked));
                }}
              />
              Read project files
            </label>
          )}
          <span className="grow" />
          {chat.running ? (
            <button className="btn small danger" onClick={stop}>
              <Square size={12} /> Stop
            </button>
          ) : (
            <button className="btn small primary" onClick={() => send(input)} disabled={!input.trim()}>
              <ArrowUp size={13} /> Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ChatItem({ item }: { item: Item }) {
  const [open, setOpen] = useState(false);
  switch (item.kind) {
    case 'user':
      return <div className="msg user">{item.text}</div>;
    case 'text':
      return <div className="msg assistant">{renderText(item.text)}</div>;
    case 'thinking':
      return (
        <div className="msg thinking" onClick={() => setOpen(!open)}>
          <ChevronRight size={11} className={open ? 'rot' : ''} /> Thinking{open ? '' : '…'}
          {open && <div className="thinking-body">{item.text}</div>}
        </div>
      );
    case 'tool':
      return (
        <div className={`tool-chip ${item.status}`} onClick={() => setOpen(!open)} title={item.summary}>
          <span className="tool-icon">{item.status === 'start' ? <Loader2 size={11} className="spin" /> : item.status === 'error' ? <AlertTriangle size={11} /> : <Check size={11} />}</span>
          <Wrench size={11} /> {item.name}
          {open && (
            <div className="tool-body">
              {item.input !== undefined && <pre>{JSON.stringify(item.input, null, 1).slice(0, 3000)}</pre>}
              {item.summary && <pre>{item.summary}</pre>}
            </div>
          )}
        </div>
      );
    case 'log':
      return <div className="msg log">{item.text}</div>;
    case 'error':
      return <div className="msg error">{item.text}</div>;
  }
}

function renderText(t: string) {
  const parts = t.split(/```(?:\w+)?\n?/);
  return parts.map((p, i) =>
    i % 2 ? (
      <pre key={i} className="code small">
        {p}
      </pre>
    ) : (
      <span key={i}>
        {p.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map((s, j) =>
          s.startsWith('`') && s.endsWith('`') ? <code key={j}>{s.slice(1, -1)}</code> : s.startsWith('**') && s.endsWith('**') ? <b key={j}>{s.slice(2, -2)}</b> : s,
        )}
      </span>
    ),
  );
}

export function useAiRunning(): boolean {
  const docId = useEditor((s) => s.docId);
  return useChat((s) => (docId ? !!s[docId]?.running : false));
}

void getState;
