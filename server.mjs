import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { delimiter, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildPatentArgs, isSameOrigin, terminalDimensions } from './web-config.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const suffix = process.platform === 'win32' ? '.exe' : '';
const manifest = resolve(root, 'Cargo.toml');
const binaryPaths = [
  resolve(root, `target/release/patent${suffix}`),
  resolve(root, `target/debug/patent${suffix}`),
];
const cargoCandidates = [
  process.env.CARGO,
  join(homedir(), '.cargo', 'bin', `cargo${suffix}`),
  ...(process.env.PATH || '').split(delimiter).map(directory => join(directory, `cargo${suffix}`)),
].filter(Boolean);
const cargo = cargoCandidates.find(existsSync);

function findPatentBinary() {
  return binaryPaths.find(existsSync);
}

let patentBinary = findPatentBinary();
if (cargo) {
  const build = spawnSync(cargo, [
    'build', '--locked', '--manifest-path', manifest, '--bin', 'patent', '--message-format=json-render-diagnostics',
  ], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: process.env,
  });
  if (build.error) {
    console.error(`Cargo çalıştırılamadı (${cargo}): ${build.error.message}`);
    process.exit(1);
  }
  if (build.status !== 0) process.exit(build.status ?? 1);
  const artifact = build.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .find(message => message?.reason === 'compiler-artifact'
      && message.target?.name === 'patent'
      && message.target?.kind?.includes('bin')
      && message.executable);
  if (!artifact) {
    console.error('Cargo derlemesi tamamlandı ancak patent binary yolu alınamadı.');
    process.exit(1);
  }
  patentBinary = artifact.executable;
}
if (!patentBinary) {
  console.error('Patent çalıştırılabilir dosyası bulunamadı. Rust/Cargo kurun veya proje kökünde cargo build --bin patent çalıştırın.');
  process.exit(1);
}

let pty, WebSocketServer, WebSocket, esbuild;
try {
  [pty, { WebSocketServer, WebSocket }, esbuild] = await Promise.all([
    import('node-pty').then(module => module.default ?? module),
    import('ws'),
    import('esbuild'),
  ]);
} catch (error) {
  if (error.message.includes('pty.node')) {
    console.error('node-pty native modülü derlenemedi. `npm install-scripts approve node-pty` ardından `npm rebuild node-pty` çalıştırın.');
  } else {
    console.error('Web TUI bağımlılıkları kurulu değil. Proje kökünde `npm install` çalıştırın.');
  }
  console.error(error.message);
  process.exit(1);
}

const bundle = await esbuild.build({
  entryPoints: [resolve(root, 'app.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  write: false,
  logLevel: 'silent',
});
const appBundle = bundle.outputFiles[0].contents;
const xtermCss = readFileSync(resolve(root, 'node_modules/@xterm/xterm/css/xterm.css'));
const indexHtml = readFileSync(resolve(root, 'index.html'));
const terminalCss = readFileSync(resolve(root, 'terminal.css'));
const assets = new Map([
  ['/', ['text/html; charset=utf-8', indexHtml]],
  ['/index.html', ['text/html; charset=utf-8', indexHtml]],
  ['/app.js', ['text/javascript; charset=utf-8', appBundle]],
  ['/terminal.css', ['text/css; charset=utf-8', terminalCss]],
  ['/xterm.css', ['text/css; charset=utf-8', xtermCss]],
]);

const host = process.env.PATENT_WEB_HOST || '127.0.0.1';
const port = Number(process.env.PATENT_WEB_PORT || 4173);
const server = createServer((request, response) => {
  const pathname = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`).pathname;
  const asset = assets.get(pathname);
  if (!asset || (request.method !== 'GET' && request.method !== 'HEAD')) {
    response.writeHead(asset ? 405 : 404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(asset ? 'Method not allowed' : 'Not found');
    return;
  }
  response.writeHead(200, {
    'Content-Type': asset[0],
    'Content-Length': asset[1].byteLength,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:",
  });
  response.end(request.method === 'HEAD' ? undefined : asset[1]);
});
server.on('error', error => {
  console.error(`Patent TUI sunucusu http://${host}:${port} adresini dinleyemedi: ${error.message}`);
  process.exitCode = 1;
});

const webSockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
server.on('upgrade', (request, socket, head) => {
  let url;
  try {
    url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  } catch {
    socket.destroy();
    return;
  }
  if (url.pathname !== '/terminal') {
    socket.destroy();
    return;
  }
  const origin = request.headers.origin;
  if (!isSameOrigin(origin, request.headers.host)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  webSockets.handleUpgrade(request, socket, head, client => webSockets.emit('connection', client, request, url));
});

webSockets.on('connection', (client, _request, url) => {
  const { cols, rows } = terminalDimensions(url.searchParams);
  const args = buildPatentArgs();

  let terminal;
  try {
    terminal = pty.spawn(patentBinary, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: root,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', PATENT_WEB: '1' },
    });
  } catch (error) {
    client.send(JSON.stringify({ type: 'output', data: `\x1b[31mCould not start patent: ${error.message}\x1b[0m\r\n` }));
    client.close(1011, 'TUI failed to start');
    return;
  }

  terminal.onData(data => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'output', data }));
    }
  });
  terminal.onExit(({ exitCode }) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'exit', code: exitCode }));
      client.close(1000, 'TUI exited');
    }
  });
  client.on('message', message => {
    if (message.length > 64 * 1024) return;
    let event;
    try {
      event = JSON.parse(message.toString());
    } catch {
      return;
    }
    if (event.type === 'input' && typeof event.data === 'string') terminal.write(event.data);
    if (event.type === 'resize') {
      const nextCols = Number(event.cols);
      const nextRows = Number(event.rows);
      if (Number.isInteger(nextCols) && Number.isInteger(nextRows)) {
        terminal.resize(Math.max(1, Math.min(300, nextCols)), Math.max(1, Math.min(120, nextRows)));
      }
    }
  });
  client.on('close', () => terminal.kill());
  client.on('error', () => terminal.kill());
});

server.listen(port, host, () => {
  console.log(`Patent TUI is available at http://${host}:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    webSockets.clients.forEach(client => client.close(1001, 'Server shutting down'));
    server.close(() => process.exit(0));
  });
}
