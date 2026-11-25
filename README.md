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
- **Files are plain JSON** in `./designs` — commit them next to your code. Folders in the
  app are real subdirectories, so `designs/Mobile app/Onboarding/` looks the same in git.

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

### Install it as an app

Design Canvas is an installable web app, so it can run in its own window with a Dock icon instead of a browser tab.

1. Open http://localhost:4410 in Chrome (or Edge, Brave or Arc).
2. Click the install icon at the right end of the address bar, or open the ⋮ menu and choose **Cast, save, and share → Install page as app…**
3. Launch **Design Canvas** from the Dock, Launchpad or Spotlight. Designs and folders open inside the app window.

The app window is only a view onto the local server. The server, and the MCP endpoint your agents use, keep running when the window is closed. Nothing is cached offline, so the server must be running for the app to open. Safari works too: **File → Add to Dock**.

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

> Address the open comments in Design Canvas and resolve them.

### MCP tools

| Read | Write |
| --- | --- |
| `list_documents` (with folders), `get_document` (layer outline, tokens, components) | `create_nodes` (whole nested screens in one call) |
| `get_selection` (what the user has selected right now) | `update_nodes`, `delete_nodes`, `move_nodes`, `duplicate_nodes`, `wrap_nodes` |
| `find_nodes`, `get_node` (full JSON) | `set_variables` (design tokens → CSS variables) |
| `get_design_context` (React+Tailwind / HTML / React code + tokens, fonts, assets, mapped components) | `create_component` (+ Code Connect), `create_instance` |
| `get_screenshot` (PNG rendered by the open editor) | `import_html` (HTML / Tailwind → editable auto-layout layers) |
| `get_variables` | `create_document` (optionally in a folder), `update_document` (rename / move to folder), `create_page`, `select_nodes` (reveal in the editor) |
| `get_comments` (review threads, pinned layers, resolved state) | `add_comment` (new thread or reply), `resolve_comment` |
| | `send_to_figma` (real Figma layers, components and variables via the plugin) |

The server also sends a design guide as MCP `instructions`, so agents know the model.

## Figma ⇄ Design Canvas

### Send to Figma

Designs can be pushed to Figma as **real Figma layers**, not pictures:

| Design Canvas | Figma |
| --- | --- |
| Frame with auto layout (gap, padding, justify/align, wrap) | Auto-layout frame |
| Fixed / hug / fill (incl. `align: stretch`) | Fixed / Hug / Fill container |
| Component (+ Code Connect) | Main component (description: `Code: <Button /> from '@/components/ui/button'`) |
| Instance + overrides | Instance linked to that main component, with the same overrides |
| Tokens (`$primary`, `$space-4`) | Variables bound to fills, strokes, gap, padding, radii, font size (code syntax `var(--primary)`) |
| Fills, gradients, images, strokes, radii, shadows, blurs, opacity, blend modes, SVG | Same, with CSS geometry converted exactly (e.g. gradient angles) |

**Parity through components:** every Figma layer remembers which Design Canvas layer it came from.
Sending again **updates the same layers in place**: main components keep their identity, so
every instance in the Figma file follows a component change, like on the canvas. Removed
layers are removed; layers added in Figma by hand are kept; frames you moved in Figma stay put.

Setup (once): in the Figma **desktop app**, Plugins → Development → **Import plugin from
manifest…** → `figma-plugin/manifest.json`. Run it, and paste the pairing code from
**Connect → Figma** in the editor (the code keeps other web pages from reading your designs).

Then select frames and press **⌥⇧F** (or right-click → **Send to Figma**); with nothing selected
the whole page is sent. The plugin can also import any design/page itself, and **Update all**
refreshes everything previously sent to that file. Agents can use the `send_to_figma` MCP tool.

Known differences: fonts must exist in Figma (Google Fonts do; others fall back to Inter with a
note); text strokes and column wrap have no Figma equivalent; rendering of the same font can
differ by a pixel or two between the browser and Figma, which hug layouts absorb. The plugin
lists every approximation after each import.

### Copy from Figma

The same plugin copies the other way: select layers in Figma, pick **New design** or an
existing design in the plugin's **Copy to Design Canvas** section, and press **Copy**.

- Auto layout → flexbox frames (gap, padding, alignment, wrap, hug/fill), groups and sections → frames
- Main components → components (with their Code Connect mapping when they came from here), instances →
  linked instances with text / visibility / fill overrides; components that live elsewhere in the
  file (or in a library) come along
- Bound variables → `$tokens` (named from the variable's `var(--…)` code syntax, or its name)
- Vectors, boolean shapes and small icon frames → SVG; image fills → uploaded assets
- Mixed text styles, per-side strokes, angular gradients, grid layout and similar are approximated,
  and each approximation is listed in the plugin

Layers keep their identity both ways: copying a frame that came from Design Canvas back into its
design **updates those layers in place** (layers deleted in Figma are deleted, new ones are added),
and layers that started in Figma are tagged on import, so the next copy or send updates them too.

### Plugin source

The plugin source is in `figma-plugin/src` (`engine.js` applies an export, `main.js` is the
plugin entry); `npm run build:figma` regenerates `figma-plugin/code.js`. The mapping itself lives
in `src/shared/figma.ts` (export) and `src/shared/figma-import.ts` (import), and
`figma-plugin/test` runs the plugin against a fake Figma API: re-sending updates in place, and a
canvas → Figma → canvas round trip yields the same design.

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
- Folders on the home screen: nest them, drag designs and folders between them (or onto the breadcrumb), rename, search; deleting a folder keeps its designs
- Pages, layers panel with drag-and-drop, rename, hide, lock
- Undo/redo, copy/paste (across tabs and documents), context menu, keyboard shortcuts (⌘/)
- Dev mode: React + Tailwind, HTML + CSS and React (inline styles) code; CSS inspect; one-click "hand off to your agent" prompts
- Comments like Figma: press **C** and click to pin a thread to any layer (it follows the layer), reply, resolve, filter in the Comments panel; agents can read, reply to and resolve them over MCP
- Real-time sync between tabs and agents (agent edits are highlighted live)
- Export PNG, copy as PNG / code, import/export document JSON, **send to Figma** (components, instances and variables preserved)

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
npm test             # shared core, document store, Figma export + plugin engine tests
npm run build:figma  # rebuild figma-plugin/code.js from figma-plugin/src
npm run typecheck
node scripts/mcp-smoke.mjs [--stdio]   # end-to-end MCP check against a running server
```

## License

MIT
