const client = window.supabaseClient;
let currentUser = null;
let currentConversationId = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[c]));
}

function withTimeout(promise, ms, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

async function verifyWorkerConnection() {
  const apiUrl = window.KOTOHA_CONFIG?.API_URL;
  if (!apiUrl || apiUrl.includes('REPLACE_WITH')) {
    return { ok: false, error: 'Cloudflare Worker URLがまだ設定されていません。' };
  }

  try {
    const { data: sessionData, error: sessionError } = await withTimeout(
      client.auth.getSession(),
      5000,
      'Supabaseセッション取得が5秒以内に完了しませんでした。'
    );

    if (sessionError || !sessionData?.session?.access_token) {
      return { ok: false, error: 'ログインセッションを取得できませんでした。' };
    }

    const response = await withTimeout(
      fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionData.session.access_token}`
        },
        body: JSON.stringify({ action: 'auth_test' })
      }),
      10000,
      'Cloudflare Workerが10秒以内に応答しませんでした。'
    );

    const result = await response.json().catch(() => ({
      ok: false,
      error: 'WorkerからJSON応答を取得できませんでした。'
    }));

    if (!response.ok && !result.error) {
      result.error = `Worker error: ${response.status}`;
    }
    return result;
  } catch (error) {
    return { ok: false, error: error.message || 'Worker接続中に不明なエラーが発生しました。' };
  }
}

async function createConversation() {
  const { data, error } = await client.from('conversations').insert({ user_id: currentUser.id }).select().single();
  if (error) throw error;
  currentConversationId = data.id;
  document.querySelector('#conversation-title').textContent = data.title;
  document.querySelector('#message-list').innerHTML = '';
  await loadConversations();
}

async function loadConversations() {
  const { data, error } = await client.from('conversations').select('id,title,updated_at').eq('user_id', currentUser.id).order('updated_at', { ascending: false });
  if (error) throw error;
  document.querySelector('#conversation-list').innerHTML = data.map(c => `<button class="conversation-item" data-id="${c.id}">${escapeHtml(c.title)}</button>`).join('');
  document.querySelectorAll('.conversation-item').forEach(button => button.addEventListener('click', () => openConversation(button.dataset.id)));
}

async function openConversation(id) {
  currentConversationId = id;
  const { data: conversation } = await client.from('conversations').select('title').eq('id', id).single();
  document.querySelector('#conversation-title').textContent = conversation?.title || 'チャット';
  const { data, error } = await client.from('messages').select('role,content,created_at').eq('conversation_id', id).order('created_at', { ascending: true });
  if (error) throw error;
  document.querySelector('#message-list').innerHTML = data.map(m => `<article class="message ${m.role}"><strong>${m.role === 'user' ? 'あなた' : 'Kotoha'}</strong><p>${escapeHtml(m.content)}</p></article>`).join('');
}

async function loadUsage() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' });
  const [{ data: usage }, { data: policy }] = await Promise.all([
    client.from('usage_daily').select('request_count,search_count').eq('user_id', currentUser.id).eq('usage_date', today).maybeSingle(),
    client.from('usage_policies').select('daily_request_limit').eq('is_active', true).limit(1).maybeSingle()
  ]);
  document.querySelector('#usage-summary').textContent = `今日: ${usage?.request_count || 0} / ${policy?.daily_request_limit ?? '-'} 回`;
}

async function initChat() {
  const note = document.querySelector('#worker-status');
  if (note) note.textContent = 'ログイン状態を確認中…';

  currentUser = await withTimeout(
    window.kotohaAuth.requireUser(),
    10000,
    'ログイン状態の確認が10秒以内に完了しませんでした。'
  );
  if (!currentUser) return;

  document.querySelector('#signout-button').addEventListener('click', window.kotohaAuth.signOut);
  document.querySelector('#new-chat').addEventListener('click', createConversation);

  if (note) note.textContent = 'Cloudflare Workerに接続中…';
  const workerResult = await verifyWorkerConnection();
  if (note) {
    note.textContent = workerResult.ok
      ? `🟢 サーバー接続確認: 成功（${workerResult.user?.role || 'user'}）`
      : `🔴 サーバー接続確認: ${workerResult.error || '失敗'}`;
  }
  console.log('Kotoha Worker auth test:', workerResult);

  document.querySelector('#chat-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = document.querySelector('#message-input');
    const content = input.value.trim();
    if (!content) return;
    if (!currentConversationId) await createConversation();
    const { error } = await client.from('messages').insert({ conversation_id: currentConversationId, role: 'user', content });
    if (error) { alert(error.message); return; }
    input.value = '';
    await openConversation(currentConversationId);
  });

  await loadConversations();
  await loadUsage();
  if (!currentConversationId) await createConversation();
}

initChat().catch(error => {
  console.error(error);
  const note = document.querySelector('#worker-status');
  if (note) note.textContent = `🔴 初期化エラー: ${error.message || '不明なエラー'}`;
});
