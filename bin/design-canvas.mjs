#!/usr/bin/env node
/**
 * Start Design Canvas (editor + API + MCP) on one port.
 *
 *   design-canvas [--port 4410] [--dir ./designs] [--project .]
 *
 * Run it from your project folder to keep design files next to your code.
 * Build the editor once with `npm run build` in the design-canvas folder.
 */
import { register } from 'tsx/esm/api';

register();
await import('../src/server/index.ts');
