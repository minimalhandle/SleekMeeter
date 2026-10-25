'use strict';
// A tiny WebSocket client (RFC 6455, text frames only) so the plugin needs no npm packages.
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

class Socket extends EventEmitter {
  constructor(url) {
    super();
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    this.buf = Buffer.alloc(0);
    this.frag = [];
    this.open = false;
    const req = http.request({
      host: u.hostname, port: u.port || 80, path: u.pathname + u.search,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' },
    });
    req.on('upgrade', (res, sock, head) => {
      this.sock = sock;
      this.open = true;
      sock.on('data', (d) => this.onData(d));
      sock.on('close', () => { this.open = false; this.emit('close'); });
      sock.on('error', (e) => this.emit('error', e));
      this.emit('open');
      if (head && head.length) this.onData(head);
    });
    req.on('error', (e) => this.emit('error', e));
    req.on('response', () => this.emit('error', new Error('WebSocket upgrade refused')));
    req.end();
  }

  send(text) {
    if (!this.open) return;
    const data = Buffer.from(text, 'utf8');
    this.frame(0x1, data);
  }

  frame(op, data) {
    const n = data.length;
    let head;
    if (n < 126) head = Buffer.from([0x80 | op, 0x80 | n]);
    else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 0x80 | 126; head.writeUInt16BE(n, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(n), 2); }
    const mask = crypto.randomBytes(4);
    const out = Buffer.alloc(n);
    for (let i = 0; i < n; i++) out[i] = data[i] ^ mask[i & 3];
    this.sock.write(Buffer.concat([head, mask, out]));
  }

  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const op = b[0] & 0x0f;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      const masked = (b[1] & 0x80) !== 0;
      if (masked) off += 4;
      if (b.length < off + len) return;
      let payload = b.subarray(off, off + len);
      if (masked) {
        const m = b.subarray(off - 4, off);
        payload = Buffer.from(payload.map((v, i) => v ^ m[i & 3]));
      } else payload = Buffer.from(payload);
      this.buf = b.subarray(off + len);
      if (op === 0x8) { this.close(); return; }
      if (op === 0x9) { this.frame(0xA, payload); continue; }
      if (op === 0xA) continue;
      this.frag.push(payload);
      if (fin) {
        const text = Buffer.concat(this.frag).toString('utf8');
        this.frag = [];
        this.emit('message', text);
      }
    }
  }

  close() {
    if (this.sock) { try { this.sock.end(); } catch (_) { /* already closed */ } }
  }
}

module.exports = { Socket };
