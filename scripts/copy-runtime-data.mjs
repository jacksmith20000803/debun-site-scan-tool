import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const copies = [
  ['src/bundler-patterns.js', 'dist/src/bundler-patterns.js'],
  ['patterns/bundlers.json', 'dist/patterns/bundlers.json'],
];
for (const [from, to] of copies) {
  const destination = resolve(root, to);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(resolve(root, from), destination);
}
