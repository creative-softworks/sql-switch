/**
 * Minimal static file server for the TypeDoc output in ./docs
 * Run: npx tsx scripts/serve-docs.ts
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = path.join(__dirname, '..', 'docs');
const PORT = Number(process.env.PORT ?? 3000);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'text/javascript',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff':  'font/woff',
};

const server = http.createServer((req, res) => {
  let urlPath = req.url ?? '/';
  // strip query string
  urlPath = urlPath.split('?')[0]!;
  // default to index.html for directory roots
  if (urlPath.endsWith('/')) urlPath += 'index.html';

  const filePath = path.join(DOCS_DIR, urlPath);

  // don't let requests escape the docs dir
  if (!filePath.startsWith(DOCS_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // try appending .html before giving up (e.g. /classes/DAL -> DAL.html)
      fs.readFile(`${filePath}.html`, (err2, data2) => {
        if (err2) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('404 not found');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(data2);
        }
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`docs live at http://0.0.0.0:${PORT}`);
});
