import { NextRequest, NextResponse } from 'next/server';

// ─────────────────────────────────────────────
// ヘッダー構築
// ─────────────────────────────────────────────
function buildHeaders(token: string, tokenType: 'bot' | 'user'): Record<string, string> {
  if (tokenType === 'bot') {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bot ${token}`,
    };
  }
  return {
    'Content-Type': 'application/json',
    Authorization: token,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'X-Discord-Locale': 'ja',
    'X-Super-Properties': Buffer.from(
      JSON.stringify({
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
        design_id: 0,
        client_event_source: null,
      })
    ).toString('base64'),
  };
}

// ─────────────────────────────────────────────
// 429 対応ラッパー
// 自動で Retry-After を読んで 1 回だけリトライする
// ─────────────────────────────────────────────
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries = 3
): Promise<Response> {
  let res = await fetch(url, init);

  for (let attempt = 0; attempt < maxRetries && res.status === 429; attempt++) {
    let retryAfterMs = 1000;
    try {
      const body = await res.clone().json();
      if (typeof body.retry_after === 'number') {
        retryAfterMs = Math.ceil(body.retry_after * 1000);
      }
    } catch (_) {}
    const raHeader = res.headers.get('Retry-After');
    if (raHeader) {
      const parsed = parseFloat(raHeader) * 1000;
      if (!isNaN(parsed)) retryAfterMs = Math.ceil(parsed);
    }
    // 最大 60 秒待ち
    retryAfterMs = Math.min(retryAfterMs, 60000);
    await new Promise((r) => setTimeout(r, retryAfterMs));
    res = await fetch(url, init);
  }

  return res;
}

// ─────────────────────────────────────────────
// API ハンドラ
// ─────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const action = req.nextUrl.searchParams.get('action');
    const body = await req.json();
    const {
      tokens,
      tokenType = 'bot',
      guildId,
      channelId,
      content,
      count = 1,
    }: {
      tokens: string[];
      tokenType: 'bot' | 'user';
      guildId?: string;
      channelId?: string;
      content?: string;
      count?: number;
    } = body;

    if (!tokens || !Array.isArray(tokens) || tokens.length === 0) {
      return NextResponse.json(
        { error: '有効なトークンが指定されていません。' },
        { status: 400 }
      );
    }

    // ─── 1. サーバー一覧（共通サーバー）────────────────────────
    if (action === 'getGuilds') {
      const guildSets: Set<string>[] = [];
      const guildMap = new Map<string, { id: string; name: string }>();

      for (const token of tokens) {
        const res = await fetchWithRetry(
          'https://discord.com/api/v10/users/@me/guilds',
          { method: 'GET', headers: buildHeaders(token, tokenType) }
        );
        if (!res.ok) {
          const errText = await res.text();
          return NextResponse.json(
            { error: `サーバー取得失敗 (${res.status}): ${errText}` },
            { status: res.status }
          );
        }
        const guilds = await res.json();
        const ids = new Set<string>();
        for (const g of guilds) {
          ids.add(g.id);
          guildMap.set(g.id, { id: g.id, name: g.name });
        }
        guildSets.push(ids);
      }

      let commonIds = guildSets[0];
      for (let i = 1; i < guildSets.length; i++) {
        commonIds = new Set([...commonIds].filter((id) => guildSets[i].has(id)));
      }

      return NextResponse.json(
        Array.from(commonIds).map((id) => guildMap.get(id)!)
      );
    }

    // ─── 2. チャンネル一覧 ─────────────────────────────────────
    if (action === 'getChannels') {
      if (!guildId) {
        return NextResponse.json(
          { error: 'サーバーIDが指定されていません。' },
          { status: 400 }
        );
      }
      const res = await fetchWithRetry(
        `https://discord.com/api/v10/guilds/${guildId}/channels`,
        { method: 'GET', headers: buildHeaders(tokens[0], tokenType) }
      );
      if (!res.ok) {
        const errText = await res.text();
        return NextResponse.json(
          { error: `チャンネル取得失敗 (${res.status}): ${errText}` },
          { status: res.status }
        );
      }
      return NextResponse.json(await res.json());
    }

    // ─── 3. メッセージ送信 ─────────────────────────────────────
    if (action === 'sendMessage') {
      if (!channelId || !content) {
        return NextResponse.json(
          { error: 'チャンネルIDまたはメッセージ内容が不足しています。' },
          { status: 400 }
        );
      }

      const details: {
        tokenPrefix: string;
        success: number;
        failed: number;
        lastError?: string;
      }[] = [];

      for (const token of tokens) {
        const prefix = token.substring(0, 10) + '...';
        let successCount = 0;
        let failCount = 0;
        let lastError = '';

        for (let i = 0; i < count; i++) {
          try {
            const res = await fetchWithRetry(
              `https://discord.com/api/v10/channels/${channelId}/messages`,
              {
                method: 'POST',
                headers: buildHeaders(token, tokenType),
                body: JSON.stringify({ content }),
              }
            );

            if (res.ok) {
              successCount++;
            } else {
              failCount++;
              const errData = await res.json().catch(() => ({}));
              lastError = errData.message || `HTTP ${res.status}`;
            }
          } catch (err: any) {
            failCount++;
            lastError = err.message || 'ネットワークエラー';
          }
        }

        details.push({
          tokenPrefix: prefix,
          success: successCount,
          failed: failCount,
          ...(lastError ? { lastError } : {}),
        });
      }

      return NextResponse.json({ details });
    }

    // ─── 4. 招待リンクからサーバー参加 ────────────────────────
    if (action === 'joinGuild') {
      const { inviteCode }: { inviteCode?: string } = body;
      if (!inviteCode) {
        return NextResponse.json(
          { error: '招待コードが指定されていません。' },
          { status: 400 }
        );
      }

      const trimmed = inviteCode.trim().replace(/^https?:\/\/discord\.gg\//, '');
      const results: { tokenPrefix: string; success: boolean; error?: string }[] =
        [];

      for (const token of tokens) {
        const prefix = token.substring(0, 10) + '...';
        try {
          const res = await fetchWithRetry(
            `https://discord.com/api/v10/invites/${trimmed}`,
            {
              method: 'POST',
              headers: buildHeaders(token, tokenType),
              body: JSON.stringify({}),
            }
          );
          if (res.ok) {
            results.push({ tokenPrefix: prefix, success: true });
          } else {
            const errData = await res.json().catch(() => ({}));
            results.push({
              tokenPrefix: prefix,
              success: false,
              error: errData.message || `HTTP ${res.status}`,
            });
          }
        } catch (err: any) {
          results.push({
            tokenPrefix: prefix,
            success: false,
            error: err.message || 'ネットワークエラー',
          });
        }
      }

      return NextResponse.json({ results });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Internal error' },
      { status: 500 }
    );
  }
}
