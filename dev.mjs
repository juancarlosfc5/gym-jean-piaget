import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import handler from './api/piloto.js';

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/tablero', ['tablero.html', 'text/html; charset=utf-8']],
  ['/tablero.html', ['tablero.html', 'text/html; charset=utf-8']],
  ['/estilos.css', ['estilos.css', 'text/css; charset=utf-8']],
  ['/piloto.js', ['piloto.js', 'text/javascript; charset=utf-8']],
  ['/logo.png', ['logo.png', 'image/png']],
]);
const port = Number(process.env.PORT || 4174);
createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/api/piloto') return handler(req, res);
  const entry = staticFiles.get(path);
  if (!entry) { res.writeHead(404).end(); return; }
  try {
    const bytes = await readFile(new URL('./public/' + entry[0], import.meta.url));
    res.writeHead(200, { 'Content-Type': entry[1] }).end(bytes);
  } catch { res.writeHead(500).end(); }
}).listen(port, '127.0.0.1', () => console.log('Jean Piaget en http://127.0.0.1:' + port));
