(() => {
  const client = window.supabaseClient;

  // Current Workers AI Text Generation models that remain available on the Free plan.
  // Paid-only models are intentionally excluded from the administrator UI.
  const FREE_TEXT_MODELS = [
    ['@cf/zai-org/glm-4.7-flash', 'GLM-4.7 Flash · 高速'],
    ['@cf/google/gemma-4-26b-a4b-it', 'Gemma 4 26B'],
    ['@cf/nvidia/nemotron-3-120b-a12b', 'Nemotron 3 120B A12B'],
    ['@cf/openai/gpt-oss-20b', 'GPT-OSS 20B'],
    ['@cf/openai/gpt-oss-120b', 'GPT-OSS 120B'],
    ['@cf/ibm/granite-4.0-h-micro', 'Granite 4.0 H Micro'],
    ['@cf/aisingapore/gemma-sea-lion-v4-27b-it', 'SEA-LION V4 27B'],
    ['@cf/meta/llama-3.1-8b-instruct-fast', 'Llama 3.1 8B · 高速'],
    ['@cf/meta/llama-3.1-8b-instruct-fp8', 'Llama 3.1 8B FP8'],
    ['@cf/meta/llama-3.2-1b-instruct', 'Llama 3.2 1B'],
    ['@cf/meta/llama-3.2-3b-instruct', 'Llama 3.2 3B'],
    ['@cf/meta/llama-3.2-11b-vision-instruct', 'Llama 3.2 11B Vision'],
    ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'Llama 3.3 70B · 高速'],
    ['@cf/meta/llama-4-scout-17b-16e-instruct', 'Llama 4 Scout 17B'],
    ['@cf/mistralai/mistral-small-3.1-24b-instruct', 'Mistral Small 3.1 24B'],
    ['@cf/qwen/qwen2.5-coder-32b-instruct', 'Qwen 2.5 Coder 32B'],
    ['@cf/qwen/qwen3-30b-a3b-fp8', 'Qwen 3 30B A3B FP8'],
    ['@cf/qwen/qwq-32b', 'QwQ 32B']
  ].map(([value, label]) => ({ value, label }));

  const NORMAL_MODELS = [
    { value: '@cf/google/gemma-4-26b-a4b-it', label: 'Gemma 4 26B · 5回/日' },
    { value: '@cf/meta/llama-3.2-1b-instruct', label: 'Llama 3.2 1B · 10回/日' }
  ];

  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

  const intOrNull = (value, min = 0, max = null) => {
    const text = String(value ?? '').trim();
    if (!text) return null;
    const n = Number(text);
    if (!Number.isFinite(n)) return null;
    const integer = Math.floor(n);
    if (integer < min) return null;
    if (max !== null && integer > max) return null;
    return integer;
  };

  async function callUserManagement(payload) {
    const { data, error } = await client.functions.invoke('user-management', { body: payload });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    return data;
  }

  function optionHtml(options, selected = '') {
    return options.map(option => `<option value="${esc(option.value)}"${option.value === selected ? ' selected' : ''}>${esc(option.label)}</option>`).join('');
  }

  function adminModelOptions(selected = '') {
    return optionHtml([{ value: '', label: '全体設定を使用' }, ...FREE_TEXT_MODELS], selected);
  }

  function userModelOptions(user, selected = '') {
    const options = user.role === 'admin'
      ? [{ value: '', label: '全体設定を使用' }, ...FREE_TEXT_MODELS]
      : [{ value: '', label: '全体設定を使用' }, ...NORMAL_MODELS];
    return optionHtml(options, selected);
  }

  async function loadSettings() {
    const { data, error } = await client.from('app_settings').select('*').eq('id', true).single();
    if (error) throw error;
    document.querySelector('#default-model').value = NORMAL_MODELS.some(x => x.value === data.default_model)
      ? data.default_model
      : NORMAL_MODELS[0].value;
    document.querySelector('#daily-request-limit').value = 15;
    document.querySelector('#daily-search-limit').value = data.daily_search_limit ?? 0;
    document.querySelector('#max-output-tokens').value = Math.min(Number(data.max_output_tokens || 512), 512);
    document.querySelector('#max-conversations').value = data.max_conversations ?? 20;
  }

  async function loadAdminOwnSettings(userId) {
    const { data, error } = await client.from('profiles')
      .select('model_override,max_output_tokens_override')
      .eq('id', userId)
      .single();
    if (error) throw error;
    document.querySelector('#admin-model').innerHTML = adminModelOptions(data.model_override || '');
    document.querySelector('#admin-max-output-tokens').value = data.max_output_tokens_override ?? '';
  }

  async function getConversationCount(userId) {
    const { count, error } = await client
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    if (error) throw error;
    return Number(count || 0);
  }

  function renderUser(user, conversationCount) {
    const admin = user.role === 'admin';
    return `
      <div class="admin-user" data-user-card="${esc(user.id)}">
        <div class="admin-user-head">
          <div><b>${esc(user.display_name || user.username || 'ユーザー')}</b><span>${esc(user.username || 'OAuth')}</span></div>
          <span>${esc(user.role)} / ${esc(user.status)}</span>
        </div>
        <p class="status">会話数: ${conversationCount}${admin ? ' / 無制限' : ''}</p>
        <div class="admin-user-settings">
          <label>モデル<select data-field="model">${userModelOptions(user, user.model_override || '')}</select></label>
          <label>質問上限/日<input data-field="request" type="number" min="1" value="${esc(user.daily_request_limit_override ?? '')}" placeholder="全体設定"></label>
          <label>検索上限/日<input data-field="search" type="number" min="0" value="${esc(user.daily_search_limit_override ?? '')}" placeholder="全体設定"></label>
          <label>最大出力トークン<input data-field="tokens" type="number" min="64" max="8192" value="${esc(user.max_output_tokens_override ?? '')}" placeholder="全体設定"></label>
          <label>会話上限<input data-field="conversations" type="number" min="1" value="${esc(user.max_conversations_override ?? '')}" placeholder="全体設定"></label>
        </div>
        <div class="admin-user-actions">
          <button type="button" class="button primary" data-save="${esc(user.id)}">個別設定を保存</button>
          <button type="button" class="button secondary" data-reset="${esc(user.id)}">全体設定に戻す</button>
          <button type="button" class="button secondary" data-clear-conversations="${esc(user.id)}">全会話を削除</button>
          ${admin ? '<span class="status">管理者は質問・会話数無制限</span>' : `
            <button type="button" class="button secondary" data-status="active" data-id="${esc(user.id)}">再開</button>
            <button type="button" class="button secondary" data-status="suspended" data-id="${esc(user.id)}">一時停止</button>
            <button type="button" class="button secondary" data-status="disabled" data-id="${esc(user.id)}">利用停止</button>
            <button type="button" class="button secondary" data-delete="${esc(user.id)}">削除</button>`}
        </div>
        <p class="status" data-status-text="${esc(user.id)}"></p>
      </div>`;
  }

  async function loadUsers() {
    const { data, error } = await client.from('profiles').select(
      'id,username,display_name,role,status,created_at,model_override,daily_request_limit_override,daily_search_limit_override,max_output_tokens_override,max_conversations_override'
    ).order('created_at', { ascending: false });
    if (error) throw error;

    const users = data || [];
    const counts = await Promise.all(users.map(user => getConversationCount(user.id)));
    const list = document.querySelector('#user-list');
    list.innerHTML = users.map((user, index) => renderUser(user, counts[index])).join('');

    list.querySelectorAll('[data-save]').forEach(button => button.onclick = async () => {
      const id = button.dataset.save;
      const card = list.querySelector(`[data-user-card="${CSS.escape(id)}"]`);
      const status = list.querySelector(`[data-status-text="${CSS.escape(id)}"]`);
      if (!card) return;
      const model = card.querySelector('[data-field="model"]').value || null;
      const request = intOrNull(card.querySelector('[data-field="request"]').value, 1);
      const search = intOrNull(card.querySelector('[data-field="search"]').value, 0);
      const tokens = intOrNull(card.querySelector('[data-field="tokens"]').value, 64, 8192);
      const conversations = intOrNull(card.querySelector('[data-field="conversations"]').value, 1);
      if (card.querySelector('[data-field="request"]').value && request === null) return void (status.textContent = '質問上限が不正です。');
      if (card.querySelector('[data-field="search"]').value && search === null) return void (status.textContent = '検索上限が不正です。');
      if (card.querySelector('[data-field="tokens"]').value && tokens === null) return void (status.textContent = '最大出力トークンは64〜8192です。');
      if (card.querySelector('[data-field="conversations"]').value && conversations === null) return void (status.textContent = '会話上限が不正です。');
      status.textContent = '保存中…';
      try {
        await callUserManagement({
          action: 'set_limits',
          user_id: id,
          model_override: model,
          daily_request_limit_override: request,
          daily_search_limit_override: search,
          max_output_tokens_override: tokens,
          max_conversations_override: conversations
        });
        await loadUsers();
      } catch (error) {
        status.textContent = error.message;
      }
    });

    list.querySelectorAll('[data-reset]').forEach(button => button.onclick = async () => {
      if (!confirm('このユーザーを全体設定へ戻しますか？')) return;
      try {
        await callUserManagement({
          action: 'set_limits',
          user_id: button.dataset.reset,
          model_override: null,
          daily_request_limit_override: null,
          daily_search_limit_override: null,
          max_output_tokens_override: null,
          max_conversations_override: null
        });
        await loadUsers();
      } catch (error) { alert(error.message); }
    });

    list.querySelectorAll('[data-clear-conversations]').forEach(button => button.onclick = async () => {
      if (!confirm('このユーザーの全会話を削除しますか？元に戻せません。')) return;
      try {
        const result = await callUserManagement({ action: 'delete_user_conversations', user_id: button.dataset.clearConversations });
        alert(`${result.deleted_count ?? 0}件の会話を削除しました。`);
        await loadUsers();
      } catch (error) { alert(error.message); }
    });

    list.querySelectorAll('[data-status]').forEach(button => button.onclick = async () => {
      try {
        await callUserManagement({ action: 'set_status', user_id: button.dataset.id, status: button.dataset.status });
        await loadUsers();
      } catch (error) { alert(error.message); }
    });

    list.querySelectorAll('[data-delete]').forEach(button => button.onclick = async () => {
      if (!confirm('このアカウントを削除しますか？')) return;
      try {
        await callUserManagement({ action: 'delete', user_id: button.dataset.delete });
        await loadUsers();
      } catch (error) { alert(error.message); }
    });
  }

  async function initAdmin() {
    const user = await window.kotohaAuth.requireUser();
    if (!user) return;
    const { data: profile, error } = await client.from('profiles').select('role').eq('id', user.id).single();
    if (error || !profile || profile.role !== 'admin') {
      document.querySelector('#admin-guard').textContent = 'このページにアクセスする権限がありません。';
      return;
    }
    document.querySelector('#admin-guard').hidden = true;
    document.querySelector('#admin-content').hidden = false;

    await Promise.all([loadSettings(), loadAdminOwnSettings(user.id), loadUsers()]);

    document.querySelector('#admin-settings-form').onsubmit = async event => {
      event.preventDefault();
      const status = document.querySelector('#admin-settings-status');
      status.textContent = '保存中…';
      try {
        await callUserManagement({
          action: 'set_limits',
          user_id: user.id,
          model_override: document.querySelector('#admin-model').value || null,
          daily_request_limit_override: null,
          daily_search_limit_override: null,
          max_output_tokens_override: intOrNull(document.querySelector('#admin-max-output-tokens').value, 64, 8192),
          max_conversations_override: null
        });
        status.textContent = '自分のAI設定を保存しました。';
      } catch (error) { status.textContent = error.message; }
    };

    document.querySelector('#settings-form').onsubmit = async event => {
      event.preventDefault();
      const status = document.querySelector('#settings-status');
      try {
        const requestLimit = intOrNull(document.querySelector('#daily-request-limit').value, 1);
        const maxTokens = intOrNull(document.querySelector('#max-output-tokens').value, 64, 8192);
        if (requestLimit !== 15) throw new Error('一般ユーザーの全体質問上限は15回です（Gemma 5 + Llama 10）。');
        if (maxTokens === null) throw new Error('最大出力トークンは64〜8192です。');
        const { error } = await client.from('app_settings').update({
          default_model: document.querySelector('#default-model').value,
          daily_request_limit: 15,
          daily_search_limit: intOrNull(document.querySelector('#daily-search-limit').value, 0) || 0,
          max_output_tokens: Math.min(maxTokens, 512),
          max_conversations: intOrNull(document.querySelector('#max-conversations').value, 1),
          updated_at: new Date().toISOString(),
          updated_by: user.id
        }).eq('id', true);
        if (error) throw error;
        status.textContent = '一般ユーザー設定を保存しました。';
      } catch (error) { status.textContent = error.message; }
    };

    document.querySelector('#create-user-form').onsubmit = async event => {
      event.preventDefault();
      const status = document.querySelector('#user-status');
      status.textContent = '作成中…';
      try {
        const result = await callUserManagement({
          action: 'create',
          username: document.querySelector('#new-username').value.trim(),
          display_name: document.querySelector('#new-display-name').value.trim(),
          role: document.querySelector('#new-role').value,
          password: document.querySelector('#new-password').value
        });
        event.target.reset();
        status.textContent = `${result.role === 'admin' ? '管理者' : '通常ユーザー'}アカウントを作成しました。`;
        await loadUsers();
      } catch (error) { status.textContent = error.message; }
    };

    const [periods, logs] = await Promise.all([
      client.from('special_periods').select('*').order('start_at', { ascending: false }),
      client.from('admin_logs').select('*').order('created_at', { ascending: false }).limit(30)
    ]);
    document.querySelector('#special-periods').textContent = JSON.stringify(periods.data || [], null, 2);
    document.querySelector('#admin-logs').textContent = JSON.stringify(logs.data || [], null, 2);

    const signout = document.querySelector('#signout-button');
    if (signout) signout.onclick = window.kotohaAuth.signOut;
  }

  initAdmin().catch(error => {
    console.error('Admin initialization failed:', error);
    const guard = document.querySelector('#admin-guard');
    if (guard) guard.textContent = `管理画面の初期化に失敗しました: ${error.message}`;
  });
})();
