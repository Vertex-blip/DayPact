import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/prepare-brand.mjs path/to/approved-logo.png');
await Promise.all(['public/brand', 'public/icons'].map((p) => mkdir(p, { recursive: true })));
await sharp(source)
  .resize(512, 512, { fit: 'contain' })
  .webp({ quality: 88 })
  .toFile('public/brand/logo.webp');
for (const [name, size] of [
  ['icon-192', 192],
  ['icon-512', 512],
  ['maskable-512', 512],
  ['apple-touch-icon', 180],
])
  await sharp(source)
    .resize(size, size, { fit: 'contain' })
    .png({ compressionLevel: 9 })
    .toFile(`public/icons/${name}.png`);
await sharp(source).resize(32, 32).png().toFile('public/icons/favicon.png');
console.log('Prepared approved logo and app icons.');
