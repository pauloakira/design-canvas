#!/usr/bin/env node
/**
 * Smoke test for the MCP endpoint (and optionally the stdio bridge).
 *   node scripts/mcp-smoke.mjs [--port 4410] [--stdio]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const i = process.argv.indexOf('--port');
const port = i >= 0 ? process.argv[i + 1] : process.env.DESIGN_CANVAS_PORT ?? '4410';
const url = `http://localhost:${port}/mcp`;
const useStdio = process.argv.includes('--stdio');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const client = new Client({ name: 'smoke-test', version: '1.0.0' });
const transport = useStdio
  ? new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'bin/design-canvas-mcp.mjs'), '--url', url, '--name', 'Smoke'] })
  : new StreamableHTTPClientTransport(new URL(url));
await client.connect(transport);

const text = (r) => r.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name} failed: ${text(r)}`);
  return r;
};

const tools = await client.listTools();
console.log(`✓ ${tools.tools.length} tools via ${useStdio ? 'stdio bridge' : 'HTTP'}; instructions: ${(client.getInstructions() ?? '').length} chars`);
console.log('✓ list_documents', text(await call('list_documents')).slice(0, 120).replace(/\n/g, ' '), '…');

const doc = JSON.parse(text(await call('create_document', { name: 'Smoke test' })));
console.log('✓ create_document', doc.id);

await call('set_variables', { documentId: doc.id, variables: [{ name: 'brand', value: '#0EA5E9' }, { name: 'gap', value: 12 }] });
const created = text(
  await call('create_nodes', {
    documentId: doc.id,
    nodes: [
      {
        type: 'frame',
        name: 'Login',
        width: 390,
        height: 'hug',
        fill: '#FFFFFF',
        layout: { mode: 'column', gap: '$gap', padding: 24 },
        children: [
          { type: 'text', name: 'Title', text: 'Welcome back', fontSize: 28, fontWeight: 'bold', color: '#0F172A' },
          { type: 'frame', name: 'Input', width: 'fill', height: 44, radius: 8, stroke: '1px solid #CBD5E1' },
          {
            type: 'frame',
            name: 'Submit',
            width: 'fill',
            layout: { mode: 'row', justify: 'center', padding: [12, 16] },
            fill: '$brand',
            radius: 8,
            children: [{ type: 'text', text: 'Sign in', color: '#fff', fontWeight: 600 }],
          },
        ],
      },
    ],
  }),
);
console.log('✓ create_nodes\n' + created);
const rootId = created.match(/#(\w+)\s/g)?.[1]?.slice(1, -1);
const outline = text(await call('get_document', { documentId: doc.id }));
console.log('✓ get_document\n' + outline);
const loginId = outline.match(/frame "Login" #(\w+)/)[1];
const ctx = text(await call('get_design_context', { documentId: doc.id, nodeId: loginId }));
console.log('✓ get_design_context\n' + ctx);
const submitId = outline.match(/frame "Submit" #(\w+)/)[1];
await call('create_component', { documentId: doc.id, nodeId: submitId, codeConnect: { name: 'Button', importPath: '@/components/ui/button' } });
const inst = text(await call('create_instance', { documentId: doc.id, componentId: 'Submit', parentId: loginId }));
console.log('✓ create_instance\n' + inst);
const key = inst.match(/- (\S+): text/)[1];
const instId = inst.match(/instance #(\w+)/)[1];
await call('update_nodes', { documentId: doc.id, updates: [{ id: instId, overrides: { [key]: { text: 'Create account' } } }] });
console.log('✓ update_nodes (override)\n' + text(await call('get_design_context', { documentId: doc.id, nodeId: loginId })).split('```')[1]);
const shot = await client.callTool({ name: 'get_screenshot', arguments: { documentId: doc.id, nodeId: loginId } });
console.log(`✓ get_screenshot → ${shot.isError ? 'error (expected without an open editor): ' + text(shot) : 'image ok'}`);
await call('delete_nodes', { documentId: doc.id, ids: [loginId] });
console.log('✓ delete_nodes');
await client.close();
console.log('\nAll good.');
void rootId;
