#!/usr/bin/env node
// Dependency-free static file server for local development and E2E tests.
// Usage: node scripts/serve.mjs [port]   (default 8080, or $PORT)
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = path.resolve(root, '.' + rel);
      if (!file.startsWith(root + path.sep) && file !== root) { res.writeHead(403).end('Forbidden'); return; }
      const s = await stat(file).catch(() => null);
      if (!s || !s.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found: ' + rel); return; }
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end(String(err));
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer().listen(port, () => console.log(`LogiPlan dev server: http://localhost:${port}/`));
}
