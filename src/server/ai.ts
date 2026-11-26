/**
 * In-app AI agents. Four providers drive the same design tools:
 *  - Claude Code CLI (`claude -p`, uses your Claude subscription / login)
 *  - Codex CLI (`codex exec`, uses your ChatGPT / OpenAI login)
 *  - Claude API (Anthropic Messages API, needs ANTHROPIC_API_KEY)
 *  - OpenAI API (Responses API, needs OPENAI_API_KEY)
 * The CLI agents connect back to this server over MCP.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESIGN_GUIDE } from '../shared/guide.ts';
import { outline, pageOutline } from '../shared/outline.ts';
import { resolvePageId, uid } from '../shared/doc.ts';
import { apiKey, loadSettings, PORT, PROJECT_DIR } from './config.ts';
import { runTool, toolJsonSchemas, type ToolContext, type ToolResult } from './tools.ts';
import type { DocStore } from './store.ts';
import type { Hub } from './hub.ts';

export type ProviderId = 'claude-code' | 'codex' | 'anthropic' | 'openai';

export type AiEvent =
  | { type: 'start'; runId: string; conversationId: string }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; id: string; name: string; status: 'start' | 'end' | 'error'; input?: unknown; summary?: string }
  | { type: 'session'; id: string }
  | { type: 'log'; text: string }
  | { type: 'done'; costUsd?: number }
  | { type: 'error'; message: string };

export interface ChatRequest {
  provider: ProviderId;
  prompt: string;
  conversationId?: string;
  docId?: string;
  model?: string;
  /** Let CLI agents read files in the project directory (read-only). */
  allowProjectRead?: boolean;
}

const BIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin');
const MCP_URL = `http://127.0.0.1:${PORT}/mcp`;

const SYSTEM_PROMPT = `You are a senior product designer and design engineer working inside Design Canvas, a Figma-like design tool built for engineers. The user talks to you from the editor's AI panel. Use the design-canvas tools to inspect and edit the open document directly — do not just describe designs or print code unless asked.

${DESIGN_GUIDE}

Work style:
- Act, don't ask, for reasonable requests. Make sensible product decisions; keep explanations short (2–4 sentences) after you finish.
- When the user refers to "this"/"selected", use the selection given in the context.
- After creating or substantially changing a screen, take a screenshot (get_screenshot) and fix any visual issues you notice (overflow, misalignment, clipped text, poor contrast).`;

// ---------------------------------------------------------------------------
// Provider availability
// ---------------------------------------------------------------------------

let cliCache: { at: number; value: Record<string, { available: boolean; detail: string }> } | null = null;

function run(cmd: string, args: string[], timeoutMs = 8000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = '';
    try {
      const p = spawn(cmd, args, { env: childEnv(), shell: false, cwd: PROJECT_DIR });
      const t = setTimeout(() => p.kill(), timeoutMs);
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      p.on('error', () => {
        clearTimeout(t);
        resolve({ code: -1, out });
      });
      p.on('close', (code) => {
        clearTimeout(t);
        resolve({ code, out });
      });
    } catch {
      resolve({ code: -1, out: '' });
    }
  });
}

/** Version + login check, so the UI can say exactly what to fix. */
async function cliStatus(cmd: 'claude' | 'codex'): Promise<{ available: boolean; detail: string }> {
  const v = await cliVersion(cmd);
  if (!v.available) return v;
  if (cmd === 'claude') {
    const s = await run('claude', ['auth', 'status']);
    try {
      const j = JSON.parse(s.out.slice(s.out.indexOf('{')));
      if (j.loggedIn === false) return { available: false, detail: `${v.detail} — not logged in. Run \`claude\` in a terminal and use /login.` };
    } catch {
      /* older CLI without `auth status`: assume OK */
    }
  } else {
    const s = await run('codex', ['login', 'status']);
    if (s.code !== 0 && /not logged in/i.test(s.out)) return { available: false, detail: `${v.detail} — not logged in. Run \`codex login\`.` };
  }
  return v;
}

function cliVersion(cmd: string): Promise<{ available: boolean; detail: string }> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v: { available: boolean; detail: string }) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    try {
      const p = spawn(cmd, ['--version'], { env: childEnv(), shell: false });
      const t = setTimeout(() => {
        p.kill();
        finish({ available: false, detail: `${cmd} --version timed out` });
      }, 8000);
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      p.on('error', () => {
        clearTimeout(t);
        finish({ available: false, detail: `${cmd} not found on PATH` });
      });
      p.on('close', (code) => {
        clearTimeout(t);
        if (code === 0) finish({ available: true, detail: out.trim().split('\n')[0] });
        else if (/ENOENT/.test(out)) finish({ available: false, detail: `The ${cmd} install looks broken (its native binary is missing). Reinstall it, e.g. npm i -g ${cmd === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code'}` });
        else finish({ available: false, detail: out.split('\n').find((l) => /error/i.test(l))?.trim().slice(0, 200) || `${cmd} --version exited with ${code}` });
      });
    } catch {
      finish({ available: false, detail: `${cmd} not found` });
    }
  });
}

export async function providerStatus() {
  if (!cliCache || Date.now() - cliCache.at > 30000) {
    const [claude, codex] = await Promise.all([cliStatus('claude'), cliStatus('codex')]);
    cliCache = { at: Date.now(), value: { claude, codex } };
  }
  const s = loadSettings();
  return [
    { id: 'claude-code', label: 'Claude Code', kind: 'cli', ...cliCache.value.claude, model: s.claudeCodeModel ?? '' },
    { id: 'codex', label: 'Codex', kind: 'cli', ...cliCache.value.codex, model: s.codexModel ?? '' },
    {
      id: 'anthropic',
      label: 'Claude API',
      kind: 'api',
      available: !!apiKey('anthropic'),
      detail: apiKey('anthropic') ? 'API key configured' : 'Add an Anthropic API key in Settings or set ANTHROPIC_API_KEY',
      model: s.anthropicModel ?? 'claude-opus-5-5',
    },
    {
      id: 'openai',
      label: 'OpenAI API',
      kind: 'api',
      available: !!apiKey('openai'),
      detail: apiKey('openai') ? 'API key configured' : 'Add an OpenAI API key in Settings or set OPENAI_API_KEY',
      model: s.openaiModel ?? 'gpt-5',
    },
  ];
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // If Design Canvas was started from inside another agent session (e.g. a
  // Claude Code terminal), that session's variables point the CLI at the host's
  // auth proxy. Strip them so the child uses the user's own CLI login.
  const insideAgent = !!(env.CLAUDECODE || env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_CODE_ENTRYPOINT);
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k.startsWith('CLAUDE_AGENT_SDK_') || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT' || k.startsWith('CODEX_SANDBOX')) delete env[k];
  }
  if (insideAgent) {
    delete env.ANTHROPIC_BASE_URL;
    delete env.AI_AGENT;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Conversations & runs
// ---------------------------------------------------------------------------

interface Conversation {
  id: string;
  provider: ProviderId;
  claudeSessionId?: string;
  anthropicMessages?: any[];
  openaiPrevId?: string;
  transcript: Array<{ role: 'user' | 'assistant'; text: string }>;
}

const conversations = new Map<string, Conversation>();
const runs = new Map<string, { cancel: () => void }>();

export function cancelRun(runId: string): boolean {
  const r = runs.get(runId);
  if (!r) return false;
  r.cancel();
  runs.delete(runId);
  return true;
}

function contextBlock(store: DocStore, hub: Hub, docId?: string): string {
  const id = docId ?? hub.selection()?.docId ?? store.lastActiveDocId ?? undefined;
  if (!id || !store.exists(id)) return '[Design Canvas] No document is open.';
  const doc = store.getDoc(id);
  const sel = hub.selection(id);
  const pageId = resolvePageId(doc, sel?.pageId);
  const ids = (sel?.ids ?? []).filter((i) => doc.nodes[i]);
  const lines = [`[Design Canvas context] Document "${doc.name}" (documentId: ${doc.id}), current page "${doc.pages[pageId].name}" (pageId: ${pageId}).`];
  if (ids.length) lines.push(`Selected layers:\n${outline(doc, ids, 2, 60)}`);
  else lines.push(`Nothing selected. Page overview:\n${pageOutline(doc, pageId, 1)}`);
  return lines.join('\n');
}

export async function runChat(req: ChatRequest, ctx: { store: DocStore; hub: Hub }, emit: (e: AiEvent) => void): Promise<void> {
  const runId = uid(10);
  let conv = req.conversationId ? conversations.get(req.conversationId) : undefined;
  if (!conv || conv.provider !== req.provider) {
    conv = { id: req.conversationId ?? uid(12), provider: req.provider, transcript: [] };
    conversations.set(conv.id, conv);
  }
  emit({ type: 'start', runId, conversationId: conv.id });
  const context = contextBlock(ctx.store, ctx.hub, req.docId);
  const fullPrompt = `${context}\n\nUser request: ${req.prompt}`;
  conv.transcript.push({ role: 'user', text: req.prompt });
  let assistantText = '';
  const wrappedEmit = (e: AiEvent) => {
    if (e.type === 'text') assistantText += (assistantText ? '\n' : '') + e.text;
    emit(e);
  };
  try {
    switch (req.provider) {
      case 'claude-code':
        await runClaudeCode(runId, conv, fullPrompt, req, wrappedEmit);
        break;
      case 'codex':
        await runCodex(runId, conv, fullPrompt, req, wrappedEmit);
        break;
      case 'anthropic':
        await runAnthropic(runId, conv, fullPrompt, req, ctx, wrappedEmit);
        break;
      case 'openai':
        await runOpenAI(runId, conv, fullPrompt, req, ctx, wrappedEmit);
        break;
      default:
        throw new Error(`Unknown provider ${req.provider}`);
    }
    emit({ type: 'done' });
  } catch (err: any) {
    emit({ type: 'error', message: err?.message ?? String(err) });
  } finally {
    runs.delete(runId);
    if (assistantText) conv.transcript.push({ role: 'assistant', text: assistantText.slice(0, 4000) });
  }
}

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

function spawnJsonLines(
  runId: string,
  cmd: string,
  args: string[],
  opts: { stdin?: string; cwd: string },
  onLine: (obj: any) => void,
  emit: (e: AiEvent) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e: any) {
      reject(new Error(`Could not start ${cmd}: ${e.message}`));
      return;
    }
    let cancelled = false;
    runs.set(runId, {
      cancel: () => {
        cancelled = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 3000);
      },
    });
    let buf = '';
    let stderr = '';
    child.stdout!.on('data', (d) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          onLine(JSON.parse(line));
        } catch {
          emit({ type: 'log', text: line.slice(0, 500) });
        }
      }
    });
    child.stderr!.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    child.on('error', (e: any) => {
      reject(new Error(e.code === 'ENOENT' ? `"${cmd}" was not found on PATH. Install it and log in first.` : e.message));
    });
    child.on('close', (code) => {
      if (buf.trim()) {
        try {
          onLine(JSON.parse(buf.trim()));
        } catch {
          /* ignore */
        }
      }
      if (cancelled) resolve();
      else if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}${stderr ? `: ${stderr.trim().split('\n').slice(-6).join('\n')}` : ''}`));
    });
    if (opts.stdin !== undefined) {
      child.stdin!.write(opts.stdin);
    }
    child.stdin!.end();
  });
}

function shortToolName(name: string): string {
  return name.replace(/^mcp__design-canvas__/, '').replace(/^design-canvas[._]/, '');
}

function summarizeResult(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, 300);
  if (Array.isArray(content)) {
    const t = content.find((c: any) => c?.type === 'text');
    if (t) return String((t as any).text).slice(0, 300);
    if (content.some((c: any) => c?.type === 'image')) return '[image]';
  }
  return '';
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

async function runClaudeCode(runId: string, conv: Conversation, prompt: string, req: ChatRequest, emit: (e: AiEvent) => void) {
  const mcpConfig = JSON.stringify({ mcpServers: { 'design-canvas': { type: 'http', url: MCP_URL } } });
  const read = req.allowProjectRead !== false;
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--mcp-config',
    mcpConfig,
    '--strict-mcp-config',
    '--permission-mode',
    'dontAsk',
    '--append-system-prompt',
    SYSTEM_PROMPT,
    '--tools',
    read ? 'Read,Glob,Grep' : '',
    '--allowedTools',
    'mcp__design-canvas',
    ...(read ? ['Read', 'Glob', 'Grep'] : []),
  ];
  const model = req.model || loadSettings().claudeCodeModel;
  if (model) args.push('--model', model);
  if (conv.claudeSessionId) args.push('--resume', conv.claudeSessionId);
  const toolNames = new Map<string, string>();
  await spawnJsonLines(
    runId,
    'claude',
    args,
    { stdin: prompt, cwd: PROJECT_DIR },
    (ev) => {
      if (ev.session_id && ev.session_id !== conv.claudeSessionId) {
        conv.claudeSessionId = ev.session_id;
        emit({ type: 'session', id: ev.session_id });
      }
      if (ev.type === 'system' && ev.subtype === 'init') {
        const dc = (ev.mcp_servers ?? []).find((s: any) => s.name === 'design-canvas');
        if (dc && dc.status !== 'connected') emit({ type: 'log', text: `design-canvas MCP status: ${dc.status}` });
      } else if (ev.type === 'assistant') {
        for (const block of ev.message?.content ?? []) {
          if (block.type === 'text' && block.text?.trim()) emit({ type: 'text', text: block.text });
          else if (block.type === 'thinking' && block.thinking) emit({ type: 'thinking', text: block.thinking });
          else if (block.type === 'tool_use') {
            const name = shortToolName(block.name);
            toolNames.set(block.id, name);
            emit({ type: 'tool', id: block.id, name, status: 'start', input: block.input });
          }
        }
      } else if (ev.type === 'user') {
        for (const block of ev.message?.content ?? []) {
          if (block.type === 'tool_result') {
            emit({
              type: 'tool',
              id: block.tool_use_id,
              name: toolNames.get(block.tool_use_id) ?? 'tool',
              status: block.is_error ? 'error' : 'end',
              summary: summarizeResult(block.content),
            });
          }
        }
      } else if (ev.type === 'result') {
        if (ev.is_error && ev.result) emit({ type: 'error', message: String(ev.result) });
        if (typeof ev.total_cost_usd === 'number') emit({ type: 'log', text: `Cost: $${ev.total_cost_usd.toFixed(4)}` });
      }
    },
    emit,
  );
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

async function runCodex(runId: string, conv: Conversation, prompt: string, req: ChatRequest, emit: (e: AiEvent) => void) {
  const bridge = path.join(BIN_DIR, 'design-canvas-mcp.mjs');
  const history = conv.transcript
    .slice(0, -1)
    .slice(-8)
    .map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${m.text}`)
    .join('\n');
  const fullPrompt = `${SYSTEM_PROMPT}\n\n${history ? `Earlier in this conversation:\n${history}\n\n` : ''}${prompt}`;
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '-C',
    PROJECT_DIR,
    '-c',
    'approval_policy="never"',
    '-c',
    `mcp_servers.design-canvas.command=${JSON.stringify(process.execPath)}`,
    '-c',
    `mcp_servers.design-canvas.args=${JSON.stringify([bridge, '--url', MCP_URL, '--name', 'Codex'])}`,
  ];
  const model = req.model || loadSettings().codexModel;
  if (model) args.push('-m', model);
  args.push(fullPrompt);
  await spawnJsonLines(
    runId,
    'codex',
    args,
    { cwd: PROJECT_DIR },
    (ev) => {
      // New event format (codex ≥ 0.4x)
      if (ev.type === 'thread.started' && ev.thread_id) emit({ type: 'session', id: ev.thread_id });
      if ((ev.type === 'item.started' || ev.type === 'item.completed' || ev.type === 'item.updated') && ev.item) {
        const it = ev.item;
        if (it.type === 'agent_message' && ev.type === 'item.completed') emit({ type: 'text', text: it.text ?? '' });
        else if (it.type === 'reasoning' && ev.type === 'item.completed' && it.text) emit({ type: 'thinking', text: it.text });
        else if (it.type === 'mcp_tool_call') {
          const status = ev.type === 'item.started' ? 'start' : it.status === 'failed' || it.error ? 'error' : 'end';
          if (ev.type !== 'item.updated')
            emit({ type: 'tool', id: it.id, name: shortToolName(it.tool ?? 'tool'), status, input: it.arguments, summary: summarizeResult(it.result?.content ?? it.error?.message) });
        } else if (it.type === 'command_execution' && ev.type === 'item.started') emit({ type: 'log', text: `$ ${it.command}` });
        else if (it.type === 'error') emit({ type: 'log', text: it.message ?? 'error' });
      }
      if (ev.type === 'turn.failed') emit({ type: 'error', message: ev.error?.message ?? 'Codex turn failed' });
      if (ev.type === 'error' && ev.message) emit({ type: 'log', text: ev.message });
      // Legacy format
      const m = ev.msg;
      if (m) {
        if (m.type === 'agent_message') emit({ type: 'text', text: m.message });
        else if (m.type === 'mcp_tool_call_begin') emit({ type: 'tool', id: m.call_id, name: shortToolName(m.invocation?.tool ?? 'tool'), status: 'start', input: m.invocation?.arguments });
        else if (m.type === 'mcp_tool_call_end') emit({ type: 'tool', id: m.call_id, name: shortToolName(m.invocation?.tool ?? 'tool'), status: 'end' });
        else if (m.type === 'error') emit({ type: 'error', message: m.message });
      }
    },
    emit,
  );
}

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------

function toolCtx(ctx: { store: DocStore; hub: Hub }, agent: string): ToolContext {
  return { store: ctx.store, hub: ctx.hub, agent };
}

async function callTool(name: string, input: any, ctx: ToolContext, docId: string | null): Promise<ToolResult> {
  ctx.hub.agentActivity(docId, { name: ctx.agent, tool: name, status: 'start' });
  const res = await runTool(name, input, ctx);
  ctx.hub.agentActivity(docId, { name: ctx.agent, tool: name, status: res.isError ? 'error' : 'end' });
  return res;
}

async function runAnthropic(runId: string, conv: Conversation, prompt: string, req: ChatRequest, ctx: { store: DocStore; hub: Hub }, emit: (e: AiEvent) => void) {
  const key = apiKey('anthropic');
  if (!key) throw new Error('No Anthropic API key. Add one in Settings (gear icon) or set ANTHROPIC_API_KEY.');
  const model = req.model || loadSettings().anthropicModel || 'claude-opus-5-5';
  const controller = new AbortController();
  runs.set(runId, { cancel: () => controller.abort() });
  const tools = toolJsonSchemas().map((t, i, arr) => ({
    name: t.name,
    description: t.description,
    input_schema: t.schema,
    ...(i === arr.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
  }));
  const messages = (conv.anthropicMessages ??= []);
  messages.push({ role: 'user', content: prompt });
  const tctx = toolCtx(ctx, 'Claude');
  for (let step = 0; step < 40; step++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model,
        max_tokens: 16000,
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools,
        messages,
      }),
    });
    if (!res.ok) {
      messages.pop();
      throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
    const data: any = await res.json();
    messages.push({ role: 'assistant', content: data.content });
    const toolUses = (data.content ?? []).filter((b: any) => b.type === 'tool_use');
    for (const b of data.content ?? []) if (b.type === 'text' && b.text.trim()) emit({ type: 'text', text: b.text });
    if (data.stop_reason !== 'tool_use' || !toolUses.length) return;
    const results: any[] = [];
    for (const tu of toolUses) {
      emit({ type: 'tool', id: tu.id, name: tu.name, status: 'start', input: tu.input });
      const r = await callTool(tu.name, tu.input, tctx, req.docId ?? null);
      emit({ type: 'tool', id: tu.id, name: tu.name, status: r.isError ? 'error' : 'end', summary: summarizeResult(r.content) });
      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        is_error: !!r.isError,
        content: r.content.map((c) => (c.type === 'image' ? { type: 'image', source: { type: 'base64', media_type: c.mimeType, data: c.data } } : c)),
      });
    }
    messages.push({ role: 'user', content: results });
  }
  emit({ type: 'log', text: 'Stopped after 40 steps.' });
}

// ---------------------------------------------------------------------------
// OpenAI Responses API
// ---------------------------------------------------------------------------

async function runOpenAI(runId: string, conv: Conversation, prompt: string, req: ChatRequest, ctx: { store: DocStore; hub: Hub }, emit: (e: AiEvent) => void) {
  const key = apiKey('openai');
  if (!key) throw new Error('No OpenAI API key. Add one in Settings (gear icon) or set OPENAI_API_KEY.');
  const model = req.model || loadSettings().openaiModel || 'gpt-5';
  const controller = new AbortController();
  runs.set(runId, { cancel: () => controller.abort() });
  const tools = toolJsonSchemas().map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.schema }));
  const tctx = toolCtx(ctx, 'GPT');
  let input: any[] = [{ role: 'user', content: prompt }];
  for (let step = 0; step < 40; step++) {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        instructions: SYSTEM_PROMPT,
        input,
        tools,
        ...(conv.openaiPrevId ? { previous_response_id: conv.openaiPrevId } : {}),
      }),
    });
    if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const data: any = await res.json();
    conv.openaiPrevId = data.id;
    const calls = (data.output ?? []).filter((o: any) => o.type === 'function_call');
    for (const o of data.output ?? []) {
      if (o.type === 'message') {
        const t = (o.content ?? []).filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join('\n');
        if (t.trim()) emit({ type: 'text', text: t });
      }
    }
    if (!calls.length) return;
    input = [];
    const images: string[] = [];
    for (const call of calls) {
      let args: any = {};
      try {
        args = JSON.parse(call.arguments || '{}');
      } catch {
        /* keep empty */
      }
      emit({ type: 'tool', id: call.call_id, name: call.name, status: 'start', input: args });
      const r = await callTool(call.name, args, tctx, req.docId ?? null);
      emit({ type: 'tool', id: call.call_id, name: call.name, status: r.isError ? 'error' : 'end', summary: summarizeResult(r.content) });
      const textOut = r.content.filter((c) => c.type === 'text').map((c: any) => c.text).join('\n');
      for (const c of r.content) if (c.type === 'image') images.push(`data:${c.mimeType};base64,${c.data}`);
      input.push({ type: 'function_call_output', call_id: call.call_id, output: (r.isError ? 'ERROR: ' : '') + (textOut || 'ok') + (images.length ? '\n[Screenshot attached in the next message]' : '') });
    }
    if (images.length) input.push({ role: 'user', content: images.map((u) => ({ type: 'input_image', image_url: u })) });
  }
  emit({ type: 'log', text: 'Stopped after 40 steps.' });
}
