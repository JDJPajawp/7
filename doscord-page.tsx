'use client';

import React, { useState, useEffect, useRef } from 'react';

// ─────────────────────────────────────────────
// 型
// ─────────────────────────────────────────────
type TokenType = 'bot' | 'user';

interface LogEntry {
  id: string;
  timestamp: string;
  type: 'info' | 'success' | 'error' | 'warn';
  text: string;
}

interface Guild {
  id: string;
  name: string;
}

interface Channel {
  id: string;
  name: string;
  type: number;
}

interface ActiveSession {
  prefix: string;
  connected: boolean;
  sessionId: string | null;
  lastSeq: number | null;
}

// ─────────────────────────────────────────────
// コンポーネント
// ─────────────────────────────────────────────
export default function DoscordPage() {
  // 入力系
  const [tokensInput, setTokensInput] = useState('');
  const [tokenType, setTokenType] = useState<TokenType>('user');
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedGuild, setSelectedGuild] = useState('');
  const [selectedChannel, setSelectedChannel] = useState('');
  const [message, setMessage] = useState('');
  const [count, setCount] = useState(1);
  const [inviteCodeInput, setInviteCodeInput] = useState('');

  // パラメータ設定
  const [useRandomSuffix, setUseRandomSuffix] = useState(true);
  const [delayMin, setDelayMin] = useState(0.6);
  const [delayMax, setDelayMax] = useState(1.5);

  // ローディング
  const [isConnectingWss, setIsConnectingWss] = useState(false);
  const [isLoadingGuilds, setIsLoadingGuilds] = useState(false);
  const [isLoadingChannels, setIsLoadingChannels] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isJoining, setIsJoining] = useState(false);

  // ログ / セッション状態
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([]);
  const terminalRef = useRef<HTMLDivElement>(null);

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  // ─── ログ追加 ───────────────────────────────
  const addLog = (text: string, type: LogEntry['type'] = 'info') => {
    const now = new Date();
    const ts =
      now.toTimeString().split(' ')[0] +
      '.' +
      String(now.getMilliseconds()).padStart(3, '0');
    setLogs((prev) => [
      ...prev,
      { id: Math.random().toString(36).substring(2, 9), timestamp: ts, type, text },
    ]);
  };

  // ターミナルを常に末尾へ
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [logs]);

  // ─── バックエンドGatewayログをポーリング ────
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/custom-gateway', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'logs' }),
        });
        if (!res.ok) return;
        const data = await res.json();

        if (Array.isArray(data.logs)) {
          setLogs(
            data.logs.map((l: { id: string; timestamp: string; type: LogEntry['type']; text: string }) => ({
              id: l.id,
              timestamp: l.timestamp,
              type: l.type,
              text: `[WSS] ${l.text}`,
            }))
          );
        }
        if (Array.isArray(data.activeSessions)) {
          setActiveSessions(data.activeSessions);
        }
      } catch (_) {}
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  // ─── トークンパース ─────────────────────────
  const getTokens = (): string[] =>
    tokensInput
      .split(/[\n,]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

  const tokensCount = getTokens().length;

  // ─── 全トークン Gateway 接続 ────────────────
  const handleConnectAll = async () => {
    const tokens = getTokens();
    if (tokens.length === 0) {
      addLog('Error: トークンを入力してください。', 'error');
      return;
    }
    setIsConnectingWss(true);
    addLog(
      `${tokens.length}個のトークンをGatewayへ接続開始（800ms stagger）...`,
      'info'
    );
    try {
      const res = await fetch('/api/custom-gateway', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'connectAll', tokens, tokenType }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gateway接続失敗');
      addLog(`SUCCESS: ${data.message}`, 'success');
    } catch (err: any) {
      addLog(`Gateway Error: ${err.message}`, 'error');
    } finally {
      setIsConnectingWss(false);
    }
  };

  // ─── サーバー一覧 ───────────────────────────
  const handleLoadGuilds = async () => {
    const tokens = getTokens();
    if (tokens.length === 0) {
      addLog('Error: トークンが入力されていません。', 'error');
      return;
    }
    setIsLoadingGuilds(true);
    setGuilds([]);
    setChannels([]);
    setSelectedGuild('');
    setSelectedChannel('');
    addLog(`${tokens.length}個のトークンでサーバー一覧取得...`, 'info');
    try {
      const res = await fetch('/api/send?action=getGuilds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokens, tokenType }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'サーバー取得失敗');
      setGuilds(Array.isArray(data) ? data : []);
      addLog(`SUCCESS: 共通サーバー ${Array.isArray(data) ? data.length : 0}件取得。`, 'success');
    } catch (err: any) {
      addLog(`Error: ${err.message}`, 'error');
    } finally {
      setIsLoadingGuilds(false);
    }
  };

  // ─── チャンネル一覧 ─────────────────────────
  const handleGuildChange = async (guildId: string) => {
    setSelectedGuild(guildId);
    setSelectedChannel('');
    setChannels([]);
    if (!guildId) return;

    const tokens = getTokens();
    setIsLoadingChannels(true);
    addLog(`サーバー ${guildId} のチャンネル取得中...`, 'info');
    try {
      const res = await fetch('/api/send?action=getChannels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokens, tokenType, guildId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'チャンネル取得失敗');
      const textChannels = Array.isArray(data)
        ? data.filter((c: Channel) => c.type === 0 || c.type === 5)
        : [];
      setChannels(textChannels);
      addLog(`SUCCESS: テキストチャンネル ${textChannels.length}件取得。`, 'success');
    } catch (err: any) {
      addLog(`Error: ${err.message}`, 'error');
    } finally {
      setIsLoadingChannels(false);
    }
  };

  // ─── メッセージ送信 ─────────────────────────
  const handleSendMessage = async () => {
    const tokens = getTokens();
    if (tokens.length === 0) { addLog('Error: トークンなし。', 'error'); return; }
    if (!selectedChannel) { addLog('Error: チャンネル未選択。', 'error'); return; }
    if (!message.trim()) { addLog('Error: メッセージが空。', 'error'); return; }

    setIsSending(true);
    addLog(
      `送信開始: ${count}回/token × ${tokens.length}token | suffix=${useRandomSuffix} | delay=${delayMin}~${delayMax}s`,
      'info'
    );

    const targetChannels =
      selectedChannel === 'ALL'
        ? channels.map((c) => c.id)
        : [selectedChannel];

    let totalSuccess = 0;
    let totalFailed = 0;

    const runWorker = async (channelId: string) => {
      // チャンネル間の初期オフセット（並列でも一斉にならないように）
      const initialOffset = Math.floor(Math.random() * 1500);
      await sleep(initialOffset);

      for (let i = 0; i < count; i++) {
        for (const token of tokens) {
          const prefix = token.substring(0, 10) + '...';
          const finalContent = useRandomSuffix
            ? `${message} [${Math.random().toString(36).substring(2, 7)}]`
            : message;

          try {
            const res = await fetch('/api/send?action=sendMessage', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                tokens: [token],
                tokenType,
                guildId: selectedGuild,
                channelId,
                content: finalContent,
                count: 1,
              }),
            });
            const data = await res.json();
            if (res.ok && data.details?.[0]) {
              const det = data.details[0];
              if (det.success > 0) {
                totalSuccess += det.success;
                addLog(
                  `[${prefix}] ch:${channelId} ✓ (${i + 1}/${count})`,
                  'success'
                );
              } else {
                totalFailed += det.failed;
                addLog(
                  `[${prefix}] ch:${channelId} ✗ ${det.lastError || 'Unknown'}`,
                  'error'
                );
              }
            } else {
              totalFailed++;
              addLog(`[${prefix}] ch:${channelId} ✗ ${data.error || 'API Error'}`, 'error');
            }
          } catch (err: any) {
            totalFailed++;
            addLog(`[${prefix}] Network error: ${err.message}`, 'error');
          }

          // ランダム遅延 + チャンネルごとのジッター
          const jitter = (Math.random() * 0.4) - 0.2;
          const minMs = Math.max(100, (delayMin + jitter) * 1000);
          const maxMs = Math.max(minMs, (delayMax + jitter) * 1000);
          const waitMs = Math.floor(Math.random() * (maxMs - minMs) + minMs);
          await sleep(waitMs);
        }
      }
    };

    try {
      await Promise.all(targetChannels.map((id) => runWorker(id)));
      addLog(`=== 完了 === 成功: ${totalSuccess} / 失敗: ${totalFailed}`, 'info');
    } catch (err: any) {
      addLog(`Worker error: ${err.message}`, 'error');
    } finally {
      setIsSending(false);
    }
  };

  // ─── サーバー参加 ───────────────────────────
  const handleJoinGuild = async () => {
    const tokens = getTokens();
    if (tokens.length === 0) { addLog('Error: トークンなし。', 'error'); return; }
    if (!inviteCodeInput.trim()) { addLog('Error: 招待コードなし。', 'error'); return; }

    setIsJoining(true);
    addLog(`招待 [${inviteCodeInput}] 参加試行 (${tokens.length}アカウント)...`, 'info');
    try {
      const res = await fetch('/api/send?action=joinGuild', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokens, tokenType, inviteCode: inviteCodeInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '参加失敗');
      if (Array.isArray(data.results)) {
        for (const r of data.results) {
          if (r.success) {
            addLog(`[${r.tokenPrefix}] 参加成功`, 'success');
          } else {
            addLog(`[${r.tokenPrefix}] 参加失敗: ${r.error}`, 'error');
          }
        }
      }
    } catch (err: any) {
      addLog(`Error: ${err.message}`, 'error');
    } finally {
      setIsJoining(false);
    }
  };

  // ─────────────────────────────────────────────
  // UI
  // ─────────────────────────────────────────────
  return (
    <div className="space-y-8 w-full max-w-2xl">
      <div>
        <div className="text-xs font-bold tracking-widest text-red-600 uppercase mb-1">
          Doscord v2
        </div>
        <h1 className="text-3xl font-black text-red-600 tracking-tight">
          Discord Multi-Token Tool
        </h1>
        <p className="text-xs text-gray-500 mt-1">
          Gateway Resume / 429自動リトライ / 全トークン接続対応
        </p>
      </div>

      {/* ── トークン入力 ── */}
      <div className="space-y-3">
        <label className="block text-xs font-bold text-gray-600 uppercase tracking-wider">
          トークン（1行1トークン または カンマ区切り）
        </label>
        <textarea
          rows={4}
          className="w-full p-3 border rounded border-gray-300 dark:border-gray-700 dark:bg-gray-950 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-red-600"
          placeholder="token1&#10;token2&#10;token3"
          value={tokensInput}
          onChange={(e) => setTokensInput(e.target.value)}
        />
        <div className="flex items-center gap-4 flex-wrap">
          <span className="text-xs text-gray-500">
            {tokensCount}個のトークン
          </span>
          <div className="flex gap-3">
            {(['user', 'bot'] as TokenType[]).map((t) => (
              <label key={t} className="flex items-center gap-1 text-xs font-medium cursor-pointer">
                <input
                  type="radio"
                  name="tokenType"
                  value={t}
                  checked={tokenType === t}
                  onChange={() => setTokenType(t)}
                  className="accent-red-600"
                />
                {t === 'user' ? 'User Token' : 'Bot Token'}
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* ── Gateway 接続 ── */}
      <div className="p-4 border rounded border-gray-200 dark:border-gray-800 space-y-3">
        <div className="text-xs font-bold text-gray-700 dark:text-gray-300 uppercase tracking-wider">
          🔌 Gateway 常時接続
        </div>
        <p className="text-xs text-gray-500">
          全トークンをGatewayへ800ms間隔でスタガー接続。切断時は自動Resume/再接続。
          Fatal code（4004=BAN等）は再接続しない。
        </p>
        <button
          onClick={handleConnectAll}
          disabled={isConnectingWss || tokensCount === 0}
          className="w-full py-2.5 bg-red-600 text-white font-bold text-sm rounded hover:bg-red-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 transition-colors"
        >
          {isConnectingWss ? '接続中...' : `全${tokensCount}トークンをGateway接続`}
        </button>

        {/* セッション状態表示 */}
        {activeSessions.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs font-bold text-gray-500 uppercase">アクティブセッション</div>
            {activeSessions.map((s, i) => (
              <div
                key={i}
                className="flex items-center gap-3 text-xs font-mono text-gray-700 dark:text-gray-300"
              >
                <span
                  className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    s.connected ? 'bg-green-500' : 'bg-yellow-400'
                  }`}
                />
                <span>{s.prefix}</span>
                {s.sessionId && (
                  <span className="text-gray-400">session:{s.sessionId}…</span>
                )}
                {s.lastSeq !== null && (
                  <span className="text-gray-400">seq:{s.lastSeq}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── サーバー / チャンネル選択 ── */}
      <div className="space-y-3">
        <button
          onClick={handleLoadGuilds}
          disabled={isLoadingGuilds || tokensCount === 0}
          className="w-full py-2.5 bg-gray-900 dark:bg-gray-800 text-white font-bold text-sm rounded hover:bg-gray-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 transition-colors"
        >
          {isLoadingGuilds ? '取得中...' : '1. 共通サーバー一覧を取得'}
        </button>

        {guilds.length > 0 && (
          <select
            value={selectedGuild}
            onChange={(e) => handleGuildChange(e.target.value)}
            disabled={isLoadingChannels}
            className="w-full p-2.5 border rounded border-gray-300 dark:border-gray-700 dark:bg-gray-950 text-sm focus:outline-none focus:ring-1 focus:ring-red-600 disabled:opacity-50"
          >
            <option value="">-- サーバーを選択 --</option>
            {guilds.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        )}

        {channels.length > 0 && (
          <select
            value={selectedChannel}
            onChange={(e) => setSelectedChannel(e.target.value)}
            className="w-full p-2.5 border rounded border-gray-300 dark:border-gray-700 dark:bg-gray-950 text-sm focus:outline-none focus:ring-1 focus:ring-red-600"
          >
            <option value="">-- チャンネルを選択 --</option>
            <option value="ALL" className="font-bold text-red-600">
              ⚡ 全チャンネルに並列送信 ({channels.length}箇所)
            </option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* ── パラメータ設定 ── */}
      <div className="p-4 border rounded border-gray-200 dark:border-gray-800 space-y-3">
        <div className="text-xs font-bold text-gray-700 dark:text-gray-300 uppercase tracking-wider">
          🛡️ パラメータ設定
        </div>

        <label className="flex items-center gap-2 cursor-pointer text-xs font-medium">
          <input
            type="checkbox"
            checked={useRandomSuffix}
            onChange={(e) => setUseRandomSuffix(e.target.checked)}
            className="accent-red-600"
          />
          メッセージ末尾にランダムIDを付与（重複検知回避）
        </label>

        <div>
          <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">
            送信間隔（秒） ※チャンネルごとに ±0.2s のジッターが加算されます
          </label>
          <div className="flex items-center gap-2 font-mono text-xs">
            <input
              type="number"
              step="0.1"
              min="0.1"
              value={delayMin}
              onChange={(e) => setDelayMin(parseFloat(e.target.value) || 0.1)}
              className="w-16 p-1 border rounded dark:bg-gray-950 text-center"
            />
            <span>秒 〜</span>
            <input
              type="number"
              step="0.1"
              min="0.1"
              value={delayMax}
              onChange={(e) => setDelayMax(parseFloat(e.target.value) || 0.1)}
              className="w-16 p-1 border rounded dark:bg-gray-950 text-center"
            />
            <span>秒</span>
          </div>
        </div>
      </div>

      {/* ── メッセージ送信 ── */}
      <div className="space-y-3">
        <label className="block text-xs font-bold text-gray-600 dark:text-gray-400 uppercase tracking-wider">
          送信メッセージ
        </label>
        <textarea
          rows={3}
          className="w-full p-3 border rounded border-gray-300 dark:border-gray-700 dark:bg-gray-950 text-sm focus:outline-none focus:ring-1 focus:ring-red-600"
          placeholder="送信したいメッセージ..."
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />

        <div>
          <label className="block text-xs font-bold text-gray-600 dark:text-gray-400 mb-1 uppercase tracking-wider">
            各トークンあたりの送信回数
          </label>
          <input
            type="number"
            min={1}
            max={50}
            value={count}
            onChange={(e) => setCount(Math.max(1, parseInt(e.target.value, 10) || 1))}
            className="w-28 p-2 border rounded border-gray-300 dark:border-gray-700 dark:bg-gray-950 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-red-600"
          />
        </div>

        <button
          onClick={handleSendMessage}
          disabled={isSending || !selectedChannel || !message.trim()}
          className="w-full py-3 bg-red-600 text-white font-bold text-sm rounded hover:bg-red-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 transition-colors"
        >
          {isSending ? '送信中...' : '2. メッセージを送信'}
        </button>
      </div>

      {/* ── 招待参加 ── */}
      <div className="p-4 border rounded border-red-200 dark:border-red-900/50 space-y-3">
        <div className="text-xs font-bold text-gray-700 dark:text-gray-300 uppercase tracking-wider">
          ⚡ 招待リンクからサーバーに参加
        </div>
        <input
          type="text"
          className="w-full p-2.5 border rounded border-gray-300 dark:border-gray-700 dark:bg-gray-950 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-red-600"
          placeholder="https://discord.gg/xxxx または xxxx"
          value={inviteCodeInput}
          onChange={(e) => setInviteCodeInput(e.target.value)}
        />
        <button
          onClick={handleJoinGuild}
          disabled={isJoining || tokensCount === 0 || !inviteCodeInput.trim()}
          className="w-full py-2.5 bg-gray-900 dark:bg-gray-800 text-white font-bold text-sm rounded hover:bg-gray-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 transition-colors"
        >
          {isJoining ? '参加処理中...' : '指定したトークンでサーバーに参加'}
        </button>
      </div>

      {/* ── ターミナルログ ── */}
      <div className="space-y-2">
        <div className="flex justify-between items-center">
          <span className="text-xs font-bold text-gray-600 dark:text-gray-400 uppercase tracking-wider">
            🖥️ 実行コンソール
          </span>
          {logs.length > 0 && (
            <button
              onClick={() => setLogs([])}
              className="text-xs text-red-500 hover:underline"
            >
              クリア
            </button>
          )}
        </div>
        <div
          ref={terminalRef}
          className="w-full h-72 bg-black border border-gray-800 rounded p-3 font-mono text-xs overflow-y-auto space-y-0.5 shadow-inner select-text"
        >
          {logs.length === 0 ? (
            <span className="text-gray-600">system ready... waiting for actions.</span>
          ) : (
            logs.map((log) => {
              const color =
                log.type === 'success'
                  ? 'text-green-400 font-semibold'
                  : log.type === 'error'
                  ? 'text-red-400 font-semibold'
                  : log.type === 'warn'
                  ? 'text-yellow-400'
                  : 'text-gray-300';
              return (
                <div key={log.id} className="leading-relaxed break-all">
                  <span className="text-gray-500 mr-2">[{log.timestamp}]</span>
                  <span className={color}>{log.text}</span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
