import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export function createFixtureServer(port = 12399) {
  const server = http.createServer((req, res) => {
    let reqPath = (req.url || '/').split('?')[0];
    if (reqPath.endsWith('/')) {
      reqPath += 'index.html';
    }

    const safePath = path.normalize(reqPath).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(FIXTURES_DIR, safePath);

    if (!filePath.startsWith(FIXTURES_DIR)) {
      res.writeHead(403);
      res.end('Access denied');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end(`Not found: ${reqPath}`);
        } else {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(`Internal Server Error: ${err.message}`);
        }
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      res.end(data);
    });
  });

  return {
    start() {
      return new Promise((resolve, reject) => {
        server.listen(port, '127.0.0.1', () => {
          resolve({ port, url: `http://localhost:${port}` });
        });
        server.on('error', reject);
      });
    },
    stop() {
      return new Promise((resolve) => {
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
        server.close(resolve);
      });
    },
    server,
  };
}

// Allow direct execution: node benchmark/fixture-server.mjs
if (process.argv[1] === __filename) {
  const port = parseInt(process.env.BENCHMARK_PORT || '12399', 10);
  const fixtureServer = createFixtureServer(port);
  fixtureServer.start().then(({ url }) => {
    console.log(`[Benchmark Fixture Server] Running at ${url}`);
  }).catch((err) => {
    console.error(`[Benchmark Fixture Server] Failed to start:`, err);
    process.exit(1);
  });
}
