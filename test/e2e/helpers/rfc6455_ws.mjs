import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { URL } from 'node:url';

export const RFC6455_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OPCODES = {
  CONTINUATION: 0x00,
  TEXT: 0x01,
  BINARY: 0x02,
  CLOSE: 0x08,
  PING: 0x09,
  PONG: 0x0a,
};

export const READY_STATES = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
};

/**
 * Computes the RFC 6455 Sec-WebSocket-Accept header value from Sec-WebSocket-Key.
 * @param {string} secWebSocketKey
 * @returns {string}
 */
export function computeAcceptKey(secWebSocketKey) {
  return crypto
    .createHash('sha1')
    .update(String(secWebSocketKey).trim() + RFC6455_GUID)
    .digest('base64');
}

/**
 * Encodes an RFC 6455 WebSocket frame.
 * Supports 7-bit (<126), 16-bit (126..65535), and 64-bit (>65535) payload lengths,
 * optional 4-byte XOR masking (mandatory for client->server frames), and FIN control.
 *
 * @param {object} opts
 * @param {number} [opts.opcode=0x01]
 * @param {Buffer|string|Uint8Array} [opts.payload=Buffer.alloc(0)]
 * @param {boolean} [opts.mask=false]
 * @param {Buffer} [opts.maskKey]
 * @param {boolean} [opts.fin=true]
 * @returns {Buffer}
 */
export function encodeFrame({
  opcode = OPCODES.TEXT,
  payload = Buffer.alloc(0),
  mask = false,
  maskKey = null,
  fin = true,
} = {}) {
  const payloadBuf = Buffer.isBuffer(payload)
    ? payload
    : typeof payload === 'string'
      ? Buffer.from(payload, 'utf8')
      : Buffer.from(payload);

  const len = payloadBuf.length;
  const firstByte = (fin ? 0x80 : 0x00) | (opcode & 0x0f);
  const maskBit = mask ? 0x80 : 0x00;

  let headerLen = 2;
  if (len >= 126 && len <= 0xffff) {
    headerLen += 2;
  } else if (len > 0xffff) {
    headerLen += 8;
  }

  const keyBuf = mask ? (Buffer.isBuffer(maskKey) && maskKey.length === 4 ? maskKey : crypto.randomBytes(4)) : null;
  if (mask) {
    headerLen += 4;
  }

  const frame = Buffer.allocUnsafe(headerLen + len);
  frame[0] = firstByte;

  let offset = 2;
  if (len < 126) {
    frame[1] = maskBit | len;
  } else if (len <= 0xffff) {
    frame[1] = maskBit | 126;
    frame.writeUInt16BE(len, 2);
    offset = 4;
  } else {
    frame[1] = maskBit | 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
    offset = 10;
  }

  if (mask && keyBuf) {
    keyBuf.copy(frame, offset);
    offset += 4;
    for (let i = 0; i < len; i++) {
      frame[offset + i] = payloadBuf[i] ^ keyBuf[i & 3];
    }
  } else if (len > 0) {
    payloadBuf.copy(frame, offset);
  }

  return frame;
}

/**
 * Decodes as many complete RFC 6455 frames as possible from a Buffer.
 * Returns { frames, remaining } to handle arbitrarily split or coalesced TCP chunks.
 *
 * @param {Buffer} buffer
 * @returns {{ frames: Array<{ fin: boolean, opcode: number, masked: boolean, payload: Buffer }>, remaining: Buffer }}
 */
export function decodeFramesFromBuffer(buffer) {
  const frames = [];
  let buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  while (buf.length >= 2) {
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    const len7 = b1 & 0x7f;

    let offset = 2;
    let payloadLen = len7;

    if (len7 === 126) {
      if (buf.length < 4) break;
      payloadLen = buf.readUInt16BE(2);
      offset = 4;
    } else if (len7 === 127) {
      if (buf.length < 10) break;
      payloadLen = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }

    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) break;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + payloadLen) {
      break;
    }

    const payload = Buffer.from(buf.subarray(offset, offset + payloadLen));
    if (masked && maskKey) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= maskKey[i & 3];
      }
    }

    frames.push({
      fin,
      opcode,
      masked,
      payload,
    });

    buf = buf.subarray(offset + payloadLen);
  }

  return { frames, remaining: buf };
}

/**
 * RFC 6455 WebSocket connection wrapper used by both Rfc6455Server and Rfc6455Client.
 */
export class Rfc6455Socket extends EventEmitter {
  static CONNECTING = READY_STATES.CONNECTING;
  static OPEN = READY_STATES.OPEN;
  static CLOSING = READY_STATES.CLOSING;
  static CLOSED = READY_STATES.CLOSED;

  constructor(socket, { isServer = false, headers = {}, url = '' } = {}) {
    super();
    this.CONNECTING = READY_STATES.CONNECTING;
    this.OPEN = READY_STATES.OPEN;
    this.CLOSING = READY_STATES.CLOSING;
    this.CLOSED = READY_STATES.CLOSED;

    this._socket = socket;
    this._isServer = isServer;
    this.headers = headers;
    this.url = url;
    this.readyState = socket ? READY_STATES.OPEN : READY_STATES.CONNECTING;

    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOpcode = 0;
    this._closeEmitted = false;
    this._closeCode = 1000;
    this._closeReason = '';

    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;

    if (socket) {
      this._attachSocket(socket);
    }
  }

  _attachSocket(socket, head = null) {
    this._socket = socket;
    if (typeof socket.setNoDelay === 'function') {
      socket.setNoDelay(true);
    }

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => {
      if (typeof this.onerror === 'function') {
        try {
          this.onerror(err);
        } catch {
          // ignore user handler error
        }
      }
      if (this.listenerCount('error') > 0) {
        this.emit('error', err);
      }
    });
    socket.on('close', () => {
      this.readyState = READY_STATES.CLOSED;
      this._emitClose(this._closeCode || 1000, this._closeReason || '');
    });
    socket.on('end', () => {
      if (this.readyState !== READY_STATES.CLOSED) {
        this.readyState = READY_STATES.CLOSED;
        this._emitClose(this._closeCode || 1000, this._closeReason || '');
      }
    });

    if (head && head.length > 0) {
      this._onData(head);
    }
  }

  _emitClose(code, reason) {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    if (typeof this.onclose === 'function') {
      try {
        this.onclose({ code, reason });
      } catch {
        // ignore
      }
    }
    this.emit('close', code, reason);
  }

  _onData(chunk) {
    this._buffer = this._buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this._buffer, chunk]);
    const { frames, remaining } = decodeFramesFromBuffer(this._buffer);
    this._buffer = remaining;

    for (const frame of frames) {
      this._handleFrame(frame);
    }
  }

  _handleFrame(frame) {
    const { fin, opcode, payload } = frame;

    if (opcode === OPCODES.PING) {
      if (this.readyState === READY_STATES.OPEN) {
        this.pong(payload);
      }
      this.emit('ping', payload);
      return;
    }

    if (opcode === OPCODES.PONG) {
      this.emit('pong', payload);
      return;
    }

    if (opcode === OPCODES.CLOSE) {
      let code = 1000;
      let reason = '';
      if (payload.length >= 2) {
        code = payload.readUInt16BE(0);
        reason = payload.subarray(2).toString('utf8');
      }
      this._closeCode = code;
      this._closeReason = reason;

      if (this.readyState === READY_STATES.OPEN) {
        this.readyState = READY_STATES.CLOSING;
        const replyPayload = Buffer.allocUnsafe(2);
        replyPayload.writeUInt16BE(code, 0);
        const closeFrame = encodeFrame({
          opcode: OPCODES.CLOSE,
          payload: replyPayload,
          mask: !this._isServer,
        });
        try {
          this._socket.write(closeFrame, () => {
            this._socket.end();
          });
        } catch {
          this._socket.destroy();
        }
      } else if (this._socket) {
        this._socket.end();
      }
      this.readyState = READY_STATES.CLOSED;
      this._emitClose(code, reason);
      return;
    }

    if (opcode === OPCODES.TEXT || opcode === OPCODES.BINARY) {
      if (!fin) {
        this._fragmentOpcode = opcode;
        this._fragments = [payload];
        return;
      }
      this._deliverData(opcode, payload);
      return;
    }

    if (opcode === OPCODES.CONTINUATION) {
      this._fragments.push(payload);
      if (fin) {
        const fullPayload = Buffer.concat(this._fragments);
        const finalOpcode = this._fragmentOpcode || OPCODES.TEXT;
        this._fragments = [];
        this._fragmentOpcode = 0;
        this._deliverData(finalOpcode, fullPayload);
      }
    }
  }

  _deliverData(opcode, payload) {
    const data = opcode === OPCODES.TEXT ? payload.toString('utf8') : payload;
    if (typeof this.onmessage === 'function') {
      try {
        this.onmessage({ data, type: opcode === OPCODES.TEXT ? 'text' : 'binary' });
      } catch {
        // ignore
      }
    }
    this.emit('message', data, opcode === OPCODES.BINARY);
  }

  /**
   * Sends a text or binary message over the WebSocket.
   * @param {string|Buffer|Uint8Array} data
   * @param {function} [cb]
   */
  send(data, cb) {
    if (this.readyState !== READY_STATES.OPEN || !this._socket) {
      const err = new Error('WebSocket is not open');
      if (typeof cb === 'function') cb(err);
      return false;
    }

    const isText = typeof data === 'string';
    const opcode = isText ? OPCODES.TEXT : OPCODES.BINARY;
    const payload = isText ? Buffer.from(data, 'utf8') : Buffer.from(data);
    const frame = encodeFrame({
      opcode,
      payload,
      mask: !this._isServer,
      fin: true,
    });

    return this._socket.write(frame, cb);
  }

  /**
   * Serializes and sends a JSON payload.
   * @param {any} obj
   * @param {function} [cb]
   */
  sendJson(obj, cb) {
    return this.send(JSON.stringify(obj), cb);
  }

  /**
   * Sends a fragmented message across multiple RFC 6455 frames for testing fragmentation.
   * @param {Array<string|Buffer>} chunks
   * @param {number} [opcode=OPCODES.TEXT]
   */
  sendFragmented(chunks, opcode = OPCODES.TEXT) {
    if (this.readyState !== READY_STATES.OPEN || !this._socket) {
      throw new Error('WebSocket is not open');
    }
    for (let i = 0; i < chunks.length; i++) {
      const isFirst = i === 0;
      const isLast = i === chunks.length - 1;
      const frame = encodeFrame({
        opcode: isFirst ? opcode : OPCODES.CONTINUATION,
        payload: typeof chunks[i] === 'string' ? Buffer.from(chunks[i], 'utf8') : chunks[i],
        mask: !this._isServer,
        fin: isLast,
      });
      this._socket.write(frame);
    }
  }

  ping(data = Buffer.alloc(0)) {
    if (this.readyState !== READY_STATES.OPEN || !this._socket) return;
    const frame = encodeFrame({
      opcode: OPCODES.PING,
      payload: typeof data === 'string' ? Buffer.from(data, 'utf8') : data,
      mask: !this._isServer,
    });
    this._socket.write(frame);
  }

  pong(data = Buffer.alloc(0)) {
    if (this.readyState !== READY_STATES.OPEN || !this._socket) return;
    const frame = encodeFrame({
      opcode: OPCODES.PONG,
      payload: typeof data === 'string' ? Buffer.from(data, 'utf8') : data,
      mask: !this._isServer,
    });
    this._socket.write(frame);
  }

  close(code = 1000, reason = '') {
    if (this.readyState === READY_STATES.CLOSED || this.readyState === READY_STATES.CLOSING) {
      return;
    }
    this.readyState = READY_STATES.CLOSING;
    this._closeCode = code;
    this._closeReason = reason;

    if (!this._socket) {
      this.readyState = READY_STATES.CLOSED;
      this._emitClose(code, reason);
      return;
    }

    const reasonBuf = Buffer.from(String(reason || ''), 'utf8');
    const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);

    const frame = encodeFrame({
      opcode: OPCODES.CLOSE,
      payload,
      mask: !this._isServer,
    });

    try {
      this._socket.write(frame, () => {
        if (this._socket) {
          this._socket.end();
        }
      });
    } catch {
      if (this._socket) {
        this._socket.destroy();
      }
    }
  }

  terminate() {
    this.readyState = READY_STATES.CLOSED;
    if (this._socket) {
      this._socket.destroy();
    }
    this._emitClose(1006, 'Terminated');
  }
}

/**
 * RFC 6455 WebSocket Server that attaches to an existing Node.js http.Server
 * or manages HTTP upgrade handshakes directly.
 */
export class Rfc6455Server extends EventEmitter {
  constructor({ server = null, pathMatcher = null, verifyClient = null } = {}) {
    super();
    this.clients = new Set();
    this.pathMatcher = pathMatcher;
    this.verifyClient = verifyClient;
    if (server) {
      this.attach(server);
    }
  }

  attach(httpServer) {
    this._httpServer = httpServer;
    this._onUpgrade = (req, socket, head) => {
      if (typeof this.pathMatcher === 'function') {
        const parsed = new URL(req.url || '/', 'http://127.0.0.1');
        if (!this.pathMatcher(parsed.pathname, req)) {
          socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
      }
      if (typeof this.verifyClient === 'function') {
        const result = this.verifyClient(req);
        if (result && result.allowed === false) {
          const status = result.statusCode || 401;
          const statusText = status === 403 ? 'Forbidden' : 'Unauthorized';
          socket.write(`HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\n\r\n`);
          socket.destroy();
          return;
        }
      }
      this.handleUpgrade(req, socket, head, (ws) => {
        this.emit('connection', ws, req);
      });
    };
    httpServer.on('upgrade', this._onUpgrade);
  }

  handleUpgrade(req, socket, head, callback) {
    const upgradeHeader = String(req.headers.upgrade || '').toLowerCase();
    const key = req.headers['sec-websocket-key'];
    if (upgradeHeader !== 'websocket' || !key) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const acceptKey = computeAcceptKey(key);
    const responseHeaders = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '\r\n',
    ].join('\r\n');

    socket.write(responseHeaders);
    const ws = new Rfc6455Socket(null, {
      isServer: true,
      headers: req.headers,
      url: req.url,
    });
    ws.readyState = READY_STATES.OPEN;
    ws._attachSocket(socket, head);

    this.clients.add(ws);
    ws.on('close', () => {
      this.clients.delete(ws);
    });

    if (typeof callback === 'function') {
      callback(ws, req);
    }
  }

  close() {
    for (const client of this.clients) {
      try {
        client.close(1001, 'Server shutting down');
        client.terminate();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
  }
}

/**
 * RFC 6455 WebSocket Client built strictly on Node.js http.request.
 */
export class Rfc6455Client extends Rfc6455Socket {
  constructor(url, options = {}) {
    super(null, { isServer: false, url: String(url) });
    this.readyState = READY_STATES.CONNECTING;
    this._options = options || {};
    this._connect(String(url), this._options);
  }

  _connect(urlStr, options) {
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch (err) {
      queueMicrotask(() => this.emit('error', err));
      return;
    }

    const key = crypto.randomBytes(16).toString('base64');
    const expectedAccept = computeAcceptKey(key);
    const headers = {
      ...(options.headers || {}),
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': key,
    };

    const req = http.request({
      hostname: parsed.hostname || '127.0.0.1',
      port: parsed.port || 80,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      headers,
      timeout: options.handshakeTimeout || 5000,
    });

    this._req = req;

    req.on('upgrade', (res, socket, head) => {
      const accept = res.headers['sec-websocket-accept'];
      if (accept !== expectedAccept) {
        const err = new Error(`Invalid Sec-WebSocket-Accept header: expected ${expectedAccept}, got ${accept}`);
        socket.destroy();
        this.readyState = READY_STATES.CLOSED;
        this.emit('error', err);
        return;
      }

      this.readyState = READY_STATES.OPEN;
      this._attachSocket(socket, head);
      if (typeof this.onopen === 'function') {
        try {
          this.onopen({ target: this });
        } catch {
          // ignore
        }
      }
      this.emit('open');
    });

    req.on('response', (res) => {
      // Server did not upgrade (e.g. 401, 403, 404)
      res.resume();
      this.readyState = READY_STATES.CLOSED;
      if (this.listenerCount('unexpected-response') > 0) {
        this.emit('unexpected-response', req, res);
      } else {
        const err = new Error(`Unexpected server response: ${res.statusCode}`);
        err.statusCode = res.statusCode;
        this.emit('error', err);
      }
      this._emitClose(1006, `HTTP ${res.statusCode}`);
    });

    req.on('timeout', () => {
      req.destroy(new Error('WebSocket handshake timeout'));
    });

    req.on('error', (err) => {
      this.readyState = READY_STATES.CLOSED;
      if (typeof this.onerror === 'function') {
        try {
          this.onerror(err);
        } catch {
          // ignore
        }
      }
      if (this.listenerCount('error') > 0) {
        this.emit('error', err);
      }
      this._emitClose(1006, err.message);
    });

    req.end();
  }
}

export { Rfc6455Client as WebSocket, Rfc6455Server as WebSocketServer };
export default Rfc6455Client;
