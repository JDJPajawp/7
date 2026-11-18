import { NextRequest, NextResponse } from 'next/server';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';

interface ProxyConfig { host: string; port: number; username?: string; password?: string; }

function parseProxy(proxyUrl: string): ProxyConfig {
  const u = new URL(proxyUrl);
  return {
    host: u.hostname, port: parseInt(u.port, 10),
    username: u.username || undefined, password: u.password || undefined,
  };
}

function httpTunnelConnect(proxy: ProxyConfig, targetHost: string, targetPort: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.host, port: proxy.port, method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: proxy.username
        ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}` }
        : {},
    });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('HTTP CONNECT timeout')); });
    req.on('connect', (_res, socket) => resolve(socket));
    req.on('error', reject);
    req.end();
  });
}

async function fetchViaProxy(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string },
  proxyUrl: string
): Promise<{ ok: boolean; status: number; json: () => Promise<any> }> {
  const target = new URL(url);
  const proxy = parseProxy(proxyUrl);
  const socket = await httpTunnelConnect(proxy, target.hostname, 443);

  return new Promise((resolve, reject) => {
    const agent = new https.Agent({ socket } as any);
    const reqOptions: https.RequestOptions = {
      hostname: target.hostname,
      path: target.pathname + target.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      agent,
    };
    const req = https.request(reqOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({
          ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
          status: res.statusCode ?? 0,
          json: async () => JSON.parse(text),
        });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function discordFetch(
  path: string,
  token: string,
  tokenType: 'bot' | 'user',
  options: { method?: string; body?: any } = {},
  proxyUrl?: string | null
) {
  const url = `https://discord.com/api/v10${path}`;
  const headers: Record<string, string> = {
    Authorization: tokenType === 'bot' ? `Bot ${token}` : token,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  };
  const fetchOptions = {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  };

  if (proxyUrl) return fetchViaProxy(url, fetchOptions, proxyUrl);
  return fetch(url, fetchOptions);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action, token, tokenType = 'user', proxy } = body;

    if (!token) return NextResponse.json({ error: 'Token required' }, { status: 400 });

    if (action === 'getGuilds') {
      const res = await discordFetch('/users/@me/guilds', token, tokenType, {}, proxy);
      if (!res.ok) return NextResponse.json({ error: `Discord error ${res.status}` }, { status: res.status });
      const guilds = await res.json();
      return NextResponse.json({ guilds });
    }

    if (action === 'getChannels') {
      const { guildId } = body;
      if (!guildId) return NextResponse.json({ error: 'guildId required' }, { status: 400 });
      const res = await discordFetch(`/guilds/${guildId}/channels`, token, tokenType, {}, proxy);
      if (!res.ok) return NextResponse.json({ error: `Discord error ${res.status}` }, { status: res.status });
      const channels = await res.json();
      return NextResponse.json({ channels });
    }

    if (action === 'sendMessage') {
      const { channelId, message } = body;
      if (!channelId || !message) return NextResponse.json({ error: 'channelId and message required' }, { status: 400 });
      const res = await discordFetch(
        `/channels/${channelId}/messages`,
        token, tokenType,
        { method: 'POST', body: { content: message } },
        proxy
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return NextResponse.json({ error: `Discord error ${res.status}`, details: err }, { status: res.status });
      }
      const data = await res.json();
      return NextResponse.json({ success: true, messageId: data.id });
    }

    if (action === 'joinGuild') {
      const { inviteCode } = body;
      if (!inviteCode) return NextResponse.json({ error: 'inviteCode required' }, { status: 400 });
      const res = await discordFetch(
        `/invites/${inviteCode}`,
        token, tokenType,
        { method: 'POST', body: {} },
        proxy
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return NextResponse.json({ error: `Discord error ${res.status}`, details: err }, { status: res.status });
      }
      const data = await res.json();
      return NextResponse.json({ success: true, guild: data.guild?.name });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 });
  }
}
