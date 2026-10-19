// Tiny static server for the test harness (serves the repository root).
// Run: node dev/test-harness/serve.js, then open http://localhost:8765/dev/test-harness/index.html
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const port = Number(process.env.PORT) || 8765;
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

http
  .createServer((req, res) => {
    const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(root)) return res.writeHead(403).end();
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end('not found');
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    });
  })
  .listen(port, () => console.log(`http://localhost:${port}/dev/test-harness/index.html`));
