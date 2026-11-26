import type { DocStore } from './store.ts';
import { createInstance, createNodes, upsertVariable } from '../shared/ops.ts';
import { firstPageId } from '../shared/doc.ts';

/** A small starter document that shows off tokens, components and auto layout. */
export function seedWelcome(store: DocStore) {
  store.create('Welcome to Design Canvas', (d) => {
    const page = firstPageId(d);
    for (const v of [
      { name: 'primary', value: '#6366F1', group: 'color' },
      { name: 'primary-foreground', value: '#FFFFFF', group: 'color' },
      { name: 'background', value: '#FFFFFF', group: 'color' },
      { name: 'surface', value: '#F8FAFC', group: 'color' },
      { name: 'foreground', value: '#0F172A', group: 'color' },
      { name: 'muted', value: '#64748B', group: 'color' },
      { name: 'border', value: '#E2E8F0', group: 'color' },
      { name: 'radius-md', value: 12, type: 'number' as const, group: 'radius' },
      { name: 'space-4', value: 16, type: 'number' as const, group: 'spacing' },
    ])
      upsertVariable(d, v);

    const comp = createNodes(
      d,
      [
        {
          type: 'component',
          name: 'Button',
          x: 0,
          y: -160,
          layout: { mode: 'row', gap: 8, padding: [10, 18], align: 'center', justify: 'center' },
          fill: '$primary',
          radius: 10,
          codeConnect: { name: 'Button', importPath: '@/components/ui/button' },
          description: 'Primary call to action. Maps to the shadcn/ui Button in code.',
          children: [{ type: 'text', name: 'Label', text: 'Button', fontSize: 14, fontWeight: 600, color: '$primary-foreground' }],
        },
      ],
      page,
    ).ids[0];

    const card = (title: string, body: string, code: string) => ({
      type: 'frame',
      name: 'Card',
      width: 'fill',
      layout: { mode: 'column', gap: 10, padding: 24 },
      fill: '$background',
      radius: '$radius-md',
      stroke: { color: '$border', width: 1 },
      shadows: [{ x: 0, y: 1, blur: 2, color: 'rgba(15,23,42,0.06)' }],
      children: [
        { type: 'text', name: 'Title', text: title, fontSize: 18, fontWeight: 600, color: '$foreground' },
        { type: 'text', name: 'Body', text: body, width: 'fill', fontSize: 14, lineHeight: '150%', color: '$muted' },
        {
          type: 'frame',
          name: 'Code',
          width: 'fill',
          layout: { mode: 'row', padding: [8, 12] },
          fill: '#0F172A',
          radius: 8,
          children: [{ type: 'text', name: 'Snippet', text: code, width: 'fill', fontFamily: 'JetBrains Mono', fontSize: 12, lineHeight: '160%', color: '#E2E8F0' }],
        },
      ],
    });

    const res = createNodes(
      d,
      [
        {
          type: 'frame',
          name: 'Welcome',
          x: 0,
          y: 0,
          width: 1200,
          height: 'hug',
          fill: '$surface',
          layout: { mode: 'column', gap: 40, padding: [64, 72] },
          children: [
            {
              type: 'frame',
              name: 'Hero',
              width: 'fill',
              layout: { mode: 'column', gap: 16 },
              children: [
                {
                  type: 'frame',
                  name: 'Badge',
                  layout: { mode: 'row', padding: [4, 10] },
                  fill: '#EEF2FF',
                  radius: 999,
                  children: [{ type: 'text', text: 'Free · local-first · AI-native', fontSize: 12, fontWeight: 600, color: '$primary' }],
                },
                { type: 'text', name: 'Headline', text: 'Design it. Hand it to your agent. Ship it.', fontSize: 48, fontWeight: 700, letterSpacing: -1, color: '$foreground' },
                {
                  type: 'text',
                  name: 'Subhead',
                  text: 'Design Canvas is a Figma-style editor where every frame is real flexbox. Claude Code and Codex can read your designs, generate code from them, and even design for you.',
                  width: 760,
                  fontSize: 18,
                  lineHeight: '160%',
                  color: '$muted',
                },
                { type: 'frame', name: 'Actions', layout: { mode: 'row', gap: 12 }, children: [] },
              ],
            },
            {
              type: 'frame',
              name: 'Steps',
              width: 'fill',
              layout: { mode: 'row', gap: 20, align: 'stretch' },
              children: [
                card('1. Connect Claude Code', 'Register the MCP server once. Then ask Claude to "implement my selection in Design Canvas".', 'claude mcp add --transport http design-canvas http://localhost:4410/mcp'),
                card('2. Connect Codex', 'Codex talks to Design Canvas over a tiny stdio bridge. See the Connect dialog for the exact command.', 'codex mcp add design-canvas -- node bin/design-canvas-mcp.mjs'),
                card('3. Or design with AI here', 'Open the AI tab on the right, pick Claude Code, Codex, Claude or GPT, and describe the screen you want.', '"Design a pricing page with 3 tiers"'),
              ],
            },
          ],
        },
      ],
      page,
    );
    const welcome = res.ids[0];
    const actions = Object.values(d.nodes).find((n) => n.name === 'Actions' && n.parentId !== welcome)!;
    const i1 = createInstance(d, comp, actions.id);
    const i2 = createInstance(d, comp, actions.id);
    const label = Object.values(d.nodes).find((n) => n.parentId === comp)!;
    (d.nodes[i1] as any).overrides = { [label.id]: { text: 'Open the AI panel' } };
    (d.nodes[i2] as any).overrides = { [label.id]: { text: 'Inspect code', fills: [{ type: 'solid', color: '$foreground' }] } };
    (d.nodes[i2] as any).fills = [{ type: 'solid', color: '#FFFFFF' }];
    (d.nodes[i2] as any).stroke = { color: '$border', width: 1 };
  });
}
