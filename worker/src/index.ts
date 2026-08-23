import { createClient } from '@supabase/supabase-js';

interface ChatRequest {
  action?: 'auth_test';
  conversation_id?: string;
  message?: string;
}

const STANDARD_MODEL = '@cf/google/gemma-4-26b-a4b-it';
const FAST_MODEL = '@cf/zai-org/glm-4.7-flash';
const MAX_HISTORY_MESSAGES = 8;
const NORMAL_MAX_OUTPUT_TOKENS = 512;

const ADMIN_TEXT_MODELS = new Set([
  '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
  '@cf/deepseek-ai/deepseek-v4-flash-0731',
  '@cf/google/gemma-2b-it-lora',
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/aisingapore/gemma-sea-lion-v4-27b-it',
  '@cf/zai-org/glm-4.7-flash',
  '@cf/zai-org/glm-5.2',
  '@cf/openai/gpt-oss-20b',
  '@cf/openai/gpt-oss-120b',
  '@cf/ibm/granite-4.0-h-micro',
  '@cf/moonshotai/kimi-k2.6',
  '@cf/moonshotai/kimi-k2.7-code',
  '@cf/meta/llama-3.1-8b-instruct-fast',
  '@cf/meta/llama-3.1-8b-instruct-fp8',
  '@cf/meta/llama-3.2-11b-vision-instruct',
  '@cf/meta/llama-3.2-1b-instruct',
  '@cf/meta/llama-3.2-3b-instruct',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/nvidia/nemotron-3-120b-a12b',
  '@cf/qwen/qwen2.5-coder-32b-instruct',
  '@cf/qwen/qwen3-30b-a3b-fp8',
  '@cf/qwen/qwq-32b'
]);

const NORMAL_MODELS = new Set([STANDARD_MODEL, FAST_MODEL]);

const json = (body: unknown, status = 200, extra: HeadersInit = {}) =>
  Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'Authorization, Content-Type',
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
    const delta = choice.delta;
    if (delta && typeof delta === 'object') {
      const content = (delta as Record<string, unknown>).content;
      if (typeof content === 'string') return content;
    }
    const message = choice.message;
    if (message && typeof message === 'object') {
      const content = (message as Record<string, unknown>).content;
      if (typeof content === 'string') return content;
    }
    if (typeof choice.text === 'string') return choice.text;
  }

  return '';
}

function textFromAi(result: unknown): string | null {
  const text = streamTextFromChunk(result).trim();
  return text || null;
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

function resolveModel(profile: Record<string, unknown>, defaultModel: string): string {
  const override = typeof profile.model_override === 'string' ? profile.model_override : null;
  const isAdmin = profile.role === 'admin';

  if (isAdmin) {
    if (override && ADMIN_TEXT_MODELS.has(override)) return override;
    if (ADMIN_TEXT_MODELS.has(defaultModel)) return defaultModel;
    return FAST_MODEL;
  }

  if (override && NORMAL_MODELS.has(override)) return override;
  if (NORMAL_MODELS.has(defaultModel)) return defaultModel;
  return FAST_MODEL;
}

function eventStreamHeaders(): HeadersInit {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store, must-revalidate',
    'connection': 'keep-alive',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'Authorization, Content-Type'
  };
}

async function consumeAndPersistStream(
  stream: ReadableStream<Uint8Array>,
  admin: ReturnType<typeof createClient>,
  userId: string,
  conversationId: string,
  message: string,
  conversationTitle: string,
  isAdmin: boolean,
  effectiveRequestLimit: number,
  logContext: Record<string, unknown>
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
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() || '';

      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;

        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        try {
          const parsed = JSON.parse(payload);
          answer += streamTextFromChunk(parsed);
        } catch {
          // 非JSONのdata行は無視する。
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  answer = answer.trim();

  if (!answer) {
    console.error(JSON.stringify({
      event: 'workers_ai_empty_stream',
      ...logContext
    }));
    return;
  }

  if (!isAdmin) {
    const { data: consumed, error: consumeError } = await admin.rpc('consume_daily_request', {
      p_user_id: userId,
      p_limit: effectiveRequestLimit
    });
    if (consumeError) throw consumeError;
    if (!consumed) {
      console.error(JSON.stringify({
        event: 'workers_ai_usage_limit_after_stream',
        ...logContext
      }));
      return;
    }
  }

  const { error: insertError } = await admin.from('messages').insert([
    { conversation_id: conversationId, role: 'user', content: message },
    { conversation_id: conversationId, role: 'assistant', content: answer }
  ]);
  if (insertError) throw insertError;

  const updateData: Record<string, string> = {
    updated_at: new Date().toISOString()
  };

  if (conversationTitle === '新しいチャット') {
    updateData.title = message.replace(/\s+/g, ' ').slice(0, 40);
  }

  const { error: conversationUpdateError } = await admin
    .from('conversations')
    .update(updateData)
    .eq('id', conversationId);
  if (conversationUpdateError) throw conversationUpdateError;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: eventStreamHeaders()
      });
    }

    if (request.method === 'GET') {
      return json({
        ok: true,
        service: 'Kotoha AI API',
        status: 'online',
        message: 'Kotoha AI Cloudflare Worker is running.'
      });
    }

    if (request.method !== 'POST') {
      return json({ ok: false, error: 'Method not allowed' }, 405);
    }

    const token = extractBearer(request);
    if (!token) return json({ ok: false, error: '認証が必要です。' }, 401);

    const auth = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
    });
    const { data: userData, error: authError } = await auth.auth.getUser(token);
    if (authError || !userData.user) {
      return json({ ok: false, error: 'ログインセッションが無効です。' }, 401);
    }

    const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
    });

    try {
      const payload = await request.json() as ChatRequest;

      const { data: profile, error: profileError } = await admin
        .from('profiles')
        .select('id,role,status,model_override,daily_request_limit_override,daily_search_limit_override,max_output_tokens_override')
        .eq('id', userData.user.id)
        .single();

      if (profileError || !profile || profile.status !== 'active') {
        return json({ ok: false, error: 'このアカウントは現在利用できません。' }, 403);
      }

      const isAdmin = profile.role === 'admin';

      if (payload.action === 'auth_test') {
        return json({ ok: true, user: { id: profile.id, role: profile.role } });
      }

      const message = payload.message?.trim();
      const conversationId = payload.conversation_id;
      if (!message || !conversationId) {
        return json({ ok: false, error: 'conversation_id と message が必要です。' }, 400);
      }
      if (message.length > 8000) {
        return json({ ok: false, error: 'メッセージが長すぎます。' }, 400);
      }

      const { data: conversation, error: conversationError } = await admin
        .from('conversations')
        .select('id,user_id,title')
        .eq('id', conversationId)
        .single();
      if (conversationError || !conversation || conversation.user_id !== userData.user.id) {
        return json({ ok: false, error: 'この会話にはアクセスできません。' }, 403);
      }

      const limits = await resolveLimits(admin);
      const effectiveRequestLimit = profile.daily_request_limit_override ?? limits.daily_request_limit;
      const effectiveSearchLimit = profile.daily_search_limit_override ?? limits.daily_search_limit;
      const configuredMaxOutputTokens = profile.max_output_tokens_override ?? limits.max_output_tokens;

      if (!isAdmin) {
        const numericLimit = Number(effectiveRequestLimit);
        if (!Number.isFinite(numericLimit) || numericLimit < 1) {
          return json({ ok: false, error: '現在AIの利用は停止されています。' }, 429);
        }
      }

      const { data: history, error: historyError } = await admin
        .from('messages')
        .select('role,content')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(MAX_HISTORY_MESSAGES);
      if (historyError) throw historyError;

      const { data: settings, error: settingsError } = await admin
        .from('app_settings')
        .select('default_model,max_output_tokens')
        .eq('id', true)
        .single();
      if (settingsError) throw settingsError;

      const effectiveModel = resolveModel(profile, settings.default_model);
      const rawMaxTokens = Number(configuredMaxOutputTokens);
      const maxTokens = isAdmin
        ? (Number.isFinite(rawMaxTokens) && rawMaxTokens > 0 ? Math.min(Math.floor(rawMaxTokens), 8192) : 1024)
        : Math.min(
            NORMAL_MAX_OUTPUT_TOKENS,
            Number.isFinite(rawMaxTokens) && rawMaxTokens > 0 ? Math.floor(rawMaxTokens) : NORMAL_MAX_OUTPUT_TOKENS
          );

      const messages = [
        ...(history ?? []).reverse(),
        { role: 'user', content: message }
      ]
        .map(item => ({
          role: item.role === 'assistant' ? 'assistant' : 'user',
          content: String(item.content ?? '')
        }))
        .filter(item => item.content.length > 0);

      let aiStream: ReadableStream<Uint8Array>;
      try {
        aiStream = await env.AI.run(effectiveModel, {
          messages,
          max_completion_tokens: maxTokens,
          stream: true
        });
      } catch (firstError) {
        console.error(JSON.stringify({
          event: 'workers_ai_stream_first_attempt_failed',
          model: effectiveModel,
          user_id: userData.user.id,
          message: firstError instanceof Error ? firstError.message : String(firstError)
        }));

        aiStream = await env.AI.run(effectiveModel, {
          messages: [{ role: 'user', content: message }],
          max_completion_tokens: maxTokens,
          stream: true
        });
      }

      const [clientStream, persistenceStream] = aiStream.tee();

      ctx.waitUntil(
        consumeAndPersistStream(
          persistenceStream,
          admin,
          userData.user.id,
          conversationId,
          message,
          conversation.title,
          isAdmin,
          Number(effectiveRequestLimit),
          {
            model: effectiveModel,
            conversation_id: conversationId,
            user_id: userData.user.id
          }
        ).catch(error => {
          console.error(JSON.stringify({
            event: 'kotoha_stream_persistence_error',
            message: error instanceof Error ? error.message : String(error),
            conversation_id: conversationId,
            user_id: userData.user.id
          }));
        })
      );

      return new Response(clientStream, {
        status: 200,
        headers: eventStreamHeaders()
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ event: 'kotoha_api_error', message: errorMessage }));

      if (errorMessage === 'CONVERSATION_LIMIT_REACHED') {
        return json({ ok: false, error: '会話数の上限に達しています。管理画面で上限を変更できます。' }, 429);
      }

      return json({
        ok: false,
        error: 'サーバー処理中にエラーが発生しました。'
      }, 500);
    }
  }
} satisfies ExportedHandler<Env>;
