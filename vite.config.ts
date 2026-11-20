import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const serverPort = Number(process.env.DESIGN_CANVAS_PORT ?? 4410);
const target = `http://127.0.0.1:${serverPort}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/api': { target, changeOrigin: false },
      '/assets': { target, changeOrigin: false },
      '/mcp': { target, changeOrigin: false },
      '/ws': { target: target.replace('http', 'ws'), ws: true },
    },
  },
  build: {
    outDir: 'dist',
    // `/assets` is reserved for uploaded images served by the API server.
    assetsDir: '_app',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
});
