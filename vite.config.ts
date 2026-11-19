import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'version-offline-shell',
      apply: 'build',
      async closeBundle() {
        const html = await readFile('dist/index.html', 'utf8');
        const version = createHash('sha256').update(html).digest('hex').slice(0, 16);
        const sw = await readFile('dist/sw.js', 'utf8');
        const assets = (await readdir('dist/assets'))
          .filter((name) => /\.(?:js|mjs|css)$/.test(name))
          .map((name) => `/assets/${name}`)
          .sort();
        const placeholder = /const BUILD_FILES\s*=\s*\[\];/;
        if (!placeholder.test(sw))
          throw new Error('Service worker is missing the build asset placeholder.');
        await writeFile(
          'dist/sw.js',
          sw
            .replace('daypact-shell-v1', `daypact-shell-${version}`)
            .replace(placeholder, `const BUILD_FILES=${JSON.stringify(assets)};`),
        );
      },
    },
  ],
  server: { host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:8787' } },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 650 },
});
