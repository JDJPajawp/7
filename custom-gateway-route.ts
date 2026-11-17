import { NextRequest, NextResponse } from 'next/server';
import WebSocket from 'ws';

// ─────────────────────────────────────────────
// 型定義
// ─────────────────────────────────────────────
interface GatewaySession {
  ws: WebSocket | null;
  heartbeatTimer: NodeJS.Timeout | null;
  token: string;
  tokenType: 'bot' | 'user';
  isConnecting: boolean;
  // Resume 用
  sessionId: string | null;
  resumeGatewayUrl: string | null;
  lastSeq: number | null;
  // 切断制御
  fatalClose: boolean;
}

declare global {
  var activeSessions: Map<string, GatewaySession>;
  var gatewayLogs: Array<{
    id: string;
    timestamp: string;
    type: 'info' | 'success' | 'error' | 'warn';
    text: string;
  }>;
}

if (!global.activeSessions) global.activeSessions = new Map();
if (!global.gatewayLogs) global.gatewayLogs = [];

// ─────────────────────────────────────────────
// 定数
// ─────────────────────────────────────────────

// 再接続してはいけないクローズコード（トークン死・設定ミス系）
const FATAL_CLOSE_CODES = new Set([
  4004, // Authentication Failed (token BANまたは無効)
  4010, // Invalid Shard
  4011, // Sharding Required
  4012, // Invalid API Version
  4013, // Invalid Intents
  4014, // Disallowed Intents
]);

// Resume 可能なクローズコード
const RESUMABLE_CLOSE_CODES = new Set([
  4000, // Unknown error
  4001, // Unknown opcode
  4002, // Decode error
  4003, // Not authenticated
  4005, // Already authenticated → re-identify
  4007, // Invalid seq → re-identify
  4008, // Rate limited → backoff してから re-identify
  4009, // Session timed out → Resume
]);

const DEFAULT_GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';

// ─────────────────────────────────────────────
// ログ
// ─────────────────────────────────────────────
function addLog(text: string, type: 'info' | 'success' | 'error' | 'warn' = 'info') {
  const now = new Date();
  const ts =
    now.toTimeString().split(' ')[0] +
    '.' +
    String(now.getMilliseconds()).padStart(3, '0');
  global.gatewayLogs.push({
    id: Math.random().toString(36).substring(2, 9),
    timestamp: ts,
    type,
    text,
  });
  if (global.gatewayLogs.length > 200) global.gatewayLogs.shift();
}

// ─────────────────────────────────────────────
// Gateway 接続
// ─────────────────────────────────────────────
function connectGateway(
  token: string,
  tokenType: 'bot' | 'user',
  resume = false,
  delayMs = 0
) {
  // 既にアクティブなら skip
  if (global.activeSessions.has(token)) {
    const ex = global.activeSessions.get(token)!;
    if (ex.ws && ex.ws.readyState === WebSocket.OPEN) {
      addLog(`Session already active [${token.substring(0, 6)}...]. skip.`, 'info');
      return;
    }
    // 壊れてる / 切断済み → cleanup してから再接続
    try { ex.ws?.terminate(); } catch (_) {}
    if (ex.heartbeatTimer) clearInterval(ex.heartbeatTimer);
  }

  if (delayMs > 0) {
    addLog(
      `[${token.substring(0, 6)}...] Reconnect scheduled in ${delayMs}ms...`,
      'warn'
    );
    setTimeout(() => connectGateway(token, tokenType, resume, 0), delayMs);
    return;
  }

  const prev = global.activeSessions.get(token);
  const session: GatewaySession = {
    ws: null,
    heartbeatTimer: null,
    token,
    tokenType,
    isConnecting: true,
    sessionId: (resume && prev?.sessionId) || null,
    resumeGatewayUrl: (resume && prev?.resumeGatewayUrl) || null,
    lastSeq: (resume && prev?.lastSeq) || null,
    fatalClose: false,
  };
  global.activeSessions.set(token, session);

  const gatewayUrl =
    resume && session.resumeGatewayUrl
      ? `${session.resumeGatewayUrl}?v=10&encoding=json`
      : DEFAULT_GATEWAY;

  addLog(
    `[${token.substring(0, 6)}...] Connecting${resume ? ' (RESUME)' : ''}: ${gatewayUrl}`,
    'info'
  );

  const ws = new WebSocket(gatewayUrl);
  session.ws = ws;

  ws.on('open', () => {
    session.isConnecting = false;
    addLog(`[${token.substring(0, 6)}...] WS connected.`, 'success');
  });

  ws.on('message', (raw: WebSocket.Data) => {
    try {
      const packet = JSON.parse(raw.toString());
      const { t, s, op, d } = packet;

      // sequence 番号を常に更新
      if (s !== null && s !== undefined) session.lastSeq = s;

      // Op 10: HELLO → heartbeat 開始 → Identify or Resume
      if (op === 10) {
        const interval: number = d.heartbeat_interval;
        addLog(
          `[${token.substring(0, 6)}...] HELLO: heartbeat ${interval}ms`,
          'info'
        );

        if (session.heartbeatTimer) clearInterval(session.heartbeatTimer);
        session.heartbeatTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ op: 1, d: session.lastSeq }));
          }
        }, interval);

        if (resume && session.sessionId && session.lastSeq !== null) {
          // Op 6: RESUME
          addLog(`[${token.substring(0, 6)}...] Sending RESUME (Op 6)...`, 'info');
          ws.send(
            JSON.stringify({
              op: 6,
              d: {
                token: tokenType === 'bot' ? `Bot ${token}` : token,
                session_id: session.sessionId,
                seq: session.lastSeq,
              },
            })
          );
        } else {
          // Op 2: IDENTIFY
          addLog(`[${token.substring(0, 6)}...] Sending IDENTIFY (Op 2)...`, 'info');
          ws.send(
            JSON.stringify({
              op: 2,
              d: {
                token: tokenType === 'bot' ? `Bot ${token}` : token,
                intents: 0,
                properties: {
                  os: 'Windows',
                  browser: 'Chrome',
                  device: '',
                  system_locale: 'ja',
                  browser_user_agent:
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                  browser_version: '124.0.0.0',
                  os_version: '10',
                  release_channel: 'stable',
                  client_build_number: 305412,
                },
                presence: { status: 'online', since: 0, activities: [], afk: false },
              },
            })
          );
        }
      }

      // Op 9: Invalid Session
      if (op === 9) {
        const resumable: boolean = d;
        addLog(
          `[${token.substring(0, 6)}...] Invalid Session (resumable=${resumable})`,
          'warn'
        );
        session.sessionId = null;
        session.lastSeq = null;
        ws.close();
        // resumable=false なら新規 Identify, true なら Resume 試行
        connectGateway(token, tokenType, resumable, 5000);
        return;
      }

      // Op 7: RECONNECT → Resume 要求
      if (op === 7) {
        addLog(`[${token.substring(0, 6)}...] RECONNECT requested (Op 7), resuming...`, 'warn');
        ws.close();
        connectGateway(token, tokenType, true, 2000);
        return;
      }

      // Event: READY
      if (t === 'READY') {
        session.sessionId = d.session_id;
        session.resumeGatewayUrl = d.resume_gateway_url || null;
        addLog(
          `[${token.substring(0, 6)}...] READY: ${d.user.username} | session=${d.session_id.substring(0, 8)}... | guilds=${d.guilds.length}`,
          'success'
        );
      }

      // Event: RESUMED
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
    const reasonStr = reason.toString() || 'none';
    addLog(
      `[${token.substring(0, 6)}...] CLOSED: ${code} "${reasonStr}"`,
      'warn'
    );

    // Fatal → 再接続しない
    if (FATAL_CLOSE_CODES.has(code)) {
      session.fatalClose = true;
      global.activeSessions.delete(token);
      addLog(
        `[${token.substring(0, 6)}...] Fatal close code ${code}. Session removed. Token may be invalid/banned.`,
        'error'
      );
      return;
    }

    // まだセッションが生きてるなら再接続
    if (!global.activeSessions.has(token)) return;

    const canResume =
      RESUMABLE_CLOSE_CODES.has(code) &&
      code === 4009; // Session timed out → try Resume

    // 4008 (rate limited) は少し長めに待つ
    const delay = code === 4008 ? 15000 : 5000;
    connectGateway(token, tokenType, canResume, delay);
  });
}

// ─────────────────────────────────────────────
// API ハンドラ
// ─────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action, token, tokens, tokenType } = body;

    // 単一トークン接続
    if (action === 'connect') {
      const target: string | undefined = token || (Array.isArray(tokens) ? tokens[0] : undefined);
      if (!target) {
        return NextResponse.json({ error: 'Token is required' }, { status: 400 });
      }
      connectGateway(target, tokenType || 'user', false, 0);
      return NextResponse.json({
        success: true,
        message: 'Gateway connection initiated',
        activeCount: global.activeSessions.size,
      });
    }

    // 複数トークン一括接続
    if (action === 'connectAll') {
      if (!Array.isArray(tokens) || tokens.length === 0) {
        return NextResponse.json({ error: 'tokens[] required' }, { status: 400 });
      }
      let started = 0;
      tokens.forEach((t: string, i: number) => {
        // 順番に少しずつずらして接続（一斉Identifyを避ける）
        setTimeout(() => {
          connectGateway(t, tokenType || 'user', false, 0);
        }, i * 800);
        started++;
      });
      return NextResponse.json({
        success: true,
        message: `Connecting ${started} token(s) with stagger`,
        activeCount: global.activeSessions.size,
      });
    }

    // ログ取得
    if (action === 'logs') {
      return NextResponse.json({
        logs: global.gatewayLogs || [],
        activeSessionsCount: global.activeSessions.size,
        activeSessions: Array.from(global.activeSessions.keys()).map((t) => ({
          prefix: t.substring(0, 10) + '...',
          connected:
            global.activeSessions.get(t)?.ws?.readyState === WebSocket.OPEN,
          sessionId: global.activeSessions.get(t)?.sessionId?.substring(0, 8) ?? null,
          lastSeq: global.activeSessions.get(t)?.lastSeq ?? null,
        })),
      });
    }

    // 切断
    if (action === 'disconnect') {
      const target: string | undefined = token;
      if (!target) {
        return NextResponse.json({ error: 'Token is required' }, { status: 400 });
      }
      const sess = global.activeSessions.get(target);
      if (sess) {
        try { sess.ws?.terminate(); } catch (_) {}
        if (sess.heartbeatTimer) clearInterval(sess.heartbeatTimer);
        global.activeSessions.delete(target);
      }
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 });
  }
}
