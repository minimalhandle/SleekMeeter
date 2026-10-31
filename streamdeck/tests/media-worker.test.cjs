// Windows integration regression: polling must work while stdin stays open and idle.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

test('media worker emits repeated frames without receiving a command', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
    path.join(__dirname, '../com.minimalhandle.sleekmeeter.sdPlugin/bin/media-session.ps1')],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let frames = 0;
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Media polling stalled with idle stdin')), 10000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { if (frames < 3) { clearTimeout(timeout); reject(new Error(`Worker exited early: ${code}`)); } });
      child.stderr.resume();
      child.stdout.on('data', chunk => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const frame = JSON.parse(line);
            assert.equal(typeof frame.players.spotify.available, 'boolean');
            assert.equal(typeof frame.players.auto.available, 'boolean');
            if (++frames >= 3) { clearTimeout(timeout); resolve(); }
          } catch (error) { clearTimeout(timeout); reject(error); }
        }
      });
    });
  } finally {
    child.stdin.end();
    const kill = setTimeout(() => child.kill(), 1500);
    await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    clearTimeout(kill);
  }
});
