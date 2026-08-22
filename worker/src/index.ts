import { createClient } from '@supabase/supabase-js';

interface ChatRequest {
  action?: 'auth_test';
  conversation_id?: string;
  message?: string;
}

const json = (body: unknown, status = 200, extra: HeadersInit = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...extra } });

function extractBearer(request: Request): string | null {
  const value = request.headers.get('Authorization');
  if (!value?.startsWith('Bearer ')) return null;
  return value.slice(7).trim() || null;
}

function textFromAi(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const value = result as Record<string, unknown>;
    if (typeof value.response === 'string') return value.response;
    if (typeof value.text === 'string') return value.text;
    const choices = value.choices;
    if (Array.isArray(choices) && choices[0] && typeof choices[0] === 'object') {
      const message = (choices[0] as Record<string, unknown>).message;
      if (message && typeof message === 'object' && typeof (message as Record<string, unknown>).content === 'string') {
        return (message as Record<string, string>).content;
      }
    }
  }
  return 'AIから有効な回答を取得できませんでした。';
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
    .select('daily_request_limit,daily_search_limit,max_output_tokens')
    .eq('id', true)
    .single();
  if (settingsError) throw settingsError;
  return settings;
}

export default {
  async fetch(request, env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'Authorization, Content-Type' } });
    }
    if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

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
      const { data: profile, error: profileError } = await admin
        .from('profiles').select('id,role,status').eq('id', userData.user.id).single();
      if (profileError || !profile || profile.status !== 'active') {
        return json({ ok: false, error: 'このアカウントは現在利用できません。' }, 403);
      }

      if (payload.action === 'auth_test') {
        return json({ ok: true, user: { id: profile.id, role: profile.role } });
      }

      const message = payload.message?.trim();
      const conversationId = payload.conversation_id;
      if (!message || !conversationId) return json({ ok: false, error: 'conversation_id と message が必要です。' }, 400);
      if (message.length > 8000) return json({ ok: false, error: 'メッセージが長すぎます。' }, 400);

      const { data: conversation, error: conversationError } = await admin
        .from('conversations').select('id,user_id,title').eq('id', conversationId).single();
      if (conversationError || !conversation || conversation.user_id !== userData.user.id) {
        return json({ ok: false, error: 'この会話にはアクセスできません。' }, 403);
      }

      const limits = await resolveLimits(admin);
      const { data: consumed, error: consumeError } = await admin.rpc('consume_daily_request', {
        p_user_id: userData.user.id,
        p_limit: limits.daily_request_limit
      });
      if (consumeError) throw consumeError;
      if (!consumed) return json({ ok: false, error: '今日の利用上限に達しました。' }, 429);

      const { data: history, error: historyError } = await admin
        .from('messages').select('role,content').eq('conversation_id', conversationId)
        .order('created_at', { ascending: false }).limit(20);
      if (historyError) throw historyError;

      const { data: settings, error: settingsError } = await admin
        .from('app_settings').select('default_model').eq('id', true).single();
      if (settingsError) throw settingsError;

      const messages = [...(history ?? []).reverse(), { role: 'user', content: message }]
        .map(item => ({ role: item.role === 'assistant' ? 'assistant' : 'user', content: item.content }));

      const result = await env.AI.run(settings.default_model, {
        messages,
        max_tokens: limits.max_output_tokens
      });
      const answer = textFromAi(result);

      const { error: insertError } = await admin.from('messages').insert([
        { conversation_id: conversationId, role: 'user', content: message },
        { conversation_id: conversationId, role: 'assistant', content: answer }
      ]);
      if (insertError) throw insertError;

      if (conversation.title === '新しいチャット') {
        const title = message.replace(/\s+/g, ' ').slice(0, 40);
        await admin.from('conversations').update({ title, updated_at: new Date().toISOString() }).eq('id', conversationId);
      } else {
        await admin.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId);
      }

      return json({ ok: true, conversation_id: conversationId, answer });
    } catch (error) {
      console.error(JSON.stringify({ event: 'kotoha_api_error', message: error instanceof Error ? error.message : String(error) }));
      return json({ ok: false, error: 'サーバー処理中にエラーが発生しました。' }, 500);
    }
  }
} satisfies ExportedHandler<Env>;
