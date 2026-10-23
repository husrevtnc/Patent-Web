import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPatentArgs, clipboardShortcut, isSameOrigin, terminalDimensions, terminalFontSize } from './web-config.mjs';

test('web TUI follows the normal CLI defaults', () => {
  assert.deepEqual(buildPatentArgs({}), []);
});

test('web-only options are translated to the same CLI flags', () => {
  assert.deepEqual(buildPatentArgs({
    PATENT_WEB_FAST: '1',
    PATENT_WEB_KEYWORD_ONLY: '1',
    PATENT_WEB_SOURCES: 'npm,github',
    PATENT_WEB_EXCLUDE: 'pypi',
  }), ['--fast', '--keyword-only', '--sources', 'npm,github', '--exclude', 'pypi']);
});

test('terminal dimensions use defaults and clamp untrusted values', () => {
  assert.deepEqual(terminalDimensions(new URLSearchParams()), { cols: 100, rows: 36 });
  assert.deepEqual(terminalDimensions(new URLSearchParams('cols=&rows=')), { cols: 100, rows: 36 });
  assert.deepEqual(terminalDimensions(new URLSearchParams('cols=999&rows=1')), { cols: 300, rows: 1 });
  assert.deepEqual(terminalDimensions(new URLSearchParams('cols=1&rows=1')), { cols: 1, rows: 1 });
  assert.deepEqual(terminalDimensions(new URLSearchParams('cols=bad&rows=40.9')), { cols: 100, rows: 40 });
});

test('websocket origin validation rejects invalid and cross-site origins safely', () => {
  assert.equal(isSameOrigin('http://localhost:4173', 'localhost:4173'), true);
  assert.equal(isSameOrigin('https://attacker.example', 'localhost:4173'), false);
  assert.equal(isSameOrigin('not an origin', 'localhost:4173'), false);
  assert.equal(isSameOrigin(undefined, 'localhost:4173'), true);
});

test('terminal font scales down on small viewports and matches the reference at desktop size', () => {
  assert.equal(terminalFontSize(1200, 720), 18);
  assert.equal(terminalFontSize(900, 720), 16);
  assert.equal(terminalFontSize(390, 844), 14);
  assert.equal(terminalFontSize(1200, 500), 14);
});

test('Ctrl+C and Ctrl+V use browser clipboard actions instead of terminal control keys', () => {
  assert.equal(clipboardShortcut({ type: 'keydown', key: 'c', ctrlKey: true }), 'copy');
  assert.equal(clipboardShortcut({ type: 'keydown', key: 'v', ctrlKey: true }), 'paste');
  assert.equal(clipboardShortcut({ type: 'keydown', key: 'c', metaKey: true }), 'copy');
  assert.equal(clipboardShortcut({ type: 'keydown', key: 'v', metaKey: true }), 'paste');
  assert.equal(clipboardShortcut({ type: 'keyup', key: 'c', ctrlKey: true }), null);
  assert.equal(clipboardShortcut({ type: 'keydown', key: 'v', ctrlKey: true, altKey: true }), null);
  assert.equal(clipboardShortcut({ type: 'keydown', key: 'a', ctrlKey: true }), 'home');
});
