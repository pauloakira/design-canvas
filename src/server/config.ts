import fs from 'node:fs';
import path from 'node:path';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq?.split('=').slice(1).join('=');
}

export const PORT = Number(arg('port') ?? process.env.DESIGN_CANVAS_PORT ?? 4410);
export const HOST = arg('host') ?? process.env.DESIGN_CANVAS_HOST ?? '127.0.0.1';
export const DATA_DIR = path.resolve(arg('dir') ?? process.env.DESIGN_CANVAS_DIR ?? path.join(process.cwd(), 'designs'));
/** Directory the AI agents (Claude Code / Codex) run in — usually your project. */
export const PROJECT_DIR = path.resolve(arg('project') ?? process.env.DESIGN_CANVAS_PROJECT ?? process.cwd());
export const ASSETS_DIR = path.join(DATA_DIR, 'assets');
export const SETTINGS_FILE = path.join(DATA_DIR, '.settings.json');
export const PUBLIC_URL = `http://localhost:${PORT}`;

fs.mkdirSync(ASSETS_DIR, { recursive: true });

export interface Settings {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  anthropicModel?: string;
  openaiModel?: string;
  claudeCodeModel?: string;
  codexModel?: string;
  /** Pairing code the Figma plugin must send. */
  figmaToken?: string;
}

export function loadSettings(): Settings {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function saveSettings(s: Settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

export function apiKey(provider: 'anthropic' | 'openai'): string | undefined {
  const s = loadSettings();
  if (provider === 'anthropic') return s.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  return s.openaiApiKey || process.env.OPENAI_API_KEY;
}
