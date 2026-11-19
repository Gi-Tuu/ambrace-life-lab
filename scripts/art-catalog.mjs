import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.ART_CATALOG_PORT ?? 17969);
const fixed = new Map([
  ['/', ['scripts/art-catalog.html', 'text/html; charset=utf-8']],
  ['/docs/art-catalog.html', ['scripts/art-catalog.html', 'text/html; charset=utf-8']],
  ['/art-hashes.json', ['art-hashes.json', 'application/json']],
]);

function assetFor(path) {
  if (fixed.has(path)) return fixed.get(path);
  if (/^\/(?:shared|web)\/[\w-]+\.m?js$/.test(path)) return [path.slice(1), 'text/javascript'];
  if (/^\/web\/assets\/[\w-]+\.png$/.test(path)) return [path.slice(1), 'image/png'];
  return null;
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  try {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    const asset = assetFor(path);
    if (!asset) {
      res.writeHead(404).end();
      return;
    }
    const [file, type] = asset;
    const body = await readFile(resolve(root, file));
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    }).end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404).end();
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`美术资产图鉴 http://127.0.0.1:${server.address().port}/`);
});
