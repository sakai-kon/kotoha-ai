import { createClient } from '@supabase/supabase-js';

interface ChatRequest {
  action?: 'auth_test';
  conversation_id?: string;
  message?: string;
  model?: string;
}

const STANDARD_MODEL = '@cf/google/gemma-4-26b-a4b-it';
const LIGHT_MODEL = '@cf/meta/llama-3.2-1b-instruct';
const MAX_HISTORY_MESSAGES = 8;
const NORMAL_MAX_OUTPUT_TOKENS = 512;

const NORMAL_MODEL_LIMITS = new Map<string, number>([
  [STANDARD_MODEL, 5],
  [LIGHT_MODEL, 10]
]);

// Current Workers AI models retained in the administrator Free-plan selector.
// Paid-only models are deliberately omitted.
const ADMIN_TEXT_MODELS = new Set([
  '@cf/zai-org/glm-4.7-flash',
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/nvidia/nemotron-3-120b-a12b',
  '@cf/openai/gpt-oss-20b',
  '@cf/openai/gpt-oss-120b',
  '@cf/ibm/granite-4.0-h-micro',
  '@cf/aisingapore/gemma-sea-lion-v4-27b-it',
  '@cf/meta/llama-3.1-8b-instruct-fast',
  '@cf/meta/llama-3.1-8b-instruct-fp8',
  '@cf/meta/llama-3.2-1b-instruct',
  '@cf/meta/llama-3.2-3b-instruct',
  '@cf/meta/llama-3.2-11b-vision-instruct',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/qwen/qwen2.5-coder-32b-instruct',
  '@cf/qwen/qwen3-30b-a3b-fp8',
  '@cf/qwen/qwq-32b'
]);

const json = (body: unknown, status = 200, extra: HeadersInit = {}) =>
  Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'Authorization, Content-Type',
      'access-control-allow-methods': 'POST, GET, OPTIONS',
      ...extra
    }
  });

function extractBearer(request: Request): string | null {
  const value = request.headers.get('Authorization');
  if (!value?.startsWith('Bearer ')) return null;
  return value.slice(7).trim() || null;
}

function streamTextFromChunk(result: unknown): string {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return '';
  const value = result as Record<string, unknown>;
  if (typeof value.response === 'string') return value.response;
  if (typeof value.text === 'string') return value.text;
  const choices = value.choices;
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === 'object') {
    const choice = choices[0] as Record<string, unknown>;
    if (choice.delta && typeof choice.delta === 'object') {
      const content = (choice.delta as Record<string, unknown>).content;
      if (typeof content === 'string') return content;
    }
    if (choice.message && typeof choice.message === 'object') {
      const content = (choice.message as Record<string, unknown>).content;
      if (typeof content === 'string') return content;
    }
    if (typeof choice.text === 'string') return choice.text;
  }
  return '';
}

function eventStreamHeaders(): HeadersInit {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store, must-revalidate',
    'connection': 'keep-alive',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'Authorization, Content-Type',
    'access-control-allow-methods': 'POST, OPTIONS'
  };
}

async function resolveLimits(admin: ReturnType<typeof createClient>) {
  const now = new Date().toISOString();
  const { data: period, error: periodError } = await admin
    .from('special_periods')
    .select('daily_request_limit,daily_search_limit,max_output_tokens')
    .eq('is_active', true)
    .lte('start_at', now)
    .gte('end_at', now)
    .order('start_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (periodError) throw periodError;
  if (period) return period;

  const { data: policy, error: policyError } = await admin
    .from('usage_policies')
    .select('daily_request_limit,daily_search_limit,max_output_tokens')
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (policyError) throw policyError;
  if (policy) return policy;

  const { data: settings, error: settingsError } = await admin
    .from('app_settings')
    .select('daily_request_limit,daily_search_limit,max_output_tokens,default_model')
    .eq('id', true)
    .single();
  if (settingsError) throw settingsError;
  return settings;
}

function resolveModel(profile: Record<string, unknown>, requestedModel: unknown, defaultModel: string): string {
  const isAdmin = profile.role === 'admin';
  const requested = typeof requestedModel === 'string' ? requestedModel : '';
  const override = typeof profile.model_override === 'string' ? profile.model_override : '';

  if (isAdmin) {
    if (requested && ADMIN_TEXT_MODELS.has(requested)) return requested;
    if (override && ADMIN_TEXT_MODELS.has(override)) return override;
    if (ADMIN_TEXT_MODELS.has(defaultModel)) return defaultModel;
    return '@cf/zai-org/glm-4.7-flash';
  }

  if (requested && NORMAL_MODEL_LIMITS.has(requested)) return requested;
  if (override && NORMAL_MODEL_LIMITS.has(override)) return override;
  if (NORMAL_MODEL_LIMITS.has(defaultModel)) return defaultModel;
  return STANDARD_MODEL;
}

async function consumeModelRequest(
  admin: ReturnType<typeof createClient>,
  userId: string,
  model: string,
  limit: number
) {
  const { data, error } = await admin.rpc('consume_model_daily_request', {
    p_user_id: userId,
    p_model: model,
    p_limit: limit
  });
  if (error) throw error;
  return Boolean(data);
}

async function persistStream(
  stream: ReadableStream<Uint8Array>,
  admin: ReturnType<typeof createClient>,
  userId: string,
  conversationId: string,
  message: string,
  conversationTitle: string,
  model: string,
  isAdmin: boolean,
  limit: number
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          answer += streamTextFromChunk(JSON.parse(payload));
        } catch {
          // Ignore non-JSON SSE lines.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  answer = answer.trim();
  if (!answer) throw new Error('AIから有効な回答を取得できませんでした。');

  if (!isAdmin) {
    // Only a successful streamed answer consumes the per-model daily quota.
    const consumed = await consumeModelRequest(admin, userId, model, limit);
    if (!consumed) throw new Error('このモデルの今日の利用上限に達しました。');
  }

  const { error: insertError } = await admin.from('messages').insert([
    { conversation_id: conversationId, role: 'user', content: message },
    { conversation_id: conversationId, role: 'assistant', content: answer }
  ]);
  if (insertError) throw insertError;

  const update: Record<string, string> = { updated_at: new Date().toISOString() };
  if (conversationTitle === '新しいチャット') {
    update.title = message.replace(/\s+/g, ' ').slice(0, 40);
  }
  const { error: updateError } = await admin.from('conversations').update(update).eq('id', conversationId);
  if (updateError) throw updateError;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: eventStreamHeaders() });
    if (request.method === 'GET') return json({ ok: true, service: 'Kotoha AI API', status: 'online', message: 'Kotoha AI Cloudflare Worker is running.' });
    if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

    if (!env.AI) return json({ ok: false, error: 'Workers AI Binding AI が設定されていません。' }, 500);
    if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) {
      return json({ ok: false, error: 'Supabase環境変数が設定されていません。' }, 500);
    }

    const token = extractBearer(request);
    if (!token) return json({ ok: false, error: '認証が必要です。' }, 401);

    const auth = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
    });
    const { data: userData, error: authError } = await auth.auth.getUser(token);
    if (authError || !userData.user) return json({ ok: false, error: 'ログインセッションが無効です。' }, 401);

    const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
    });

    try {
      const payload = await request.json() as ChatRequest;
      const { data: profile, error: profileError } = await admin.from('profiles')
        .select('id,role,status,model_override,daily_request_limit_override,daily_search_limit_override,max_output_tokens_override')
        .eq('id', userData.user.id)
        .single();
      if (profileError || !profile || profile.status !== 'active') return json({ ok: false, error: 'このアカウントは現在利用できません。' }, 403);

      const isAdmin = profile.role === 'admin';
      if (payload.action === 'auth_test') return json({ ok: true, user: { id: profile.id, role: profile.role } });

      const message = typeof payload.message === 'string' ? payload.message.trim() : '';
      const conversationId = typeof payload.conversation_id === 'string' ? payload.conversation_id : '';
      if (!message || !conversationId) return json({ ok: false, error: 'conversation_id と message が必要です。' }, 400);
      if (message.length > 8000) return json({ ok: false, error: 'メッセージが長すぎます。' }, 400);

      const { data: conversation, error: conversationError } = await admin.from('conversations')
        .select('id,user_id,title')
        .eq('id', conversationId)
        .single();
      if (conversationError || !conversation || conversation.user_id !== userData.user.id) return json({ ok: false, error: 'この会話にはアクセスできません。' }, 403);

      const limits = await resolveLimits(admin);
      const { data: settings, error: settingsError } = await admin.from('app_settings')
        .select('default_model,max_output_tokens')
        .eq('id', true)
        .single();
      if (settingsError) throw settingsError;

      const effectiveModel = resolveModel(profile, payload.model, settings.default_model);
      const modelLimit = NORMAL_MODEL_LIMITS.get(effectiveModel);

      if (!isAdmin) {
        if (!modelLimit) return json({ ok: false, error: 'このモデルは一般ユーザーでは利用できません。' }, 403);
        const allowed = await consumeModelRequest(admin, userData.user.id, effectiveModel, modelLimit);
        if (!allowed) {
          const label = effectiveModel === STANDARD_MODEL ? 'Gemma 4 26B' : 'Llama 3.2 1B';
          return json({ ok: false, error: `${label} の今日の利用上限（${modelLimit}回）に達しました。別のモデルを選択してください。` }, 429);
        }
      }

      const { data: history, error: historyError } = await admin.from('messages')
        .select('role,content')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(MAX_HISTORY_MESSAGES);
      if (historyError) throw historyError;

      const messages = [
        ...(history ?? []).reverse(),
        { role: 'user', content: message }
      ].map(item => ({
        role: item.role === 'assistant' ? 'assistant' : 'user',
        content: String(item.content || '')
      })).filter(item => item.content.length > 0);

      const configuredTokens = Number(profile.max_output_tokens_override ?? limits.max_output_tokens);
      const maxTokens = isAdmin
        ? Math.min(Math.max(Number.isFinite(configuredTokens) && configuredTokens > 0 ? Math.floor(configuredTokens) : 1024, 64), 8192)
        : Math.min(NORMAL_MAX_OUTPUT_TOKENS, Math.max(Number.isFinite(configuredTokens) && configuredTokens > 0 ? Math.floor(configuredTokens) : NORMAL_MAX_OUTPUT_TOKENS, 64));

      let aiStream: ReadableStream<Uint8Array>;
      try {
        aiStream = await env.AI.run(effectiveModel, {
          messages,
          max_completion_tokens: maxTokens,
          stream: true
        }) as ReadableStream<Uint8Array>;
      } catch (firstError) {
        console.error(JSON.stringify({ event: 'workers_ai_stream_retry', model: effectiveModel, message: firstError instanceof Error ? firstError.message : String(firstError) }));
        aiStream = await env.AI.run(effectiveModel, {
          messages: [{ role: 'user', content: message }],
          max_completion_tokens: maxTokens,
          stream: true
        }) as ReadableStream<Uint8Array>;
      }

      const [clientStream, persistenceStream] = aiStream.tee();

      ctx.waitUntil((async () => {
        try {
          // We already reserve the quota before inference for normal users.
          // Persistence therefore must not increment usage a second time.
          const reader = persistenceStream.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let answer = '';
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split(/\r?\n/);
              buffer = lines.pop() || '';
              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const raw = trimmed.slice(5).trim();
                if (!raw || raw === '[DONE]') continue;
                try { answer += streamTextFromChunk(JSON.parse(raw)); } catch { /* ignore */ }
              }
            }
          } finally {
            reader.releaseLock();
          }
          answer = answer.trim();
          if (!answer) throw new Error('AIから有効な回答を取得できませんでした。');

          const { error: insertError } = await admin.from('messages').insert([
            { conversation_id: conversationId, role: 'user', content: message },
            { conversation_id: conversationId, role: 'assistant', content: answer }
          ]);
          if (insertError) throw insertError;

          const update: Record<string, string> = { updated_at: new Date().toISOString() };
          if (conversation.title === '新しいチャット') update.title = message.replace(/\s+/g, ' ').slice(0, 40);
          const { error: updateError } = await admin.from('conversations').update(update).eq('id', conversationId);
          if (updateError) throw updateError;
        } catch (error) {
          console.error(JSON.stringify({ event: 'kotoha_stream_persistence_error', message: error instanceof Error ? error.message : String(error), conversation_id: conversationId }));
        }
      })());

      return new Response(clientStream, { status: 200, headers: eventStreamHeaders() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ event: 'kotoha_api_error', message }));
      if (message.includes('利用上限')) return json({ ok: false, error: message }, 429);
      return json({ ok: false, error: 'サーバー処理中にエラーが発生しました。' }, 500);
    }
  }
};
