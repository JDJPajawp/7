import { NextRequest, NextResponse } from 'next/server';
import WebSocket from 'ws';
import * as net from 'net';
import * as http from 'http';

interface GatewaySession {
  ws: WebSocket | null;
  heartbeatTimer: NodeJS.Timeout | null;
  token: string;
  tokenType: 'bot' | 'user';
  isConnecting: boolean;
  sessionId: string | null;
  resumeGatewayUrl: string | null;
  lastSeq: number | null;
  fatalClose: boolean;
  proxy: string | null;
}

declare global {
  var activeSessions: Map<string, GatewaySession>;
  var gatewayLogs: Array<{ id: string; timestamp: string; type: 'info' | 'success' | 'error' | 'warn'; text: string }>;
}

if (!global.activeSessions) global.activeSessions = new Map();
if (!global.gatewayLogs) global.gatewayLogs = [];

const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const DEFAULT_GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';

function addLog(text: string, type: 'info' | 'success' | 'error' | 'warn' = 'info') {
  const now = new Date();
  const ts = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');
  global.gatewayLogs.push({ id: Math.random().toString(36).substring(2, 9), timestamp: ts, type, text });
  if (global.gatewayLogs.length > 200) global.gatewayLogs.shift();
}

interface ProxyConfig { type: 'socks5' | 'http'; host: string; port: number; username?: string; password?: string; }

function parseProxy(proxyUrl: string): ProxyConfig {
  const url = new URL(proxyUrl);
  const scheme = url.protocol.replace(':', '');
  return {
    type: scheme === 'socks5' ? 'socks5' : 'http',
    host: url.hostname,
    port: parseInt(url.port, 10),
    username: url.username || undefined,
    password: url.password || undefined,
  };
}

function socks5Connect(proxy: ProxyConfig, targetHost: string, targetPort: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(proxy.port, proxy.host, () => {
      const greeting = proxy.username
        ? Buffer.from([0x05, 0x02, 0x00, 0x02])
        : Buffer.from([0x05, 0x01, 0x00]);
      socket.write(greeting);
      socket.once('data', (data) => {
        if (data[0] !== 0x05) return reject(new Error('SOCKS5: bad version'));
        if (data[1] === 0xff) return reject(new Error('SOCKS5: no acceptable method'));
        if (data[1] === 0x02) {
          const user = Buffer.from(proxy.username || '');
          const pass = Buffer.from(proxy.password || '');
          const auth = Buffer.alloc(3 + user.length + pass.length);
          auth[0] = 0x01; auth[1] = user.length; user.copy(auth, 2);
          auth[2 + user.length] = pass.length; pass.copy(auth, 3 + user.length);
          socket.write(auth);
          socket.once('data', (r) => {
            if (r[1] !== 0x00) return reject(new Error('SOCKS5: auth failed'));
            sendConnect();
          });
        } else { sendConnect(); }
        function sendConnect() {
          const host = Buffer.from(targetHost);
          const req = Buffer.alloc(7 + host.length);
          req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03;
          req[4] = host.length; host.copy(req, 5);
          req.writeUInt16BE(targetPort, 5 + host.length);
          socket.write(req);
          socket.once('data', (r) => {
            if (r[1] !== 0x00) return reject(new Error(`SOCKS5: connect failed (${r[1]})`));
            resolve(socket);
          });
        }
      });
    });
    socket.setTimeout(10000);
    socket.on('timeout', () => reject(new Error('SOCKS5: timeout')));
    socket.on('error', reject);
  });
}

function httpTunnelConnect(proxy: ProxyConfig, targetHost: string, targetPort: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: proxy.username
        ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}` }
        : {},
    });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('HTTP CONNECT: timeout')); });
    req.on('connect', (_res, socket) => resolve(socket));
    req.on('error', reject);
    req.end();
  });
}

async function createProxiedWS(gatewayUrl: string, proxyUrl: string): Promise<WebSocket> {
  const proxy = parseProxy(proxyUrl);
  const url = new URL(gatewayUrl);

  const tcpSocket = proxy.type === 'socks5'
    ? await socks5Connect(proxy, url.hostname, 443)
    : await httpTunnelConnect(proxy, url.hostname, 443);

  // TCPソケットをそのまま渡す。wsがTLSハンドシェイクを自分でやる
  return new WebSocket(gatewayUrl, {
    socket: tcpSocket,
  } as any);
}

function connectGateway(token: string, tokenType: 'bot' | 'user', resume = false, delayMs = 0, proxy: string | null = null) {
  if (global.activeSessions.has(token)) {
    const ex = global.activeSessions.get(token)!;
    if (ex.ws && ex.ws.readyState === WebSocket.OPEN) {
      addLog(`Session already active [${token.substring(0, 6)}...]. skip.`, 'info');
      return;
    }
    try { ex.ws?.terminate(); } catch (_) {}
    if (ex.heartbeatTimer) clearInterval(ex.heartbeatTimer);
  }

  if (delayMs > 0) {
    addLog(`[${token.substring(0, 6)}...] Reconnect in ${delayMs}ms...`, 'warn');
    setTimeout(() => connectGateway(token, tokenType, resume, 0, proxy), delayMs);
    return;
  }

  const prev = global.activeSessions.get(token);
  const proxyToUse = proxy ?? prev?.proxy ?? null;

  const session: GatewaySession = {
    ws: null, heartbeatTimer: null, token, tokenType, isConnecting: true,
    sessionId: (resume && prev?.sessionId) || null,
    resumeGatewayUrl: (resume && prev?.resumeGatewayUrl) || null,
    lastSeq: (resume && prev?.lastSeq) || null,
    fatalClose: false,
    proxy: proxyToUse,
  };
  global.activeSessions.set(token, session);

  const gatewayUrl = resume && session.resumeGatewayUrl
    ? `${session.resumeGatewayUrl}?v=10&encoding=json`
    : DEFAULT_GATEWAY;

  addLog(`[${token.substring(0, 6)}...] Connecting${resume ? ' (RESUME)' : ''}${proxyToUse ? ' via proxy' : ''}`, 'info');

  const wsPromise = proxyToUse
    ? createProxiedWS(gatewayUrl, proxyToUse)
    : Promise.resolve(new WebSocket(gatewayUrl));

  wsPromise.then((ws) => {
    session.ws = ws;

    ws.on('open', () => {
      session.isConnecting = false;
      addLog(`[${token.substring(0, 6)}...] WS connected.`, 'success');
    });

    ws.on('message', (raw: WebSocket.RawData, isBinary: boolean) => {
      try {
        const str = isBinary
          ? (Buffer.isBuffer(raw) ? raw.toString('utf8') : Buffer.from(raw as ArrayBuffer).toString('utf8'))
          : raw.toString();
        const packet = JSON.parse(str);
        const { t, s, op, d } = packet;
        if (s !== null && s !== undefined) session.lastSeq = s;

        if (op === 10) {
          const interval: number = d.heartbeat_interval;
          addLog(`[${token.substring(0, 6)}...] HELLO: heartbeat ${interval}ms`, 'info');
          if (session.heartbeatTimer) clearInterval(session.heartbeatTimer);
          session.heartbeatTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 1, d: session.lastSeq }));
          }, interval);

          if (resume && session.sessionId && session.lastSeq !== null) {
            addLog(`[${token.substring(0, 6)}...] Sending RESUME (Op 6)...`, 'info');
            ws.send(JSON.stringify({ op: 6, d: { token: tokenType === 'bot' ? `Bot ${token}` : token, session_id: session.sessionId, seq: session.lastSeq } }));
          } else {
            addLog(`[${token.substring(0, 6)}...] Sending IDENTIFY (Op 2)...`, 'info');
            const presences = ['online', 'idle', 'dnd'];
            const presence = presences[Math.floor(Math.random() * presences.length)];
            ws.send(JSON.stringify({
              op: 2,
              d: {
                token: tokenType === 'bot' ? `Bot ${token}` : token,
                intents: 0,
                properties: {
                  os: 'Windows', browser: 'Chrome', device: '',
                  system_locale: 'ja',
                  browser_user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                  browser_version: '124.0.0.0', os_version: '10',
                  release_channel: 'stable', client_build_number: 305412,
                },
                presence: { status: presence, since: 0, activities: [], afk: false },
              },
            }));
          }
        }

        if (op === 9) {
          addLog(`[${token.substring(0, 6)}...] Invalid Session (resumable=${d})`, 'warn');
          session.sessionId = null; session.lastSeq = null;
          ws.close();
          connectGateway(token, tokenType, d === true, 5000, proxyToUse);
          return;
        }

        if (op === 7) {
          addLog(`[${token.substring(0, 6)}...] RECONNECT (Op 7), resuming...`, 'warn');
          ws.close();
          connectGateway(token, tokenType, true, 2000, proxyToUse);
          return;
        }

        if (t === 'READY') {
          session.sessionId = d.session_id;
          session.resumeGatewayUrl = d.resume_gateway_url || null;
          addLog(`[${token.substring(0, 6)}...] READY: ${d.user.username} | session=${d.session_id.substring(0, 8)}...`, 'success');
        }

        if (t === 'RESUMED') {
          addLog(`[${token.substring(0, 6)}...] RESUMED successfully.`, 'success');
        }
      } catch (err: any) {
        addLog(`[${token.substring(0, 6)}...] Parse error: ${err.message}`, 'error');
      }
    });

    ws.on('error', (err: Error) => {
      addLog(`[${token.substring(0, 6)}...] WS Error: ${err.message}`, 'error');
    });

    ws.on('close', (code: number, reason: Buffer) => {
      if (session.heartbeatTimer) clearInterval(session.heartbeatTimer);
      addLog(`[${token.substring(0, 6)}...] CLOSED: ${code} "${reason.toString() || 'none'}"`, 'warn');
      if (FATAL_CLOSE_CODES.has(code)) {
        session.fatalClose = true;
        global.activeSessions.delete(token);
        addLog(`[${token.substring(0, 6)}...] Fatal close ${code}. Token may be invalid/banned.`, 'error');
        return;
      }
      if (!global.activeSessions.has(token)) return;
      const delay = code === 4008 ? 15000 : 5000;
      connectGateway(token, tokenType, code === 4009, delay, proxyToUse);
    });
  }).catch((err) => {
    addLog(`[${token.substring(0, 6)}...] Proxy/WS connect failed: ${err.message}`, 'error');
    global.activeSessions.delete(token);
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action, token, tokens, tokenType, tokenProxyPairs } = body;

    if (action === 'connect') {
      const target: string | undefined = token || (Array.isArray(tokens) ? tokens[0] : undefined);
      if (!target) return NextResponse.json({ error: 'Token is required' }, { status: 400 });
      connectGateway(target, tokenType || 'user', false, 0, null);
      return NextResponse.json({ success: true, message: 'Gateway connection initiated', activeCount: global.activeSessions.size });
    }

    if (action === 'connectAll') {
      if (!Array.isArray(tokens) || tokens.length === 0) return NextResponse.json({ error: 'tokens[] required' }, { status: 400 });
      const pairs: { token: string; proxy: string | null }[] = Array.isArray(tokenProxyPairs)
        ? tokenProxyPairs
        : tokens.map((t: string) => ({ token: t, proxy: null }));
      pairs.forEach(({ token: t, proxy }, i) => {
        const delay = i * (800 + Math.floor(Math.random() * 400));
        setTimeout(() => connectGateway(t, tokenType || 'user', false, 0, proxy), delay);
      });
      return NextResponse.json({ success: true, message: `Connecting ${pairs.length} token(s) with stagger`, activeCount: global.activeSessions.size });
    }

    if (action === 'logs') {
      return NextResponse.json({
        logs: global.gatewayLogs || [],
        activeSessionsCount: global.activeSessions.size,
        activeSessions: Array.from(global.activeSessions.keys()).map((t) => ({
          prefix: t.substring(0, 10) + '...',
          connected: global.activeSessions.get(t)?.ws?.readyState === WebSocket.OPEN,
          sessionId: global.activeSessions.get(t)?.sessionId?.substring(0, 8) ?? null,
          lastSeq: global.activeSessions.get(t)?.lastSeq ?? null,
          proxy: global.activeSessions.get(t)?.proxy ? '✓' : null,
        })),
      });
    }

    if (action === 'disconnect') {
      if (!token) return NextResponse.json({ error: 'Token is required' }, { status: 400 });
      const sess = global.activeSessions.get(token);
      if (sess) {
        try { sess.ws?.terminate(); } catch (_) {}
        if (sess.heartbeatTimer) clearInterval(sess.heartbeatTimer);
        global.activeSessions.delete(token);
      }
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 });
  }
    }
