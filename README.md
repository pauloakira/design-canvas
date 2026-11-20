# Design Canvas

A free, local-first, Figma-style design tool built for engineers — with first-class
**Claude Code**, **Codex**, **Claude** and **GPT** integration.

- **What you design is real CSS.** Frames with auto layout *are* flexbox; sizes are
  fixed / hug / fill; strokes, radii, shadows and blurs map 1:1 to CSS. The canvas
  renders with the same style function the code generator uses, so exported code
  looks exactly like the design.
- **Agents are first-class users.** A built-in MCP server (like Figma's Dev Mode MCP,
  but read **and write**) lets Claude Code, Codex, Cursor and others read your
  selection, generate code, take screenshots, import HTML, and design whole screens.
- **Design with AI inside the editor.** The AI tab drives the same tools through your
  local **Claude Code** or **Codex** CLI (your existing login, no API key), or directly
  through the **Claude API** / **OpenAI API**.
- **Files are plain JSON** in `./designs` — commit them next to your code.

## Quick start

```bash
npm install
npm run dev          # editor at http://localhost:5173, server + MCP at http://localhost:4410
```

Production-style (single port):

```bash
npm run build
npm start            # editor + API + MCP at http://localhost:4410
```

Options (flags or env vars): `--port` / `DESIGN_CANVAS_PORT` (default 4410),
`--dir` / `DESIGN_CANVAS_DIR` (where design files live, default `./designs`),
`--project` / `DESIGN_CANVAS_PROJECT` (folder the in-app agents may read, default cwd).

## Connect your coding agent

The server must be running. Then, once:

**Claude Code** (Streamable HTTP):

```bash
claude mcp add --transport http --scope user design-canvas http://localhost:4410/mcp
```

**Codex** (stdio bridge):

```bash
codex mcp add design-canvas -- node /absolute/path/to/design-canvas/bin/design-canvas-mcp.mjs
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.design-canvas]
command = "node"
args = ["/absolute/path/to/design-canvas/bin/design-canvas-mcp.mjs"]
```

**Other clients**: HTTP-capable clients (Cursor, VS Code, Windsurf) use
`{"type": "http", "url": "http://localhost:4410/mcp"}`; stdio-only clients (Claude Desktop)
use the bridge above. The editor's **Connect** button shows ready-to-copy commands with
your absolute paths, and which agents are connected.

Then, from your project:

> Implement my current Design Canvas selection as a React component using our Tailwind theme.

> Recreate `src/app/settings/page.tsx` in Design Canvas so I can iterate on the design.

> Design a 3-screen onboarding flow in Design Canvas, then implement it.

### MCP tools

| Read | Write |
| --- | --- |
| `list_documents`, `get_document` (layer outline, tokens, components) | `create_nodes` (whole nested screens in one call) |
| `get_selection` (what the user has selected right now) | `update_nodes`, `delete_nodes`, `move_nodes`, `duplicate_nodes`, `wrap_nodes` |
| `find_nodes`, `get_node` (full JSON) | `set_variables` (design tokens → CSS variables) |
| `get_design_context` (React+Tailwind / HTML / React code + tokens, fonts, assets, mapped components) | `create_component` (+ Code Connect), `create_instance` |
| `get_screenshot` (PNG rendered by the open editor) | `import_html` (HTML / Tailwind → editable auto-layout layers) |
| `get_variables` | `create_document`, `create_page`, `select_nodes` (reveal in the editor) |

The server also sends a design guide as MCP `instructions`, so agents know the model.

## In-app AI

Open the **AI** tab and pick a provider:

| Provider | How it runs | Needs |
| --- | --- | --- |
| Claude Code | `claude -p` with this server as its only MCP server | `claude` CLI, logged in |
| Codex | `codex exec` with the stdio bridge | `codex` CLI, logged in |
| Claude | Anthropic Messages API tool loop | API key (Settings or `ANTHROPIC_API_KEY`) |
| GPT | OpenAI Responses API tool loop | API key (Settings or `OPENAI_API_KEY`) |

The current selection is passed as context. CLI agents can optionally read (not write)
files in the project folder, e.g. to match your existing UI. API keys are stored only in
`designs/.settings.json` on your machine.

## Editor features

- Infinite canvas: pan (space-drag / wheel), zoom (⌘-wheel / pinch, ⇧1 fit, ⇧2 selection)
- Frames, rectangles, ellipses, text, images (upload / paste / drop), SVG icons (paste markup)
- Figma-like selection depth, marquee, ⌘-click deep select, ⌥-drag duplicate, smart guides & snapping, ⌥-hover distance measurement
- Auto layout (direction, gap, padding, alignment grid, space-between, wrap, hug/fill sizing, absolute children, drag to reorder)
- Fills (solid, linear/radial gradient, image), strokes, corner radii, drop/inner shadows, layer & background blur, opacity
- Typography with Google Fonts
- Components & instances with text/visibility overrides, detach, and **Code Connect** (map to `@/components/ui/button`)
- Design tokens (`$primary`, `$space-4`) usable in any field, exported as CSS variables
- Pages, layers panel with drag-and-drop, rename, hide, lock
- Undo/redo, copy/paste (across tabs and documents), context menu, keyboard shortcuts (⌘/)
- Dev mode: React + Tailwind, HTML + CSS and React (inline styles) code; CSS inspect; one-click "hand off to your agent" prompts
- Real-time sync between tabs and agents (agent edits are highlighted live)
- Export PNG, copy as PNG / code, import/export document JSON

## Architecture

```
src/shared   document model, patches, LLM-friendly normalization, style → CSS, codegen, ops
src/server   Express + WebSocket hub (sync, presence), document store (JSON files),
             tool registry → MCP (Streamable HTTP at /mcp), AI runners (CLI + API)
src/web      React editor (zustand store, DOM canvas, panels)
bin/         design-canvas-mcp.mjs — stdio ⇄ HTTP MCP bridge
```

- The canvas renders every layer as DOM using `nodeStyle()`; the code generator uses the
  same function. Measured geometry of hug/fill layers is written back so agents see real sizes.
- Edits are whole-node patches. Clients apply them optimistically and rebase on the
  server's order; the server repairs structural conflicts. MCP edits flow through the same
  pipeline, so agents and humans collaborate live.
- Screenshots and HTML import need a real browser, so the server asks the open editor
  to render them.

## Security

The server binds to `127.0.0.1`, rejects non-localhost `Host` headers (DNS rebinding) and
cross-site `Origin`s, because it can edit files and start local agents. Don't expose it to
a network.

## Scripts

```bash
npm test             # shared-core unit tests
npm run typecheck
node scripts/mcp-smoke.mjs [--stdio]   # end-to-end MCP check against a running server
```

## License

MIT
