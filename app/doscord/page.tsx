'use client';
import { useState, useEffect, useRef } from 'react';

interface Guild { id: string; name: string; icon: string | null; }
interface Channel { id: string; name: string; type: number; }
interface LogEntry { id: string; timestamp: string; type: 'info' | 'success' | 'error' | 'warn'; text: string; }
interface SessionInfo { prefix: string; connected: boolean; sessionId: string | null; lastSeq: number | null; proxy: string | null; }

export default function DoscordPage() {
  const [tokensInput, setTokensInput] = useState('');
  const [proxiesInput, setProxiesInput] = useState('');
  const [tokenType, setTokenType] = useState<'bot' | 'user'>('user');
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [selectedGuild, setSelectedGuild] = useState('');
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedChannel, setSelectedChannel] = useState('');
  const [message, setMessage] = useState('');
  const [sendCount, setSendCount] = useState(1);
  const [sendDelay, setSendDelay] = useState(1000);
  const [isSending, setIsSending] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [inviteCode, setInviteCode] = useState('');
  const [isJoining, setIsJoining] = useState(false);
  const [status, setStatus] = useState('');
  const logEndRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  function getTokens(): string[] {
    return tokensInput.split('\n').map(t => t.trim()).filter(Boolean);
  }

  function getProxies(): string[] {
    return proxiesInput.split('\n').map(p => p.trim()).filter(Boolean).map(p => {
      if (!p.startsWith('http')) {
        const parts = p.split(':');
        if (parts.length === 4) {
          const [host, port, user, pass] = parts;
          return `http://${user}:${pass}@${host}:${port}`;
        }
      }
      return p;
    });
  }

  function getProxyForToken(index: number): string | null {
    const proxies = getProxies();
    if (proxies.length === 0) return null;
    return proxies[index % proxies.length];
  }

  useEffect(() => {
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch('/api/custom-gateway', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'logs' }),
        });
        const data = await res.json();
        if (data.logs) setLogs(data.logs);
        if (data.activeSessions) setSessions(data.activeSessions);
      } catch (_) {}
    }, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [logs]);

  async function handleConnectAll() {
    const tokens = getTokens();
    if (tokens.length === 0) return setStatus('トークンを入力してください');
    setIsConnecting(true);
    setStatus(`${tokens.length}トークン接続中...`);
    try {
      const tokenProxyPairs = tokens.map((token, i) => ({ token, proxy: getProxyForToken(i) }));
      const res = await fetch('/api/custom-gateway', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'connectAll', tokens, tokenType, tokenProxyPairs }),
      });
      const data = await res.json();
      setStatus(data.message || '接続開始');
    } catch (e: any) {
      setStatus(`エラー: ${e.message}`);
    } finally {
      setIsConnecting(false);
    }
  }

  async function handleGetGuilds() {
    const tokens = getTokens();
    if (tokens.length === 0) return setStatus('トークンを入力してください');
    setStatus('サーバー取得中...');
    try {
      const res = await fetch('/api/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'getGuilds', token: tokens[0], tokenType, proxy: getProxyForToken(0) }),
      });
      const data = await res.json();
      if (data.guilds) { setGuilds(data.guilds); setStatus(`${data.guilds.length}サーバー取得`); }
      else setStatus(`エラー: ${data.error}`);
    } catch (e: any) { setStatus(`エラー: ${e.message}`); }
  }

  async function handleGetChannels() {
    const tokens = getTokens();
    if (!selectedGuild) return setStatus('サーバーを選択してください');
    setStatus('チャンネル取得中...');
    try {
      const res = await fetch('/api/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'getChannels', token: tokens[0], tokenType, guildId: selectedGuild, proxy: getProxyForToken(0) }),
      });
      const data = await res.json();
      if (data.channels) {
        const text = data.channels.filter((c: Channel) => c.type === 0);
        setChannels(text); setStatus(`${text.length}チャンネル取得`);
      } else setStatus(`エラー: ${data.error}`);
    } catch (e: any) { setStatus(`エラー: ${e.message}`); }
  }

  async function handleSendMessage() {
    const tokens = getTokens();
    if (tokens.length === 0 || !selectedChannel || !message) return setStatus('入力不足');
    setIsSending(true);
    let sent = 0;
    try {
      for (let i = 0; i < sendCount; i++) {
        const tokenIndex = i % tokens.length;
        const token = tokens[tokenIndex];
        const proxy = getProxyForToken(tokenIndex);
        const res = await fetch('/api/send', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'sendMessage', token, tokenType, channelId: selectedChannel, message, proxy }),
        });
        const data = await res.json();
        if (data.success) { sent++; setStatus(`送信中: ${sent}/${sendCount}`); }
        else setStatus(`エラー (${tokenIndex}): ${data.error}`);
        if (i < sendCount - 1) await new Promise(r => setTimeout(r, sendDelay));
      }
      setStatus(`完了: ${sent}/${sendCount}件送信`);
    } catch (e: any) { setStatus(`エラー: ${e.message}`); }
    finally { setIsSending(false); }
  }

  async function handleJoinGuild() {
    const tokens = getTokens();
    if (tokens.length === 0 || !inviteCode) return setStatus('入力不足');
    setIsJoining(true);
    let joined = 0;
    try {
      for (let i = 0; i < tokens.length; i++) {
        const proxy = getProxyForToken(i);
        const res = await fetch('/api/send', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'joinGuild', token: tokens[i], tokenType, inviteCode, proxy }),
        });
        const data = await res.json();
        if (data.success) { joined++; setStatus(`参加中: ${joined}/${tokens.length} (${data.guild})`); }
        else setStatus(`エラー (${i}): ${data.error}`);
        await new Promise(r => setTimeout(r, 1200 + Math.random() * 800));
      }
      setStatus(`完了: ${joined}/${tokens.length}件参加`);
    } catch (e: any) { setStatus(`エラー: ${e.message}`); }
    finally { setIsJoining(false); }
  }

  const logColor = { info: 'text-gray-400', success: 'text-green-400', error: 'text-red-400', warn: 'text-yellow-400' };

  return (
    <div className="w-full max-w-4xl space-y-4">
      <h1 className="text-2xl font-bold text-center">🥔 Doscord Raider</h1>

      {/* トークン入力 */}
      <div className="bg-gray-100 dark:bg-gray-900 rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-3">
          <label className="font-semibold w-28 shrink-0">トークン</label>
          <select value={tokenType} onChange={e => setTokenType(e.target.value as 'bot' | 'user')}
            className="bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm">
            <option value="user">User</option>
            <option value="bot">Bot</option>
          </select>
        </div>
        <textarea value={tokensInput} onChange={e => setTokensInput(e.target.value)}
          placeholder="トークンを1行1つで入力"
          className="w-full h-28 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded p-2 text-sm font-mono resize-y" />
      </div>

      {/* プロキシ入力 */}
      <div className="bg-gray-100 dark:bg-gray-900 rounded-xl p-4 space-y-2">
        <label className="font-semibold block">プロキシ（任意）</label>
        <p className="text-xs text-gray-500">1行1つ。形式: <code>host:port:user:pass</code> または <code>http://user:pass@host:port</code></p>
        <textarea value={proxiesInput} onChange={e => setProxiesInput(e.target.value)}
          placeholder={"45.38.107.97:6014:recvhasv:jtcna3v8s2n4\n64.137.96.74:6641:recvhasv:jtcna3v8s2n4\n..."}
          className="w-full h-28 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded p-2 text-sm font-mono resize-y" />
        {getProxies().length > 0 && (
          <p className="text-xs text-green-500">{getProxies().length}個のプロキシ検出 → {getTokens().length}トークンにラウンドロビン割り当て</p>
        )}
      </div>

      {/* Gateway接続 */}
      <div className="bg-gray-100 dark:bg-gray-900 rounded-xl p-4 space-y-3">
        <h2 className="font-semibold">Gateway接続</h2>
        <button onClick={handleConnectAll} disabled={isConnecting}
          className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
          {isConnecting ? '接続中...' : '全トークン接続'}
        </button>
        {sessions.length > 0 && (
          <div className="mt-2 space-y-1">
            {sessions.map((s, i) => (
              <div key={i} className="flex items-center gap-2 text-xs font-mono">
                <span className={s.connected ? 'text-green-500' : 'text-gray-500'}>{s.connected ? '●' : '○'}</span>
                <span>{s.prefix}</span>
                {s.proxy && <span className="text-blue-400">proxy✓</span>}
                {s.sessionId && <span className="text-gray-500">sid:{s.sessionId}</span>}
                {s.lastSeq !== null && <span className="text-gray-500">seq:{s.lastSeq}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* サーバー＆チャンネル */}
      <div className="bg-gray-100 dark:bg-gray-900 rounded-xl p-4 space-y-3">
        <h2 className="font-semibold">サーバー / チャンネル</h2>
        <div className="flex gap-2 flex-wrap">
          <button onClick={handleGetGuilds}
            className="bg-gray-600 hover:bg-gray-700 text-white px-3 py-1.5 rounded text-sm transition-colors">
            サーバー取得
          </button>
          <select value={selectedGuild} onChange={e => setSelectedGuild(e.target.value)}
            className="flex-1 min-w-0 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm">
            <option value="">サーバーを選択</option>
            {guilds.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          <button onClick={handleGetChannels} disabled={!selectedGuild}
            className="bg-gray-600 hover:bg-gray-700 disabled:opacity-50 text-white px-3 py-1.5 rounded text-sm transition-colors">
            CH取得
          </button>
          <select value={selectedChannel} onChange={e => setSelectedChannel(e.target.value)}
            className="flex-1 min-w-0 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm">
            <option value="">チャンネルを選択</option>
            {channels.map(c => <option key={c.id} value={c.id}>#{c.name}</option>)}
          </select>
        </div>
      </div>

      {/* メッセージ送信 */}
      <div className="bg-gray-100 dark:bg-gray-900 rounded-xl p-4 space-y-3">
        <h2 className="font-semibold">メッセージ送信</h2>
        <textarea value={message} onChange={e => setMessage(e.target.value)}
          placeholder="送信するメッセージ"
          className="w-full h-20 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded p-2 text-sm resize-y" />
        <div className="flex gap-3 items-center flex-wrap">
          <div className="flex items-center gap-2 text-sm">
            <label>回数:</label>
            <input type="number" min={1} max={9999} value={sendCount} onChange={e => setSendCount(Number(e.target.value))}
              className="w-20 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-2 py-1" />
          </div>
          <div className="flex items-center gap-2 text-sm">
            <label>間隔(ms):</label>
            <input type="number" min={100} max={60000} value={sendDelay} onChange={e => setSendDelay(Number(e.target.value))}
              className="w-24 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-2 py-1" />
          </div>
          <button onClick={handleSendMessage} disabled={isSending}
            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
            {isSending ? '送信中...' : '送信'}
          </button>
        </div>
      </div>

      {/* サーバー参加 */}
      <div className="bg-gray-100 dark:bg-gray-900 rounded-xl p-4 space-y-3">
        <h2 className="font-semibold">サーバー参加</h2>
        <div className="flex gap-2">
          <input value={inviteCode} onChange={e => setInviteCode(e.target.value)}
            placeholder="招待コード (例: abc123)"
            className="flex-1 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm" />
          <button onClick={handleJoinGuild} disabled={isJoining}
            className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
            {isJoining ? '参加中...' : '全員参加'}
          </button>
        </div>
      </div>

      {/* ステータス */}
      {status && (
        <div className="bg-gray-100 dark:bg-gray-900 rounded-xl px-4 py-3 text-sm font-mono">
          {status}
        </div>
      )}

      {/* ログ */}
      <div className="bg-black rounded-xl p-4 h-64 overflow-y-auto font-mono text-xs space-y-0.5">
        {logs.length === 0 && <p className="text-gray-600">ログなし</p>}
        {logs.map(log => (
          <div key={log.id} className={logColor[log.type]}>
            <span className="text-gray-600">[{log.timestamp}]</span> {log.text}
          </div>
        ))}
        <div ref={logEndRef} />
      </div>
    </div>
  );
      }
