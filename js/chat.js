(() => {
  const client = window.supabaseClient;
  let currentUser = null;
  let currentConversationId = null;

  const config = window.KOTOHA_CONFIG || {};
  const API_URL = String(config.API_URL || '').replace(/\/$/, '');
  const SUPABASE_URL = String(config.SUPABASE_URL || '').replace(/\/$/, '');
  const SUPABASE_KEY = config.SUPABASE_PUBLISHABLE_KEY || '';

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'\"]/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&#34;'
    }[c]));
  }

  function setStatus(message) {
    const note = document.querySelector('#worker-status');
    if (note) note.textContent = message;
  }

  function setBusy(button, busy) {
    if (button) button.disabled = busy;
  }

  function withTimeout(promise, ms, message) {
    let id;
    const timeout = new Promise((_, reject) => {
      id = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(id));
  }

  async function getAccessToken() {
    if (!client) throw new Error('Supabaseクライアントが初期化されていません。');
    const { data, error } = await client.auth.getSession();
    if (error) throw new Error(`セッション取得エラー: ${error.message}`);
    if (!data?.session?.access_token) throw new Error('ログインセッションが取得できませんでした。');
    return data.session.access_token;
  }

  async function dbFetch(path, options = {}) {
    if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase設定がありません。');
    const token = await getAccessToken();
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...options,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });

    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }

    if (!response.ok) {
      const message = data?.message || data?.details || (typeof data === 'string' ? data : `HTTP ${response.status}`);
      throw new Error(`Supabase API ${response.status}: ${message}`);
    }
    return data;
  }

  async function verifyWorkerConnection() {
    try {
      const token = await withTimeout(getAccessToken(), 5000, 'Supabaseセッション取得がタイムアウトしました。');
      const response = await withTimeout(fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'auth_test' })
      }), 15000, 'Cloudflare Workerが15秒以内に応答しませんでした。');
      const result = await response.json().catch(() => ({ ok: false, error: 'WorkerからJSON応答を取得できませんでした。' }));
      if (!response.ok || !result.ok) return { ok: false, error: result.error || `Worker error: ${response.status}` };
      return result;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function createConversation() {
    const data = await dbFetch('conversations?select=id,title,updated_at', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ user_id: currentUser.id })
    });
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.id) throw new Error('会話を作成できませんでした。');
    currentConversationId = row.id;
    document.querySelector('#conversation-title').textContent = row.title || '新しいチャット';
    document.querySelector('#message-list').innerHTML = '';
    await loadConversations();
  }

  async function loadConversations() {
    const query = 'conversations?select=id,title,updated_at&user_id=eq.' + encodeURIComponent(currentUser.id) + '&order=updated_at.desc';
    const data = await dbFetch(query);
    const list = document.querySelector('#conversation-list');
    list.innerHTML = (data || []).map(c => `<button class="conversation-item" data-id="${escapeHtml(c.id)}">${escapeHtml(c.title || '新しいチャット')}</button>`).join('');
    list.querySelectorAll('.conversation-item').forEach(button => {
      button.addEventListener('click', () => openConversation(button.dataset.id).catch(error => setStatus(`🔴 会話の読み込みに失敗しました: ${error.message}`)));
    });
  }

  async function openConversation(id) {
    const conversations = await dbFetch('conversations?select=id,title&user_id=eq.' + encodeURIComponent(currentUser.id) + '&id=eq.' + encodeURIComponent(id) + '&limit=1');
    const conversation = conversations?.[0];
    if (!conversation) throw new Error('会話が見つかりません。');
    currentConversationId = conversation.id;
    document.querySelector('#conversation-title').textContent = conversation.title || 'チャット';

    const messages = await dbFetch('messages?select=role,content,created_at&conversation_id=eq.' + encodeURIComponent(id) + '&order=created_at.asc');
    document.querySelector('#message-list').innerHTML = (messages || []).map(m =>
      `<article class="message ${escapeHtml(m.role)}"><strong>${m.role === 'user' ? 'あなた' : m.role === 'assistant' ? 'Kotoha' : escapeHtml(m.role)}</strong><p>${escapeHtml(m.content)}</p></article>`
    ).join('');
  }

  async function loadUsage() {
    try {
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' });
      const usage = await dbFetch('usage_daily?select=request_count,search_count&user_id=eq.' + encodeURIComponent(currentUser.id) + '&usage_date=eq.' + encodeURIComponent(today) + '&limit=1');
      const policy = await dbFetch('usage_policies?select=daily_request_limit&is_active=eq.true&order=created_at.desc&limit=1');
      const count = usage?.[0]?.request_count || 0;
      const limit = policy?.[0]?.daily_request_limit ?? '-';
      document.querySelector('#usage-summary').textContent = `今日: ${count} / ${limit} 回`;
    } catch (error) {
      document.querySelector('#usage-summary').textContent = '利用状況を取得できません';
      console.error('Usage load failed:', error);
    }
  }

  function renderMessage(role, content, thinking = false) {
    const list = document.querySelector('#message-list');
    const article = document.createElement('article');
    article.className = `message ${role}`;
    if (thinking) article.dataset.thinking = 'true';
    article.innerHTML = `<strong>${role === 'user' ? 'あなた' : 'Kotoha'}</strong><p>${escapeHtml(content)}</p>`;
    list.appendChild(article);
    list.scrollTop = list.scrollHeight;
  }

  function removeThinkingMessage() {
    document.querySelectorAll('[data-thinking="true"]').forEach(el => el.remove());
  }

  async function sendChatMessage(content) {
    if (!currentConversationId) await createConversation();
    const token = await getAccessToken();
    const response = await withTimeout(fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ conversation_id: currentConversationId, message: content })
    }), 90000, 'AIの応答が90秒以内に完了しませんでした。');
    const result = await response.json().catch(() => ({ ok: false, error: 'WorkerからJSON応答を取得できませんでした。' }));
    if (!response.ok || !result.ok) throw new Error(result.error || `Worker error: ${response.status}`);
    return result;
  }

  async function initChat() {
    try {
      setStatus('JavaScriptを初期化しました。');
      if (!client) throw new Error('Supabaseクライアントが読み込まれていません。');
      if (!window.kotohaAuth?.requireUser) throw new Error('認証モジュールが読み込まれていません。');

      setStatus('ログイン状態を確認しています…');
      currentUser = await withTimeout(window.kotohaAuth.requireUser(), 10000, 'ログイン状態の確認がタイムアウトしました。');
      if (!currentUser) return;

      document.querySelector('#signout-button').addEventListener('click', window.kotohaAuth.signOut);
      document.querySelector('#new-chat').addEventListener('click', async () => {
        try { await createConversation(); setStatus('🟢 新しいチャットを作成しました。'); }
        catch (error) { setStatus(`🔴 ${error.message}`); }
      });

      setStatus('Cloudflare Workerへ接続しています…');
      const workerResult = await verifyWorkerConnection();
      if (!workerResult.ok) {
        setStatus(`🔴 サーバー接続確認: ${workerResult.error}`);
      } else {
        setStatus(`🟢 サーバー接続確認: 成功（${workerResult.user?.role || 'user'}）`);
      }

      try {
        await loadConversations();
        const first = document.querySelector('.conversation-item');
        if (first) await openConversation(first.dataset.id);
      } catch (error) {
        setStatus(`🔴 会話データ取得エラー: ${error.message}`);
      }

      await loadUsage();

      document.querySelector('#chat-form').addEventListener('submit', async event => {
        event.preventDefault();
        const input = document.querySelector('#message-input');
        const button = document.querySelector('#send-button');
        const content = input.value.trim();
        if (!content || button.disabled) return;

        try {
          setBusy(button, true);
          input.value = '';
          if (!currentConversationId) await createConversation();
          renderMessage('user', content);
          renderMessage('assistant', '考えています…', true);
          setStatus('Kotohaが考えています…');
          await sendChatMessage(content);
          removeThinkingMessage();
          await openConversation(currentConversationId);
          await loadConversations();
          await loadUsage();
          setStatus('🟢 送信完了');
        } catch (error) {
          removeThinkingMessage();
          input.value = content;
          console.error('Kotoha chat error:', error);
          setStatus(`🔴 ${error.message || 'メッセージ送信に失敗しました。'}`);
        } finally {
          setBusy(button, false);
          input.focus();
        }
      });
    } catch (error) {
      console.error('Kotoha initialization error:', error);
      setStatus(`🔴 初期化エラー: ${error.message || '不明なエラー'}`);
    }
  }

  window.addEventListener('error', event => setStatus(`🔴 JavaScriptエラー: ${event.message || '不明なエラー'}`));
  window.addEventListener('unhandledrejection', event => setStatus(`🔴 非同期エラー: ${event.reason?.message || String(event.reason || '不明なエラー')}`));

  initChat();
})();
