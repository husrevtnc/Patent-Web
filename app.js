import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { clipboardShortcut, terminalFontSize } from './web-config.mjs';

const container = document.querySelector('#terminal');
const terminal = new Terminal({
  allowProposedApi: false,
  convertEol: false,
  cursorBlink: true,
  cursorStyle: 'block',
  fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", "DejaVu Sans Mono", monospace',
  fontSize: 18,
  lineHeight: 1,
  scrollback: 0,
  macOptionClickForcesSelection: true,
  theme: {
    background: '#1d1e29',
    foreground: '#f8f8f2',
    cursor: '#f8f8f2',
    cursorAccent: '#1d1e29',
    selectionBackground: '#44475a',
    black: '#21222c',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#f8f8f2',
    brightBlack: '#6272a4',
    brightRed: '#ff6e6e',
    brightGreen: '#69ff94',
    brightYellow: '#ffffa5',
    brightBlue: '#d6acff',
    brightMagenta: '#ff92df',
    brightCyan: '#a4ffff',
    brightWhite: '#ffffff',
  },
});
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open(container);

let socket;

function sendResize(cols = terminal.cols, rows = terminal.rows) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'resize', cols, rows }));
  }
}

function fitTerminal() {
  const width = container.clientWidth;
  const height = container.clientHeight;
  const fontSize = terminalFontSize(width, height);
  if (terminal.options.fontSize !== fontSize) terminal.options.fontSize = fontSize;
  fit.fit();
  sendResize();
}

function copyTerminalSelection() {
  const text = terminal.getSelection();
  if (!text) return;

  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => copyWithTextarea(text));
  } else {
    copyWithTextarea(text);
  }
}

async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard?.readText();
    if (text) terminal.paste(text);
  } catch {
    // Clipboard access can be denied by browser policy; don't send Ctrl+V as a
    // terminal control character in that case.
  }
}

function copyWithTextarea(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function connect() {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const address = `${scheme}//${location.host}/terminal?cols=${terminal.cols}&rows=${terminal.rows}`;
  socket = new WebSocket(address);

  socket.addEventListener('open', () => {
    container.setAttribute('aria-busy', 'false');
    terminal.focus();
    sendResize();
  });

  socket.addEventListener('message', ({ data }) => {
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }

    if (event.type === 'output') terminal.write(event.data);
    if (event.type === 'exit') {
      const status = event.code === 0 ? 'Patent TUI exited. Refresh to start it again.' : `patent exited with code ${event.code}`;
      terminal.write(`\r\n\x1b[90m${status}\x1b[0m\r\n`);
    }
  });

  socket.addEventListener('close', event => {
    if (event.code === 1000) return;
    container.setAttribute('aria-busy', 'false');
    terminal.write('\r\n\x1b[31mConnection to the patent TUI was lost. Refresh to reconnect.\x1b[0m\r\n');
  });

  socket.addEventListener('error', () => {
    container.setAttribute('aria-busy', 'false');
  });
}

window.addEventListener('keydown', event => {
  const shortcut = clipboardShortcut(event);
  if (!shortcut) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (shortcut === 'copy' && terminal.hasSelection()) copyTerminalSelection();
  if (shortcut === 'paste') void pasteFromClipboard();
  if (shortcut === 'home' && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'input', data: '\x01' }));
  }
}, { capture: true });

terminal.attachCustomKeyEventHandler(event => {
  const key = event.key.toLowerCase();
  if (event.type !== 'keydown' || !event.ctrlKey || event.altKey || event.metaKey) return true;
  if (event.key === 'Backspace') {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data: '\x17' }));
    return false;
  }
  return true;
});

terminal.onData(data => {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'input', data }));
  }
});
terminal.onResize(({ cols, rows }) => sendResize(cols, rows));
window.addEventListener('resize', fitTerminal);
window.visualViewport?.addEventListener('resize', fitTerminal);
new ResizeObserver(fitTerminal).observe(container);

fitTerminal();
document.fonts?.ready.then(fitTerminal);
connect();
