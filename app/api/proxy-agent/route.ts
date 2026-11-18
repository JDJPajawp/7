import * as net from 'net';
import * as http from 'http';
import * as https from 'https';
import { NextRequest, NextResponse } from 'next/server';

interface ProxyConfig {
  type: 'socks5' | 'http';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

function parseProxy(proxyUrl: string): ProxyConfig {
  const url = new URL(proxyUrl);
  const type = url.protocol.replace(':', '') as 'socks5' | 'http';
  return {
    type: type === ('https' as any) ? 'http' : type,
    host: url.hostname,
    port: parseInt(url.port, 10),
    username: url.username || undefined,
    password: url.password || undefined,
  };
}

function socks5Connect(proxy: ProxyConfig, targetHost: string, targetPort: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(proxy.port, proxy.host, () => {
      const greeting = proxy.username ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]);
      socket.write(greeting);
      socket.once('data', (data) => {
        if (data[0] !== 0x05) return reject(new Error('SOCKS5: Invalid version'));
        const method = data[1];
        if (method === 0xff) return reject(new Error('SOCKS5: No acceptable auth method'));
        if (method === 0x02) {
          const user = Buffer.from(proxy.username || '');
          const pass = Buffer.from(proxy.password || '');
          const authReq = Buffer.alloc(3 + user.length + pass.length);
          authReq[0] = 0x01; authReq[1] = user.length; user.copy(authReq, 2);
          authReq[2 + user.length] = pass.length; pass.copy(authReq, 3 + user.length);
          socket.write(authReq);
          socket.once('data', (authRes) => { if (authRes[1] !== 0x00) return reject(new Error('SOCKS5: Auth failed')); sendConnect(); });
        } else { sendConnect(); }
        function sendConnect() {
          const hostBuf = Buffer.from(targetHost);
          const req = Buffer.alloc(7 + hostBuf.length);
          req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03;
          req[4] = hostBuf.length; hostBuf.copy(req, 5); req.writeUInt16BE(targetPort, 5 + hostBuf.length);
          socket.write(req);
          socket.once('data', (res) => { if (res[1] !== 0x00) return reject(new Error(`SOCKS5: Connect failed (${res[1]})`)); resolve(socket); });
        }
      });
    });
    socket.setTimeout(10000);
    socket.on('timeout', () => reject(new Error('SOCKS5: Connection timeout')));
    socket.on('error', reject);
  });
}

function httpConnect(proxy: ProxyConfig, targetHost: string, targetPort: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.host, port: proxy.port, method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: proxy.username ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}` } : {},
    });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('HTTP CONNECT: timeout')); });
    req.on('connect', (_res, socket) => { resolve(socket); });
    req.on('error', reject);
    req.end();
  });
}

async function createProxyAgent(proxy: ProxyConfig, targetUrl: string): Promise<https.Agent> {
  const url = new URL(targetUrl);
  const targetHost = url.hostname;
  const targetPort = url.port ? parseInt(url.port) : (url.protocol === 'https:' ? 443 : 80);
  const socket = proxy.type === 'socks5' ? await socks5Connect(proxy, targetHost, targetPort) : await httpConnect(proxy, targetHost, targetPort);
  return new https.Agent({ socket } as any);
}

async function fetchViaProxyInternal(url: string, init: RequestInit, proxyUrl: string, maxRetries = 3): Promise<Response> {
  const proxy = parseProxy(proxyUrl);
  async function attempt(): Promise<Response> {
    const agent = await createProxyAgent(proxy, url);
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const options: https.RequestOptions = {
        hostname: parsedUrl.hostname, port: parsedUrl.port || 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: (init.method as string) || 'GET',
        headers: init.headers as Record<string, string>, agent,
      };
      const req = https.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => { resolve(new Response(Buffer.concat(chunks), { status: res.statusCode || 200, headers: res.headers as Record<string, string> })); });
      });
      req.on('error', reject);
      if (init.body) req.write(init.body as string);
      req.end();
    });
  }
  let res = await attempt();
  for (let i = 0; i < maxRetries && res.status === 429; i++) {
    let waitMs = 1000;
    try { const b = await res.clone().json(); if (typeof b.retry_after === 'number') waitMs = Math.ceil(b.retry_after * 1000); } catch (_) {}
    const ra = res.headers.get('Retry-After');
    if (ra) waitMs = Math.ceil(parseFloat(ra) * 1000);
    waitMs = Math.min(waitMs, 60000);
    await new Promise((r) => setTimeout(r, waitMs));
    res = await attempt();
  }
  return res;
}

export async function POST(req: NextRequest) {
  try {
    const { proxyUrl } = await req.json();
    if (!proxyUrl) return NextResponse.json({ error: 'proxyUrl is required' }, { status: 400 });
    const start = Date.now();
    try {
      const res = await fetchViaProxyInternal('https://discord.com/api/v10/gateway', { method: 'GET', headers: { 'Content-Type': 'application/json' } }, proxyUrl, 0);
      const data = await res.json().catch(() => ({}));
      return NextResponse.json({ ok: res.status === 200, status: res.status, latencyMs: Date.now() - start, gatewayUrl: (data as any).url || null });
    } catch (err: any) {
      return NextResponse.json({ ok: false, error: err.message, latencyMs: Date.now() - start });
    }
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
      }
