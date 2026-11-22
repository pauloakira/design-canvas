import { useEffect, useState, type ReactNode } from 'react';
import { X, CheckCircle2, Circle } from 'lucide-react';
import { setState, toast, useEditor } from '../store.ts';
import { SHORTCUTS } from '../editor/shortcuts.ts';
import { CopyButton } from './controls.tsx';

interface Info {
  url: string;
  mcpUrl: string;
  bridgePath: string;
  nodePath: string;
  projectDir: string;
  dataDir: string;
  tools: Array<{ name: string; title: string; description: string }>;
}

function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} onKeyDown={(e) => e.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <button className="iconbtn" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

function Cmd({ text }: { text: string }) {
  return (
    <div className="cmd">
      <code>{text}</code>
      <CopyButton text={text} />
    </div>
  );
}

export function Dialogs() {
  const dialog = useEditor((s) => s.dialog);
  const close = () => setState({ dialog: null });
  if (dialog === 'connect') return <ConnectDialog onClose={close} />;
  if (dialog === 'settings') return <SettingsDialog onClose={close} />;
  if (dialog === 'shortcuts')
    return (
      <Modal title="Keyboard shortcuts" onClose={close}>
        <div className="shortcuts">
          {SHORTCUTS.map(([k, d]) => (
            <div key={k}>
              <kbd>{k}</kbd>
              <span>{d}</span>
            </div>
          ))}
        </div>
      </Modal>
    );
  return null;
}

function ConnectDialog({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<Info | null>(null);
  const initialTab = useEditor((s) => s.connectTab);
  const [tab, setTab] = useState<'claude' | 'codex' | 'other' | 'figma'>(initialTab ?? 'claude');
  useEffect(() => () => setState({ connectTab: null }), []);
  const clients = useEditor((s) => s.mcpClients);
  useEffect(() => {
    fetch('/api/info')
      .then((r) => r.json())
      .then(setInfo);
  }, []);
  if (!info) return null;
  const bridge = `${info.nodePath} ${info.bridgePath}`;
  const codexToml = `[mcp_servers.design-canvas]\ncommand = ${JSON.stringify(info.nodePath)}\nargs = [${JSON.stringify(info.bridgePath)}]`;
  const jsonCfg = JSON.stringify({ mcpServers: { 'design-canvas': { command: info.nodePath, args: [info.bridgePath] } } }, null, 2);
  const httpCfg = JSON.stringify({ mcpServers: { 'design-canvas': { type: 'http', url: info.mcpUrl } } }, null, 2);
  return (
    <Modal title="Connect your coding agent" onClose={onClose} wide>
      <p className="lead">
        Design Canvas exposes an <b>MCP server</b> — like Figma's Dev Mode MCP, but it can also <b>create and edit</b> designs. Your agent can read the current selection, generate code from it, take screenshots, and design new screens.
      </p>
      <div className="mcp-status">
        <span className="muted">Endpoint</span> <code>{info.mcpUrl}</code>
        <span className="grow" />
        {clients.length ? (
          clients.map((c) => (
            <span key={c.sessionId} className="client-pill">
              <CheckCircle2 size={12} /> {c.name}
              {c.lastTool ? <span className="muted"> · {c.lastTool}</span> : null}
            </span>
          ))
        ) : (
          <span className="muted small">
            <Circle size={10} /> No agent connected yet
          </span>
        )}
      </div>
      <div className="tabs">
        <button className={tab === 'claude' ? 'active' : ''} onClick={() => setTab('claude')}>
          Claude Code
        </button>
        <button className={tab === 'codex' ? 'active' : ''} onClick={() => setTab('codex')}>
          Codex
        </button>
        <button className={tab === 'other' ? 'active' : ''} onClick={() => setTab('other')}>
          Claude Desktop · Cursor · others
        </button>
        <button className={tab === 'figma' ? 'active' : ''} onClick={() => setTab('figma')}>
          Figma
        </button>
      </div>
      {tab === 'figma' && <FigmaSetup />}
      {tab === 'claude' && (
        <div className="connect-body">
          <h3>1. Register the server (once)</h3>
          <Cmd text={`claude mcp add --transport http --scope user design-canvas ${info.mcpUrl}`} />
          <p className="hint">
            Use <code>--scope project</code> instead to share it with your team via <code>.mcp.json</code>. Check with <code>claude mcp list</code> or <code>/mcp</code> inside Claude Code.
          </p>
          <h3>2. Use it from your project</h3>
          <ExamplePrompts />
        </div>
      )}
      {tab === 'codex' && (
        <div className="connect-body">
          <h3>1. Register the server (once)</h3>
          <Cmd text={`codex mcp add design-canvas -- ${bridge}`} />
          <p className="hint">Or add this to <code>~/.codex/config.toml</code>:</p>
          <pre className="code small">{codexToml}</pre>
          <p className="hint">
            The bridge (<code>bin/design-canvas-mcp.mjs</code>) relays stdio to this server, so Design Canvas must be running. Newer Codex versions can also use the HTTP endpoint directly: <code>codex mcp add design-canvas --url {info.mcpUrl}</code>.
          </p>
          <h3>2. Use it from your project</h3>
          <ExamplePrompts />
        </div>
      )}
      {tab === 'other' && (
        <div className="connect-body">
          <h3>Clients that support HTTP MCP servers (Cursor, VS Code, Windsurf…)</h3>
          <pre className="code small">{httpCfg}</pre>
          <h3>stdio-only clients (Claude Desktop)</h3>
          <pre className="code small">{jsonCfg}</pre>
          <p className="hint">Add to the client's MCP config file, then restart it.</p>
        </div>
      )}
      <details className="tool-list">
        <summary>{info.tools.length} tools available</summary>
        {info.tools.map((t) => (
          <div key={t.name}>
            <code>{t.name}</code> <span className="muted">— {t.description.split('. ')[0]}.</span>
          </div>
        ))}
      </details>
    </Modal>
  );
}

function FigmaSetup() {
  const [st, setSt] = useState<{ token: string; pluginConnected: boolean; manifestPath: string } | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch('/api/figma/status')
        .then((r) => r.json())
        .then((d) => alive && setSt(d))
        .catch(() => {});
    load();
    const t = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (!st) return null;
  return (
    <div className="connect-body">
      <p className="hint" style={{ marginTop: 0 }}>
        Send frames to Figma as <b>real Figma layers</b>: auto layout stays auto layout, components become main components, instances stay linked to them, and tokens become
        Figma variables (with <code>var(--name)</code> code syntax). Sending again <b>updates the same layers</b>, so a component change here reaches every instance in Figma.
      </p>
      <h3>1. Install the plugin (once, in the Figma desktop app)</h3>
      <p className="hint">
        Plugins → Development → <b>Import plugin from manifest…</b> and pick:
      </p>
      <Cmd text={st.manifestPath} />
      <h3>2. Open it in your Figma file and paste the pairing code</h3>
      <Cmd text={st.token} />
      <p className="hint">
        The code lets only your plugin talk to this server.{' '}
        <button
          className="linkbtn"
          onClick={async () => {
            if (!confirm('Reset the pairing code? The plugin will need the new code.')) return;
            await fetch('/api/figma/token/reset', { method: 'POST' });
            setSt({ ...st, token: (await (await fetch('/api/figma/status')).json()).token });
          }}
        >
          Reset code
        </button>
      </p>
      <h3>3. Send</h3>
      <p className="hint">
        Select frames or components and press <kbd>⌥⇧F</kbd> (or right-click → <b>Send to Figma</b>). With nothing selected the whole page is sent. Agents can do it too with the{' '}
        <code>send_to_figma</code> MCP tool.
      </p>
      <div className="mcp-status">
        {st.pluginConnected ? (
          <span className="client-pill">
            <CheckCircle2 size={12} /> Figma plugin connected
          </span>
        ) : (
          <span className="muted small">
            <Circle size={10} /> Plugin not connected — open it in Figma
          </span>
        )}
      </div>
    </div>
  );
}

function ExamplePrompts() {
  const prompts = [
    'Implement my current Design Canvas selection as a React component in src/components, using our Tailwind theme.',
    'Look at src/app/settings/page.tsx and recreate that page in Design Canvas so I can iterate on the design.',
    'Design a mobile onboarding flow (3 screens) in Design Canvas, then implement it.',
    'Compare the Design Canvas "Checkout" frame with our implementation and fix the differences.',
  ];
  return (
    <div className="examples">
      {prompts.map((p) => (
        <div key={p} className="example">
          <span>“{p}”</span>
          <CopyButton text={p} />
        </div>
      ))}
    </div>
  );
}

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then(setS);
  }, []);
  if (!s) return null;
  const field = (k: string, label: string, placeholder: string, secret = false) => (
    <label className="field">
      <span>{label}</span>
      <input type={secret ? 'password' : 'text'} value={s[k] ?? ''} placeholder={placeholder} onChange={(e) => setS({ ...s, [k]: e.target.value })} />
    </label>
  );
  const save = async () => {
    await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(s) });
    toast('Settings saved');
    onClose();
  };
  return (
    <Modal title="AI settings" onClose={onClose}>
      <p className="hint">
        <b>Claude Code</b> and <b>Codex</b> use your local CLI logins — no keys needed. API keys are only for the direct <b>Claude API</b> and <b>OpenAI API</b> providers. They are stored locally in your designs folder (<code>.settings.json</code>) and never sent anywhere except the provider.
      </p>
      {field('anthropicApiKey', 'Anthropic API key', 'sk-ant-…', true)}
      {field('anthropicModel', 'Claude API model', 'claude-opus-5-5')}
      {field('openaiApiKey', 'OpenAI API key', 'sk-…', true)}
      {field('openaiModel', 'OpenAI model', 'gpt-5')}
      {field('claudeCodeModel', 'Claude Code model (optional)', 'default')}
      {field('codexModel', 'Codex model (optional)', 'default')}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" onClick={save}>
          Save
        </button>
      </div>
    </Modal>
  );
}
