/**
 * The tool registry. Exposed over MCP (Claude Code, Codex, Cursor, …) and
 * used directly by the in-app Claude / OpenAI agents.
 */
import { z } from 'zod';
import type { DesignDoc, SceneNode } from '../shared/types.ts';
import { descendants, findNodes, isFrameLike, isPageId, pageOf } from '../shared/doc.ts';
import {
  absolutePosition,
  addPage,
  createComponent,
  createInstance,
  createNodes,
  deleteNodes,
  deleteVariable,
  duplicateNodes,
  moveNodes,
  resolveComponentId,
  updateNode,
  upsertVariable,
  wrapInFrame,
} from '../shared/ops.ts';
import { generateCode, type Framework } from '../shared/codegen.ts';
import { nodeSummary, nodeTree, outline, pageOutline } from '../shared/outline.ts';
import { variablesToCss } from '../shared/style.ts';
import { normalizeProps, type NodeSpec } from '../shared/normalize.ts';
import { instanceLayers } from '../shared/tree.ts';
import { addThread, replyToThread, setResolved, threadPagePosition, threadsForNode } from '../shared/comments.ts';
import type { CommentThread } from '../shared/types.ts';
import type { DocStore } from './store.ts';
import { normalizeFolder } from './store.ts';
import type { Hub } from './hub.ts';
import { PUBLIC_URL } from './config.ts';

export interface ToolContext {
  store: DocStore;
  hub: Hub;
  /** Display name of the agent calling the tool, e.g. "Claude Code". */
  agent: string;
}

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  shape: z.ZodRawShape;
  readOnly?: boolean;
  destructive?: boolean;
  handler: (args: any, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
}

const docIdArg = z.string().optional().describe('Document id. Defaults to the document open in the editor.');

function text(t: string): ToolResult {
  return { content: [{ type: 'text', text: t }] };
}

function json(v: unknown): ToolResult {
  return text(JSON.stringify(v, null, 1));
}

export function resolveDocId(ctx: ToolContext, requested?: string, createIfNone = false): string {
  if (requested) {
    if (!ctx.store.exists(requested)) throw new Error(`Document "${requested}" not found. Use list_documents.`);
    return requested;
  }
  const sel = ctx.hub.selection();
  if (sel && ctx.store.exists(sel.docId)) return sel.docId;
  if (ctx.store.lastActiveDocId && ctx.store.exists(ctx.store.lastActiveDocId)) return ctx.store.lastActiveDocId;
  const docs = ctx.store.list();
  if (docs.length === 1) return docs[0].id;
  if (docs.length === 0) {
    if (createIfNone) return ctx.store.create('Untitled').id;
    throw new Error('No documents yet. Call create_document first.');
  }
  return docs[0].id;
}

function currentPage(ctx: ToolContext, doc: DesignDoc): string {
  const sel = ctx.hub.selection(doc.id);
  if (sel?.pageId && doc.pages[sel.pageId]) return sel.pageId;
  return doc.pageOrder[0];
}

function origin(ctx: ToolContext, tool: string) {
  return { kind: 'agent' as const, name: ctx.agent, tool };
}

function requireNode(doc: DesignDoc, id: string): SceneNode {
  const n = doc.nodes[id];
  if (!n) throw new Error(`Node "${id}" not found. Use get_document or find_nodes to look up ids.`);
  return n;
}


function formatThread(doc: DesignDoc, t: CommentThread): string {
  const n = t.nodeId ? doc.nodes[t.nodeId] : undefined;
  const where = n ? `on ${n.type} "${n.name}" #${n.id} (at ${t.x},${t.y} inside it)` : `on page at ${t.pageX},${t.pageY}${t.nodeId ? ' (its layer was deleted)' : ''}`;
  const page = doc.pages[t.pageId]?.name ?? t.pageId;
  const head = `#${t.number} [${t.resolved ? 'resolved' : 'open'}] thread ${t.id} ${where}, page "${page}"`;
  const msgs = t.messages.map((m) => `    ${m.author}${m.authorKind === 'agent' ? ' (agent)' : ''}: ${m.text}`);
  return [head, ...msgs].join('\n');
}

const nodesDescription = `Array of node specs. Each spec: {type, name, ...props, children?: [...]}. type: "frame" | "text" | "rect" | "ellipse" | "image" | "svg" | "component" | "instance" (with componentId).
Props: x, y, width, height (number | "fill" | "hug"), widthMode/heightMode, fill / fills, stroke, radius, shadows, opacity, layout {mode:"row"|"column", gap, padding, justify, align, wrap} (or flat direction/gap/padding/justify/align), clip, position:"absolute".
Text: text, fontFamily, fontSize, fontWeight, lineHeight, letterSpacing, textAlign, color. Image: src, fit. SVG: svg markup. Values may reference tokens like "$primary".
Example: [{"type":"frame","name":"Card","width":360,"layout":{"mode":"column","gap":12,"padding":24},"fill":"#FFFFFF","radius":16,"stroke":"1px solid #E5E7EB","children":[{"type":"text","text":"Pro plan","fontSize":20,"fontWeight":600,"color":"#111827"},{"type":"text","text":"Everything you need to ship faster.","width":"fill","color":"#6B7280"}]}]`;

export const TOOLS: ToolDef[] = [
  {
    name: 'list_documents',
    title: 'List documents',
    description:
      'List all design documents (files) with ids, names, folders and sizes, plus all folders. Also shows which document is open in the editor. Pass folder to list only one folder (and its subfolders).',
    shape: { folder: z.string().optional().describe('Only list documents in this folder path (e.g. "Marketing/Landing") and below') },
    readOnly: true,
    handler: (a, ctx) => {
      const sel = ctx.hub.selection();
      const scope = a.folder ? normalizeFolder(a.folder) : '';
      const inScope = (f: string) => !scope || f === scope || f.startsWith(scope + '/');
      return json({
        openInEditor: sel?.docId ?? null,
        folders: ctx.store.folders().filter(inScope),
        documents: ctx.store
          .list()
          .filter((d) => inScope(d.folder))
          .map((d) => ({ id: d.id, name: d.name, folder: d.folder || '(root)', pages: d.pages, nodes: d.nodes, updatedAt: new Date(d.updatedAt).toISOString() })),
        editorUrl: PUBLIC_URL,
      });
    },
  },
  {
    name: 'create_document',
    title: 'Create document',
    description: 'Create a new design document and return its id. Optionally put it in a folder (created if missing). The user can open it at the returned URL.',
    shape: {
      name: z.string().describe('Document name'),
      folder: z.string().optional().describe('Folder path, e.g. "Mobile app" or "Marketing/Landing". Defaults to the root.'),
    },
    handler: (a, ctx) => {
      const doc = ctx.store.create(a.name, undefined, a.folder);
      ctx.hub.broadcast(null, { t: 'docs-changed' });
      return json({ id: doc.id, name: doc.name, folder: ctx.store.folderOfDoc(doc.id) || '(root)', pageId: doc.pageOrder[0], url: `${PUBLIC_URL}/d/${doc.id}` });
    },
  },
  {
    name: 'update_document',
    title: 'Rename / move document',
    description: 'Rename a design document and/or move it to another folder ("" = root; missing folders are created).',
    shape: {
      documentId: z.string().describe('Document id'),
      name: z.string().optional().describe('New name'),
      folder: z.string().optional().describe('Destination folder path; "" for the root'),
    },
    handler: (a, ctx) => {
      if (!ctx.store.exists(a.documentId)) throw new Error(`Document "${a.documentId}" not found. Use list_documents.`);
      if (a.name?.trim()) ctx.store.applyPatch(a.documentId, { name: a.name.trim().slice(0, 120) }, origin(ctx, 'update_document'));
      if (a.folder !== undefined) ctx.store.moveDoc(a.documentId, a.folder);
      ctx.hub.broadcast(null, { t: 'docs-changed' });
      return json({ id: a.documentId, name: ctx.store.getDoc(a.documentId).name, folder: ctx.store.folderOfDoc(a.documentId) || '(root)' });
    },
  },
  {
    name: 'get_document',
    title: 'Get document outline',
    description:
      'Get a document overview: pages, design tokens, components and a compact layer outline of a page (ids, types, names, sizes, layout, text). Use this first to understand an existing design.',
    shape: {
      documentId: docIdArg,
      pageId: z.string().optional().describe('Page id (defaults to the page open in the editor)'),
      depth: z.number().int().min(1).max(20).optional().describe('Outline depth (default 4)'),
    },
    readOnly: true,
    handler: (a, ctx) => {
      const docId = resolveDocId(ctx, a.documentId);
      const doc = ctx.store.getDoc(docId);
      const pageId = a.pageId && doc.pages[a.pageId] ? a.pageId : currentPage(ctx, doc);
      const comps = Object.values(doc.nodes).filter((n) => n.type === 'component');
      const parts = [
        `Document "${doc.name}" #${doc.id}`,
        `Pages: ${doc.pageOrder.map((p) => `"${doc.pages[p].name}" #${p}${p === pageId ? ' (shown)' : ''}`).join(', ')}`,
        Object.keys(doc.variables).length
          ? `Tokens: ${Object.values(doc.variables)
              .map((v) => `$${v.name}=${v.value}`)
              .join(', ')}`
          : 'Tokens: none',
        comps.length ? `Components: ${comps.map((c) => `"${c.name}" #${c.id}`).join(', ')}` : 'Components: none',
        '',
        pageOutline(doc, pageId, a.depth ?? 4),
      ];
      return text(parts.join('\n'));
    },
  },
  {
    name: 'get_selection',
    title: 'Get selection',
    description:
      'Get the layers the user currently has selected in the Design Canvas editor, with a layer outline. Use this when the user says "this", "my selection", "the selected frame", etc.',
    shape: { documentId: docIdArg },
    readOnly: true,
    handler: (a, ctx) => {
      const docId = resolveDocId(ctx, a.documentId);
      const sel = ctx.hub.selection(docId);
      const doc = ctx.store.getDoc(docId);
      if (!sel) return text(`No editor is open for document "${doc.name}" #${doc.id}. Ask the user to open ${PUBLIC_URL}/d/${doc.id}.`);
      const ids = sel.ids.filter((id) => doc.nodes[id]);
      if (!ids.length) return text(`Document "${doc.name}" #${doc.id}, page #${sel.pageId}: nothing selected.\n\n${pageOutline(doc, sel.pageId ?? doc.pageOrder[0], 2)}`);
      const threads = ids.flatMap((id) => threadsForNode(doc, id));
      const note = threads.length ? `\n\n${threads.length} open comment(s) on the selection — see get_comments.` : '';
      return text(`Document "${doc.name}" #${doc.id}. Selected ${ids.length} layer(s):\n${outline(doc, ids, 6)}${note}`);
    },
  },
  {
    name: 'find_nodes',
    title: 'Find nodes',
    description: 'Search layers by name or text content (case-insensitive substring) and/or type.',
    shape: {
      documentId: docIdArg,
      query: z.string().optional().describe('Substring of layer name or text'),
      type: z.string().optional().describe('Node type filter, e.g. "component", "text", "frame"'),
      pageId: z.string().optional(),
    },
    readOnly: true,
    handler: (a, ctx) => {
      const doc = ctx.store.getDoc(resolveDocId(ctx, a.documentId));
      const q = (a.query ?? '').toLowerCase();
      const res = findNodes(doc, (n) => {
        if (a.type && n.type !== a.type) return false;
        if (a.pageId && pageOf(doc, n.id) !== a.pageId) return false;
        if (!q) return true;
        return n.name.toLowerCase().includes(q) || (n.type === 'text' && (n as any).text.toLowerCase().includes(q));
      }).slice(0, 100);
      return text(res.length ? res.map((n) => '- ' + nodeSummary(doc, n)).join('\n') : 'No matches.');
    },
  },
  {
    name: 'get_node',
    title: 'Get node JSON',
    description: 'Get the full JSON of nodes (all properties) including their subtree. Use before precise edits.',
    shape: {
      documentId: docIdArg,
      ids: z.array(z.string()).min(1).describe('Node ids'),
      depth: z.number().int().min(0).max(50).optional().describe('Subtree depth (default 10)'),
    },
    readOnly: true,
    handler: (a, ctx) => {
      const doc = ctx.store.getDoc(resolveDocId(ctx, a.documentId));
      const out = a.ids.map((id: string) => {
        const n = requireNode(doc, id);
        const t = nodeTree(doc, id, a.depth ?? 10);
        if (n.type === 'instance') {
          t.overridableLayers = instanceLayers(doc, n as any).map((l) => ({ key: l.key, type: l.node.type, name: l.node.name, ...(l.node.type === 'text' ? { text: (l.node as any).text } : {}) }));
        }
        return t;
      });
      return json(out.length === 1 ? out[0] : out);
    },
  },
  {
    name: 'get_design_context',
    title: 'Get design context (code)',
    description:
      'Generate implementation reference code for a node (default: current selection) — React + Tailwind by default, or HTML/CSS, or React with inline styles — plus the design tokens, fonts, image assets and mapped components it uses. Use this to implement a design in the codebase.',
    shape: {
      documentId: docIdArg,
      nodeId: z.string().optional().describe('Node id (defaults to the first selected node)'),
      framework: z.enum(['react-tailwind', 'html', 'react-css']).optional().describe('Output flavor (default react-tailwind)'),
    },
    readOnly: true,
    handler: (a, ctx) => {
      const docId = resolveDocId(ctx, a.documentId);
      const doc = ctx.store.getDoc(docId);
      let nodeId = a.nodeId;
      if (!nodeId) {
        nodeId = ctx.hub.selection(docId)?.ids.find((i) => doc.nodes[i]);
        if (!nodeId) throw new Error('No nodeId given and nothing is selected in the editor. Pass nodeId (see get_document).');
      }
      const n = requireNode(doc, nodeId);
      const res = generateCode(doc, nodeId, { framework: (a.framework ?? 'react-tailwind') as Framework, annotate: true, assetBase: PUBLIC_URL });
      const parts = [
        `Design context for ${n.type} "${n.name}" #${n.id} (${Math.round(n.width)}×${Math.round(n.height)})`,
        n.description ? `Designer notes: ${n.description}` : '',
        '',
        '```' + (a.framework === 'html' ? 'html' : 'tsx'),
        res.code.trimEnd(),
        '```',
      ];
      if (res.tokensCss) parts.push('', 'Design tokens used (CSS variables):', '```css', res.tokensCss, '```');
      if (res.fonts.length) parts.push('', `Fonts: ${res.fonts.join(', ')}`);
      if (res.assets.length) parts.push('', 'Image assets (download into the project if needed):', ...res.assets.map((u) => `- ${u}`));
      if (res.components.length)
        parts.push(
          '',
          'Components used:',
          ...res.components.map((c) => `- "${c.name}" #${c.id}${c.codeConnect ? ` → <${c.codeConnect.name}> from ${c.codeConnect.importPath ?? '(no import path)'}` : ' (no code mapping; implement or map to an existing component)'}`),
        );
      const threads = threadsForNode(doc, nodeId);
      if (threads.length) parts.push('', `Open review comments on this design (${threads.length}):`, ...threads.map((t) => formatThread(doc, t)));
      parts.push(
        '',
        'Notes: generated with the same styles the canvas uses. Adapt it to the project: reuse existing components and theme tokens, keep the layout (flex) structure, and use get_screenshot to compare visually.',
      );
      return text(parts.filter((p) => p !== undefined).join('\n'));
    },
  },
  {
    name: 'get_screenshot',
    title: 'Get screenshot',
    description: 'Render a PNG screenshot of a node (default: selection, or the whole page) as it appears on the canvas. Requires the editor to be open.',
    shape: {
      documentId: docIdArg,
      nodeId: z.string().optional().describe('Node id. Omit for the selection / current page.'),
      scale: z.number().min(0.1).max(3).optional().describe('Pixel ratio (default: fit within ~1600px)'),
    },
    readOnly: true,
    handler: async (a, ctx) => {
      const docId = resolveDocId(ctx, a.documentId);
      const doc = ctx.store.getDoc(docId);
      if (a.nodeId) requireNode(doc, a.nodeId);
      const sel = ctx.hub.selection(docId);
      const nodeId = a.nodeId ?? sel?.ids.find((i) => doc.nodes[i]);
      const pageId = nodeId ? pageOf(doc, nodeId) : currentPage(ctx, doc);
      const res = await ctx.hub.request<{ dataUrl: string; width: number; height: number }>(docId, 'screenshot', { nodeId, pageId, scale: a.scale });
      const data = res.dataUrl.replace(/^data:image\/png;base64,/, '');
      return {
        content: [
          { type: 'image', data, mimeType: 'image/png' },
          { type: 'text', text: `Screenshot of ${nodeId ? `"${doc.nodes[nodeId].name}" #${nodeId}` : 'page'} (${res.width}×${res.height}px)` },
        ],
      };
    },
  },
  {
    name: 'get_variables',
    title: 'Get design tokens',
    description: 'List design tokens (variables) with values, plus the equivalent CSS custom properties.',
    shape: { documentId: docIdArg },
    readOnly: true,
    handler: (a, ctx) => {
      const doc = ctx.store.getDoc(resolveDocId(ctx, a.documentId));
      const vars = Object.values(doc.variables);
      if (!vars.length) return text('No design tokens defined. Create some with set_variables.');
      return text(
        vars.map((v) => `- $${v.name} (${v.type}) = ${v.value}${v.group ? ` [${v.group}]` : ''}${v.description ? ` — ${v.description}` : ''}`).join('\n') +
          '\n\n```css\n' +
          variablesToCss(doc.variables) +
          '\n```',
      );
    },
  },
  {
    name: 'create_nodes',
    title: 'Create nodes',
    description:
      'Create one or more layers (with nested children) on a page or inside a frame. Build whole screens in one call. Returns the created ids. Top-level frames without x/y are placed to the right of existing content.',
    shape: {
      documentId: docIdArg,
      parentId: z.string().optional().describe('Parent frame/component id or page id. Defaults to the current page.'),
      index: z.number().int().optional().describe('Insert position among siblings (default: on top / at the end)'),
      nodes: z.array(z.record(z.string(), z.any())).min(1).describe(nodesDescription),
    },
    handler: (a, ctx) => {
      const docId = resolveDocId(ctx, a.documentId, true);
      const doc = ctx.store.getDoc(docId);
      const parentId = a.parentId ?? currentPage(ctx, doc);
      if (!isPageId(doc, parentId)) {
        const p = requireNode(doc, parentId);
        if (!isFrameLike(p)) throw new Error(`Parent "${p.name}" is a ${p.type}; only frames, components and pages can have children.`);
      }
      const { result } = ctx.store.mutate(docId, origin(ctx, 'create_nodes'), (d) =>
        createNodes(d, a.nodes as NodeSpec[], parentId, a.index, { autoPlace: true }),
      );
      ctx.hub.agentActivity(docId, { name: ctx.agent, tool: 'create_nodes', status: 'end', message: `created ${result.created.length} layers` });
      ctx.hub.broadcast(docId, { t: 'reveal', ids: result.ids, agent: ctx.agent });
      const after = ctx.store.getDoc(docId);
      const lines = [`Created ${result.created.length} layer(s) in ${isPageId(after, parentId) ? 'page' : `"${after.nodes[parentId]?.name}"`} #${parentId}:`, outline(after, result.ids, 8, 200)];
      if (result.warnings.length) lines.push('', 'Warnings:', ...result.warnings.map((w) => '- ' + w));
      return text(lines.join('\n'));
    },
  },
  {
    name: 'update_nodes',
    title: 'Update nodes',
    description:
      'Update properties of existing layers. Each update is {id, ...props} using the same props as create_nodes (partial; layout merges with the existing layout). Set a prop to null to remove it. For instances, pass overrides: {"<componentChildId>": {text, visible, fills}}.',
    shape: {
      documentId: docIdArg,
      updates: z.array(z.record(z.string(), z.any())).min(1).describe('Array of {id, ...props}'),
    },
    handler: (a, ctx) => {
      const docId = resolveDocId(ctx, a.documentId);
      const warnings: string[] = [];
      const { result } = ctx.store.mutate(docId, origin(ctx, 'update_nodes'), (d) => {
        const ids: string[] = [];
        for (const u of a.updates as any[]) {
          const { id, overrides, ...props } = u;
          if (!id || !d.nodes[id]) {
            warnings.push(`Node "${id}" not found`);
            continue;
          }
          if (overrides && d.nodes[id].type === 'instance') {
            const inst: any = d.nodes[id];
            inst.overrides = { ...(inst.overrides ?? {}) };
            for (const [k, v] of Object.entries(overrides as Record<string, any>)) {
              if (v === null) delete inst.overrides[k];
              else inst.overrides[k] = { ...(inst.overrides[k] ?? {}), ...normalizeOverride(v) };
            }
          } else if (overrides === null && d.nodes[id].type === 'instance') delete (d.nodes[id] as any).overrides;
          const nullKeys = Object.keys(props).filter((k) => props[k] === null);
          updateNode(d, id, props, warnings);
          // Explicit null removals of canonical props.
          for (const k of nullKeys) if (!['id', 'type', 'parentId', 'children', 'name'].includes(k)) delete (d.nodes[id] as any)[k];
          ids.push(id);
        }
        return ids;
      });
      const after = ctx.store.getDoc(docId);
      ctx.hub.agentActivity(docId, { name: ctx.agent, tool: 'update_nodes', status: 'end', message: `updated ${result.length} layers` });
      const lines = [`Updated ${result.length} layer(s):`, ...result.map((id: string) => '- ' + nodeSummary(after, after.nodes[id]))];
      if (warnings.length) lines.push('', 'Warnings:', ...warnings.map((w) => '- ' + w));
      return text(lines.join('\n'));
    },
  },
  {
    name: 'delete_nodes',
    title: 'Delete nodes',
    description: 'Delete layers (and their children).',
    shape: { documentId: docIdArg, ids: z.array(z.string()).min(1) },
    destructive: true,
    handler: (a, ctx) => {
      const docId = resolveDocId(ctx, a.documentId);
      const doc = ctx.store.getDoc(docId);
      const existing = (a.ids as string[]).filter((i) => doc.nodes[i]);
      const count = existing.reduce((s, i) => s + descendants(doc, i, true).length, 0);
      ctx.store.mutate(docId, origin(ctx, 'delete_nodes'), (d) => deleteNodes(d, existing));
      return text(`Deleted ${existing.length} layer(s) (${count} including children).`);
    },
  },
  {
    name: 'move_nodes',
    title: 'Move / reparent nodes',
    description: 'Move layers into another parent (frame, component or page) and/or reorder them. Optionally set x/y in the new parent.',
    shape: {
      documentId: docIdArg,
      ids: z.array(z.string()).min(1),
      parentId: z.string().describe('New parent id (frame/component/page)'),
      index: z.number().int().optional().describe('Position among siblings (0 = first/bottom-most)'),
      x: z.number().optional(),
      y: z.number().optional(),
    },
    handler: (a, ctx) => {
      const docId = resolveDocId(ctx, a.documentId);
      ctx.store.mutate(docId, origin(ctx, 'move_nodes'), (d) => moveNodes(d, a.ids, a.parentId, a.index, { x: a.x, y: a.y }));
      return text(`Moved ${a.ids.length} layer(s) into #${a.parentId}.`);
    },
  },
  {
    name: 'duplicate_nodes',
    title: 'Duplicate nodes',
    description: 'Duplicate layers (deep copy). Returns new ids.',
    shape: { documentId: docIdArg, ids: z.array(z.string()).min(1), offsetX: z.number().optional(), offsetY: z.number().optional() },
    handler: (a, ctx) => {
      const docId = resolveDocId(ctx, a.documentId);
      const { result } = ctx.store.mutate(docId, origin(ctx, 'duplicate_nodes'), (d) => duplicateNodes(d, a.ids, { x: a.offsetX ?? 40, y: a.offsetY ?? 0 }));
      const after = ctx.store.getDoc(docId);
      return text(`Duplicated:\n${outline(after, result, 1)}`);
    },
  },
  {
    name: 'wrap_nodes',
    title: 'Wrap nodes in a frame',
    description: 'Wrap sibling layers in a new frame (like Figma "Frame selection"), optionally with auto layout.',
    shape: {
      documentId: docIdArg,
      ids: z.array(z.string()).min(1),
      name: z.string().optional(),
      layout: z.record(z.string(), z.any()).optional().describe('Optional auto layout, e.g. {"mode":"row","gap":8}'),
    },
    handler: (a, ctx) => {
      const docId = resolveDocId(ctx, a.documentId);
      const { result } = ctx.store.mutate(docId, origin(ctx, 'wrap_nodes'), (d) => {
        const layout = a.layout ? (normalizeProps({ type: 'frame', layout: a.layout }).layout as any) : undefined;
        return wrapInFrame(d, a.ids, { name: a.name ?? 'Group', layout });
      });
      return text(result ? `Wrapped into frame #${result}.` : 'Nothing to wrap.');
    },
  },
  {
    name: 'set_variables',
    title: 'Set design tokens',
    description:
      'Create or update design tokens (variables), and/or delete some. Names must be CSS-identifier-like (e.g. "primary", "gray-100", "space-4", "radius-md"). Reference them in node props as "$name".',
    shape: {
      documentId: docIdArg,
      variables: z
        .array(
          z.object({
            name: z.string(),
            value: z.union([z.string(), z.number()]),
            type: z.enum(['color', 'number', 'string']).optional(),
            group: z.string().optional(),
            description: z.string().optional(),
          }),
        )
        .optional(),
      delete: z.array(z.string()).optional().describe('Token names to delete'),
    },
    handler: (a, ctx) => {
      const docId = resolveDocId(ctx, a.documentId, true);
      const { result } = ctx.store.mutate(docId, origin(ctx, 'set_variables'), (d) => {
        for (const n of a.delete ?? []) deleteVariable(d, n);
        return (a.variables ?? []).map((v: any) => upsertVariable(d, v));
      });
      return text(`Tokens updated: ${result.map((v: any) => `$${v.name}=${v.value}`).join(', ') || 'none'}${a.delete?.length ? `; deleted ${a.delete.join(', ')}` : ''}`);
    },
  },
  {
    name: 'create_component',
    title: 'Create component',
    description: 'Turn a frame into a reusable component (main component). Optionally map it to a code component (codeConnect).',
    shape: {
      documentId: docIdArg,
      nodeId: z.string(),
      codeConnect: z
        .object({ name: z.string(), importPath: z.string().optional(), notes: z.string().optional() })
        .optional()
        .describe('Map to a component in the codebase, e.g. {"name":"Button","importPath":"@/components/ui/button"}'),
    },
    handler: (a, ctx) => {
      const docId = resolveDocId(ctx, a.documentId);
      const { result } = ctx.store.mutate(docId, origin(ctx, 'create_component'), (d) => {
        const id = createComponent(d, a.nodeId);
        if (a.codeConnect) (d.nodes[id] as any).codeConnect = a.codeConnect;
        return id;
      });
      return text(`Component #${result} ready. Place copies with create_instance {componentId:"${result}"}.`);
    },
  },
  {
    name: 'create_instance',
    title: 'Create component instance',
    description: 'Place an instance of a component (by id or name). Optionally set position and text overrides.',
    shape: {
      documentId: docIdArg,
      componentId: z.string().describe('Component id or name'),
      parentId: z.string().optional(),
      index: z.number().int().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      overrides: z.record(z.string(), z.any()).optional().describe('{"<componentChildId>": {"text": "…"}}'),
    },
    handler: (a, ctx) => {
      const docId = resolveDocId(ctx, a.documentId);
      const doc = ctx.store.getDoc(docId);
      const cid = resolveComponentId(doc, a.componentId);
      if (!cid) throw new Error(`Component "${a.componentId}" not found. Use find_nodes {type:"component"}.`);
      const parentId = a.parentId ?? currentPage(ctx, doc);
      const { result } = ctx.store.mutate(docId, origin(ctx, 'create_instance'), (d) => {
        const id = createInstance(d, cid, parentId, { x: a.x, y: a.y, index: a.index });
        if (a.overrides) {
          const o: any = {};
          for (const [k, v] of Object.entries(a.overrides)) o[k] = normalizeOverride(v);
          (d.nodes[id] as any).overrides = o;
        }
        return id;
      });
      const after = ctx.store.getDoc(docId);
      const layers = instanceLayers(after, after.nodes[result] as any);
      return text(
        `Created instance #${result} of "${after.nodes[cid].name}".\nOverridable layers:\n${layers.map((l) => `- ${l.key}: ${l.node.type} "${l.node.name}"${l.node.type === 'text' ? ` = ${JSON.stringify((l.node as any).text)}` : ''}`).join('\n')}`,
      );
    },
  },
  {
    name: 'get_comments',
    title: 'Get comments',
    description:
      'List review comment threads (like Figma comments): who said what, which layer each is pinned to, and whether it is resolved. Use this when asked to "address the comments" or review feedback, then fix the design (or code) and reply / resolve.',
    shape: {
      documentId: docIdArg,
      pageId: z.string().optional().describe('Only threads on this page'),
      nodeId: z.string().optional().describe('Only threads on this layer or inside it'),
      includeResolved: z.boolean().optional().describe('Include resolved threads (default false)'),
    },
    readOnly: true,
    handler: (a, ctx) => {
      const doc = ctx.store.getDoc(resolveDocId(ctx, a.documentId));
      let threads = a.nodeId ? threadsForNode(doc, a.nodeId, !!a.includeResolved) : Object.values(doc.comments ?? {}).filter((t) => a.includeResolved || !t.resolved);
      if (a.pageId) threads = threads.filter((t) => t.pageId === a.pageId);
      threads.sort((x, y) => x.number - y.number);
      if (!threads.length) return text(a.includeResolved ? 'No comments.' : 'No open comments.');
      return text(threads.map((t) => formatThread(doc, t)).join('\n\n'));
    },
  },
  {
    name: 'add_comment',
    title: 'Add comment / reply',
    description:
      'Leave a review comment pinned to a layer (nodeId, optional x/y offset inside it), or reply to an existing thread (threadId). Use it to explain changes you made, ask the designer a question, or flag issues.',
    shape: {
      documentId: docIdArg,
      text: z.string().min(1).describe('Comment text'),
      threadId: z.string().optional().describe('Reply to this thread instead of starting a new one'),
      nodeId: z.string().optional().describe('Layer to pin a new thread to'),
      x: z.number().optional().describe('Offset inside the layer (or page x without nodeId). Default 16'),
      y: z.number().optional().describe('Offset inside the layer (or page y without nodeId). Default 16'),
      pageId: z.string().optional().describe('Page for an unpinned comment (defaults to the current page)'),
    },
    handler: (a, ctx) => {
      const docId = resolveDocId(ctx, a.documentId);
      const doc = ctx.store.getDoc(docId);
      if (a.nodeId) requireNode(doc, a.nodeId);
      const { result } = ctx.store.mutate(docId, origin(ctx, 'add_comment'), (d) => {
        if (a.threadId) return replyToThread(d, a.threadId, a.text, ctx.agent, 'agent').id;
        if (a.nodeId) {
          const abs = absolutePosition(d, a.nodeId);
          const x = a.x ?? 16;
          const y = a.y ?? 16;
          return addThread(d, { pageId: pageOf(d, a.nodeId)!, nodeId: a.nodeId, x, y, pageX: abs.x + x, pageY: abs.y + y, text: a.text, author: ctx.agent, authorKind: 'agent' }).id;
        }
        if (a.x === undefined || a.y === undefined) throw new Error('Pass nodeId (recommended) or page x/y for a new comment.');
        const pageId = a.pageId ?? currentPage(ctx, d);
        return addThread(d, { pageId, x: a.x, y: a.y, pageX: a.x, pageY: a.y, text: a.text, author: ctx.agent, authorKind: 'agent' }).id;
      });
      const after = ctx.store.getDoc(docId);
      return text(`${a.threadId ? 'Replied on' : 'Created'} comment:\n${formatThread(after, after.comments[result])}`);
    },
  },
  {
    name: 'resolve_comment',
    title: 'Resolve comment',
    description: 'Mark a comment thread as resolved (or reopen it). Optionally add a final reply explaining what changed.',
    shape: {
      documentId: docIdArg,
      threadId: z.string(),
      resolved: z.boolean().optional().describe('false to reopen (default true)'),
      reply: z.string().optional().describe('Optional reply to add first'),
    },
    handler: (a, ctx) => {
      const docId = resolveDocId(ctx, a.documentId);
      ctx.store.mutate(docId, origin(ctx, 'resolve_comment'), (d) => {
        if (a.reply) replyToThread(d, a.threadId, a.reply, ctx.agent, 'agent');
        setResolved(d, a.threadId, a.resolved !== false, ctx.agent);
      });
      const after = ctx.store.getDoc(docId);
      return text(formatThread(after, after.comments[a.threadId]));
    },
  },
  {
    name: 'select_nodes',
    title: 'Select & reveal nodes',
    description: 'Select layers in the user\'s editor and zoom to them, to show the user what you are talking about or what you changed.',
    shape: { documentId: docIdArg, ids: z.array(z.string()).min(1), zoom: z.boolean().optional().describe('Zoom to fit them (default true)') },
    handler: (a, ctx) => {
      const docId = resolveDocId(ctx, a.documentId);
      ctx.hub.broadcast(docId, { t: 'select', ids: a.ids, zoom: a.zoom !== false, agent: ctx.agent });
      return text(ctx.hub.editorOpen(docId) ? `Selected ${a.ids.length} layer(s) in the editor.` : 'No editor is open for this document.');
    },
  },
  {
    name: 'create_page',
    title: 'Create page',
    description: 'Add a page to the document.',
    shape: { documentId: docIdArg, name: z.string() },
    handler: (a, ctx) => {
      const docId = resolveDocId(ctx, a.documentId);
      const { result } = ctx.store.mutate(docId, origin(ctx, 'create_page'), (d) => addPage(d, a.name));
      return text(`Created page "${a.name}" #${result}. Use it as parentId in create_nodes.`);
    },
  },
  {
    name: 'import_html',
    title: 'Import HTML into the canvas',
    description:
      'Convert HTML (with inline styles, a <style> block, or Tailwind classes) into editable design layers, preserving flex layouts as auto layout. Great for turning existing UI code into a design. Requires the editor to be open.',
    shape: {
      documentId: docIdArg,
      html: z.string().describe('HTML markup (a fragment or full document). Tailwind utility classes are supported.'),
      name: z.string().optional().describe('Name of the root frame'),
      width: z.number().optional().describe('Viewport width used for layout (default 1440)'),
      parentId: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
    },
    handler: async (a, ctx) => {
      const docId = resolveDocId(ctx, a.documentId);
      const doc = ctx.store.getDoc(docId);
      const parentId = a.parentId ?? currentPage(ctx, doc);
      const res = await ctx.hub.request<{ spec: NodeSpec }>(docId, 'import-html', { html: a.html, width: a.width ?? 1440, name: a.name ?? 'Imported' }, 30000);
      if (a.x !== undefined) res.spec.x = a.x;
      if (a.y !== undefined) res.spec.y = a.y;
      const { result } = ctx.store.mutate(docId, origin(ctx, 'import_html'), (d) => createNodes(d, [res.spec], parentId, undefined, { autoPlace: true }));
      ctx.hub.broadcast(docId, { t: 'reveal', ids: result.ids, agent: ctx.agent });
      const after = ctx.store.getDoc(docId);
      return text(`Imported ${result.created.length} layers:\n${outline(after, result.ids, 3, 80)}`);
    },
  },
];

function normalizeOverride(v: any) {
  const o: any = {};
  if (v == null || typeof v !== 'object') return o;
  if (v.text !== undefined || v.characters !== undefined) o.text = String(v.text ?? v.characters);
  if (v.visible !== undefined) o.visible = !!v.visible;
  if (v.fill !== undefined || v.fills !== undefined || v.color !== undefined) {
    o.fills = normalizeProps({ type: 'rect', fills: v.fills ?? v.fill ?? v.color }).fills;
  }
  if (v.src !== undefined) o.src = String(v.src);
  return o;
}

export function getTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

export async function runTool(name: string, args: any, ctx: ToolContext): Promise<ToolResult> {
  const tool = getTool(name);
  if (!tool) return { content: [{ type: 'text', text: `Unknown tool "${name}"` }], isError: true };
  const parsed = z.object(tool.shape).safeParse(args ?? {});
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Invalid arguments for ${name}: ${parsed.error.message}` }], isError: true };
  }
  try {
    return await tool.handler(parsed.data, ctx);
  } catch (err: any) {
    return { content: [{ type: 'text', text: `Error: ${err?.message ?? String(err)}` }], isError: true };
  }
}

/** JSON Schemas for API-based agents (Anthropic / OpenAI function calling). */
export function toolJsonSchemas(): Array<{ name: string; description: string; schema: any }> {
  return TOOLS.map((t) => {
    const schema: any = z.toJSONSchema(z.object(t.shape), { unrepresentable: 'any' });
    delete schema.$schema;
    return { name: t.name, description: t.description, schema };
  });
}
