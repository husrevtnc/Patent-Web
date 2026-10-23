import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';
import WebSocket from 'ws';
import { buildPatentArgs } from './web-config.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const base = new URL(process.env.PATENT_WEB_URL || 'http://127.0.0.1:4173');
const paths = ['/', '/app.js', '/terminal.css', '/xterm.css'];
const suffix = process.platform === 'win32' ? '.exe' : '';
let ownedServer;
let serverLog = '';
let socket;
let cliTerminal;
let cliOutput = '';
let cliOutputVersion = 0;
let cliExited = false;
let serverExit = '';

async function pageIsReady() {
  const response = await fetch(new URL('/', base), { signal: AbortSignal.timeout(1000) });
  if (!response.ok) return false;
  return (await response.text()).includes('<title>patent — prior-art search for code ideas</title>');
}

async function ensureServer() {
  try {
    if (await pageIsReady()) {
      console.log(`Using running Patent server at ${base.origin}`);
      return;
    }
  } catch {
    // Start a local server below when no server is listening yet.
  }

  if (base.protocol !== 'http:') {
    throw new Error(`No Patent server at ${base.origin}; automatic startup supports HTTP URLs only.`);
  }

  const host = base.hostname.replace(/^\[|\]$/g, '');
  ownedServer = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: { ...process.env, PATENT_WEB_HOST: host, PATENT_WEB_PORT: base.port || '4173' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const processClosed = new Promise(resolve => ownedServer.once('close', (code, signal) => {
    serverExit = `Server process closed (code ${code ?? 'none'}, signal ${signal ?? 'none'}).`;
    resolve();
  }));
  ownedServer.stdout.setEncoding('utf8').on('data', chunk => serverLog += chunk);
  ownedServer.stderr.setEncoding('utf8').on('data', chunk => serverLog += chunk);

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (ownedServer.exitCode !== null) {
      await processClosed;
      break;
    }
    try {
      if (await pageIsReady()) {
        console.log(`Started Patent server at ${base.origin}`);
        return;
      }
    } catch {
      // The server may still be building or opening its listener.
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Could not start Patent server at ${base.origin}.\n${serverExit}\n${serverLog.trim()}`);
}

async function stopOwnedServer() {
  if (!ownedServer || ownedServer.exitCode !== null) return;
  ownedServer.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => ownedServer.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 2000)),
  ]);
  if (ownedServer.exitCode === null) ownedServer.kill('SIGKILL');
}

function findCliBinary() {
  const cargoCandidates = [
    process.env.CARGO,
    join(homedir(), '.cargo', 'bin', `cargo${suffix}`),
    ...(process.env.PATH || '').split(delimiter).map(directory => join(directory, `cargo${suffix}`)),
  ].filter(Boolean);
  const cargo = cargoCandidates.find(existsSync);
  if (cargo) {
    const metadata = spawnSync(cargo, ['metadata', '--no-deps', '--format-version', '1', '--manifest-path', resolve(root, 'Cargo.toml')], {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
    });
    if (metadata.status === 0) {
      const targetDir = JSON.parse(metadata.stdout).target_directory;
      const built = resolve(targetDir, 'debug', `patent${suffix}`);
      if (existsSync(built)) return built;
    }
  }
  const targets = process.env.CARGO_TARGET_DIR
    ? [resolve(root, process.env.CARGO_TARGET_DIR)]
    : [resolve(root, 'target')];
  for (const target of targets) {
    for (const profile of ['debug', 'release']) {
      const candidate = resolve(target, profile, `patent${suffix}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error('Could not find the built patent CLI binary for comparison.');
}

function waitForCli(predicate, description) {
  const deadline = Date.now() + 10000;
  return new Promise((resolveWait, reject) => {
    const poll = () => {
      if (predicate()) return resolveWait();
      if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for CLI ${description}`));
      setTimeout(poll, 20);
    };
    poll();
  });
}

let output = '';
let outputVersion = 0;
const messages = [];
let timer;

try {
  await ensureServer();

  cliTerminal = pty.spawn(findCliBinary(), buildPatentArgs(), {
    name: 'xterm-256color',
    cols: 100,
    rows: 36,
    cwd: root,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', PATENT_WEB: '1' },
  });
  cliTerminal.onData(data => {
    cliOutput += data;
    cliOutputVersion += 1;
  });
  cliTerminal.onExit(() => { cliExited = true; });
  await waitForCli(() => /describe your dev-tool idea/i.test(cliOutput), 'initial TUI screen');

  for (const path of paths) {
    const response = await fetch(new URL(path, base));
    assert.equal(response.status, 200, `GET ${path} should succeed`);
    const body = await response.arrayBuffer();
    assert(body.byteLength > 0, `GET ${path} should return content`);

    const head = await fetch(new URL(path, base), { method: 'HEAD' });
    assert.equal(head.status, 200, `HEAD ${path} should succeed`);
    assert.equal(Number(head.headers.get('content-length')), body.byteLength, `HEAD ${path} length should match GET`);
    console.log(`PASS HTTP ${path}`);
  }

  const wsUrl = new URL('/terminal?cols=100&rows=36', base);
  wsUrl.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(wsUrl);

  socket.on('message', data => {
    try {
      const message = JSON.parse(data.toString());
      messages.push(message);
      if (message.type === 'output') {
        output += message.data;
        outputVersion += 1;
      }
    } catch {
      // Ignore malformed frames; the assertions below will time out with context.
    }
  });

  function waitFor(predicate, description) {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const check = () => {
        if (predicate()) {
          clearTimeout(timer);
          socket.off('message', onMessage);
          resolve();
        }
      };
      const onMessage = () => check();
      socket.on('message', onMessage);
      timer = setTimeout(() => {
        socket.off('message', onMessage);
        reject(new Error(`Timed out waiting for ${description}`));
      }, 10000);
      check();
    });
  }

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket connection timed out')), 10000);
    socket.once('open', () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  await waitFor(() => /describe your dev-tool idea/i.test(output), 'the initial Patent TUI screen');
  await new Promise(resolveWait => setTimeout(resolveWait, 100));
  assert.equal(output, cliOutput, 'web and CLI initial terminal output should match');
  assert.doesNotMatch(output, /\x1b\[\?100[01256]h/, 'web TUI must leave mouse selection to the browser');
  console.log('PASS CLI and WebSocket initial TUI output match');

  const beforeResize = outputVersion;
  const beforeCliResize = cliOutputVersion;
  cliTerminal.resize(100, 24);
  socket.send(JSON.stringify({ type: 'resize', cols: 100, rows: 24 }));
  await waitFor(() => outputVersion > beforeResize, 'resized TUI redraw');
  await waitForCli(() => cliOutputVersion > beforeCliResize, 'resized TUI redraw');
  await new Promise(resolveWait => setTimeout(resolveWait, 100));
  assert.equal(output, cliOutput, 'web and CLI terminal output should match after a window resize');
  console.log('PASS WebSocket forwards terminal resize');

  const beforeRestore = outputVersion;
  const beforeCliRestore = cliOutputVersion;
  cliTerminal.resize(100, 36);
  socket.send(JSON.stringify({ type: 'resize', cols: 100, rows: 36 }));
  await waitFor(() => outputVersion > beforeRestore, 'restored TUI redraw');
  await waitForCli(() => cliOutputVersion > beforeCliRestore, 'restored TUI redraw');
  await new Promise(resolveWait => setTimeout(resolveWait, 100));
  assert.equal(output, cliOutput, 'web and CLI output should match after restoring terminal size');

  const beforeTyping = outputVersion;
  const beforeCliTyping = cliOutputVersion;
  cliTerminal.write('r');
  socket.send(JSON.stringify({ type: 'input', data: 'r' }));
  await waitFor(() => outputVersion > beforeTyping, 'typed search text redraw');
  await waitForCli(() => cliOutputVersion > beforeCliTyping, 'typed search text redraw');
  await new Promise(resolveWait => setTimeout(resolveWait, 100));
  assert.equal(output, cliOutput, 'web and CLI typed terminal output should match');
  console.log('PASS CLI and WebSocket text input output match');

  const beforeShortcut = outputVersion;
  const beforeCliShortcut = cliOutputVersion;
  cliTerminal.write('\x17');
  socket.send(JSON.stringify({ type: 'input', data: '\x17' }));
  await waitFor(() => outputVersion > beforeShortcut, 'Ctrl+Backspace redraw');
  await waitForCli(() => cliOutputVersion > beforeCliShortcut, 'Ctrl+Backspace redraw');
  await new Promise(resolveWait => setTimeout(resolveWait, 100));
  assert.equal(output, cliOutput, 'web and CLI Ctrl+Backspace output should match');
  console.log('PASS CLI and WebSocket Ctrl+Backspace output match');

  const beforeCtrlA = outputVersion;
  const beforeCliCtrlA = cliOutputVersion;
  cliTerminal.write('demo');
  socket.send(JSON.stringify({ type: 'input', data: 'demo' }));
  await waitFor(() => outputVersion > beforeCtrlA, 'search text before Ctrl+A');
  await waitForCli(() => cliOutputVersion > beforeCliCtrlA, 'search text before Ctrl+A');
  const beforeMove = outputVersion;
  const beforeCliMove = cliOutputVersion;
  cliTerminal.write('\x01');
  socket.send(JSON.stringify({ type: 'input', data: '\x01' }));
  await waitFor(() => outputVersion > beforeMove, 'Ctrl+A cursor movement');
  await waitForCli(() => cliOutputVersion > beforeCliMove, 'Ctrl+A cursor movement');
  const beforeInsert = outputVersion;
  const beforeCliInsert = cliOutputVersion;
  cliTerminal.write('X');
  socket.send(JSON.stringify({ type: 'input', data: 'X' }));
  await waitFor(() => outputVersion > beforeInsert, 'text insertion after Ctrl+A');
  await waitForCli(() => cliOutputVersion > beforeCliInsert, 'text insertion after Ctrl+A');
  await new Promise(resolveWait => setTimeout(resolveWait, 100));
  assert.equal(output, cliOutput, 'web and CLI Ctrl+A cursor movement should match');
  assert(output.includes('Xdemo'), 'Ctrl+A should move the input cursor to the beginning');
  console.log('PASS Ctrl+A moves the search cursor to the beginning');

  cliTerminal.write('\x03');
  socket.send(JSON.stringify({ type: 'input', data: '\x03' }));
  await waitFor(() => messages.some(message => message.type === 'exit'), 'clean TUI exit');
  await waitForCli(() => cliExited, 'clean TUI exit');
  await new Promise(resolveWait => setTimeout(resolveWait, 100));
  assert.equal(output, cliOutput, 'web and CLI exit terminal output should match');
  console.log('PASS CLI and WebSocket exit output match');
} finally {
  clearTimeout(timer);
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  if (cliTerminal && !cliExited) {
    cliTerminal.write('\x03');
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
    if (!cliExited) cliTerminal.kill();
  }
  await stopOwnedServer();
}
