// A static file server for the self-tests.
import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

export function serve(root) {
  const base = resolve(root);
  const server = createServer((req, res) => {
    const file = resolve(join(base, decodeURIComponent(new URL(req.url, "http://x").pathname)));
    if (!file.startsWith(base) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}
