import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import { copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = resolve(root, 'scripts/maps/.qa/dist');
await build({
  configFile: false,
  root,
  plugins: [react()],
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: { input: resolve(root, 'scripts/maps/qa.html') },
  },
});
await copyFile(resolve(outDir, 'scripts/maps/qa.html'), resolve(outDir, 'index.html'));
const server = await preview({
  configFile: false,
  root,
  build: { outDir },
  preview: { host: '127.0.0.1', port: Number(process.env.MAP_QA_PORT ?? 5179), strictPort: true },
});
server.printUrls();
