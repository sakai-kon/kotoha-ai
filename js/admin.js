(() => {
  const client = window.supabaseClient;

  const MODEL_OPTIONS = [
    { value: '', label: '全体設定を使用' },
    { value: '@cf/zai-org/glm-4.7-flash', label: 'GLM-4.7 Flash' },
    { value: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', label: 'Llama 3.3 70B' }
  ];

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));

  const numberOrNull = (value, min = 0, max = null) => {
    const text = String(value ?? '').trim();
    if (!text) return null;
    const number = Number(text);
    if (!Number.isFinite(number)) return null;
    const integer = Math.floor(number);
    if (integer < min) return null;
    if (max !== null && integer > max) return null;
    return integer;
  };

  const maxTokensOrNull = (value) => numberOrNull(value, 64, 8192);
  const maxConversationsOrNull = (value) => numberOrNull(value, 1, null);

  async function callUserManagement(payload) {
    const { data, error } = await client.functions.invoke('user-management', { body: payload });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    return data;
  }

  async function loadSettings() {
    const { data, error } = await client
      .from('app_settings')
      .select('*')
      .eq('id', true)
      .single();
    if (error) throw error;

    document.querySelector('#default-model').value = data.default_model || '';
    document.querySelector('#daily-request-limit').value = data.daily_request_limit ?? '';
    document.querySelector('#daily-search-limit').value = data.daily_search_limit ?? '';
    document.querySelector('#max-output-tokens').value = data.max_output_tokens ?? '';
    document.querySelector('#max-conversations').value = data.max_conversations ?? 20;
  }

  async function loadAdminOwnSettings(userId) {
    const { data, error } = await client
      .from('profiles')
      .select('model_override,max_output_tokens_override')
      .eq('id', userId)
      .single();
    if (error) throw error;

    document.querySelector('#admin-model').value = data.model_override || '';
    document.querySelector('#admin-max-output-tokens').value = data.max_output_tokens_override ?? '';
  }

  function modelOptions(selected = '') {
    return MODEL_OPTIONS.map((option) =>
      `<option value="${esc(option.value)}"${option.value === selected ? ' selected' : ''}>${esc(option.label)}</option>`
    ).join('');
  }

  function userEditor(user, conversationCount) {
    const isAdmin = user.role === 'admin';
    return `
      <div class="admin-user" data-user-card="${esc(user.id)}">
        <div class="admin-user-head">
          <div>
            <b>${esc(user.display_name || user.username || '管理者')}</b>
            <span>${esc(user.username || 'OAuth')}</span>
          </div>
          <span>${esc(user.role)} / ${esc(user.status)}</span>
        </div>

        <p class="status">会話数: ${conversationCount}${isAdmin ? ' / 無制限' : ''}</p>

        <div class="admin-user-settings">
          <label>モデル
            <select data-field="model">${modelOptions(user.model_override || '')}</select>
          </label>
          <label>質問上限/日
            <input data-field="request-limit" type="number" min="0" step="1" value="${esc(user.daily_request_limit_override ?? '')}" placeholder="全体設定">
          </label>
          <label>検索上限/日
            <input data-field="search-limit" type="number" min="0" step="1" value="${esc(user.daily_search_limit_override ?? '')}" placeholder="全体設定">
          </label>
          <label>最大出力トークン
            <input data-field="max-output-tokens" type="number" min="64" max="8192" step="1" value="${esc(user.max_output_tokens_override ?? '')}" placeholder="全体設定">
          </label>
          <label>会話上限
            <input data-field="max-conversations" type="number" min="1" step="1" value="${esc(user.max_conversations_override ?? '')}" placeholder="全体設定">
          </label>
        </div>

        <div class="admin-user-actions">
          <button type="button" class="button primary" data-save-settings="${esc(user.id)}">個別設定を保存</button>
          <button type="button" class="button secondary" data-reset-settings="${esc(user.id)}">全体設定に戻す</button>
          <button type="button" class="button secondary" data-delete-user-conversations="${esc(user.id)}">全会話を削除</button>
          ${isAdmin ? '<span class="status">管理者は質問・会話数無制限</span>' : `
            <button type="button" class="button secondary" data-status="active" data-id="${esc(user.id)}">再開</button>
            <button type="button" class="button secondary" data-status="suspended" data-id="${esc(user.id)}">一時停止</button>
            <button type="button" class="button secondary" data-status="disabled" data-id="${esc(user.id)}">利用停止</button>
            <button type="button" class="button secondary" data-delete="${esc(user.id)}">削除</button>
          `}
        </div>
        <p class="status" data-user-status="${esc(user.id)}"></p>
      </div>
    `;
  }

  async function getConversationCount(userId) {
    const { count, error } = await client
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    if (error) throw error;
    return Number(count || 0);
  }

  async function loadUsers() {
    const { data, error } = await client
      .from('profiles')
      .select('id,username,display_name,role,status,created_at,model_override,daily_request_limit_override,daily_search_limit_override,max_output_tokens_override,max_conversations_override')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const users = data || [];
    const counts = await Promise.all(users.map((user) => getConversationCount(user.id)));
    const list = document.querySelector('#user-list');
    list.innerHTML = users.map((user, index) => userEditor(user, counts[index])).join('');

    list.querySelectorAll('[data-save-settings]').forEach((button) => {
      button.addEventListener('click', async () => {
        const id = button.dataset.saveSettings;
        const card = list.querySelector(`[data-user-card="${CSS.escape(id)}"]`);
        const status = list.querySelector(`[data-user-status="${CSS.escape(id)}"]`);
        if (!card) return;

        const requestLimitRaw = card.querySelector('[data-field="request-limit"]').value;
        const searchLimitRaw = card.querySelector('[data-field="search-limit"]').value;
        const maxTokensRaw = card.querySelector('[data-field="max-output-tokens"]').value;
        const maxConversationsRaw = card.querySelector('[data-field="max-conversations"]').value;
        const requestLimit = numberOrNull(requestLimitRaw, 0);
        const searchLimit = numberOrNull(searchLimitRaw, 0);
        const maxTokens = maxTokensOrNull(maxTokensRaw);
        const maxConversations = maxConversationsOrNull(maxConversationsRaw);

        if (String(requestLimitRaw).trim() && requestLimit === null) return void (status.textContent = '質問上限の値が不正です。');
        if (String(searchLimitRaw).trim() && searchLimit === null) return void (status.textContent = '検索上限の値が不正です。');
        if (String(maxTokensRaw).trim() && maxTokens === null) return void (status.textContent = '最大出力トークンは64〜8192で指定してください。');
        if (String(maxConversationsRaw).trim() && maxConversations === null) return void (status.textContent = '会話上限は1以上で指定してください。');

        status.textContent = '保存中…';
        try {
          await callUserManagement({
            action: 'set_limits',
            user_id: id,
            model_override: card.querySelector('[data-field="model"]').value || null,
            daily_request_limit_override: requestLimit,
            daily_search_limit_override: searchLimit,
            max_output_tokens_override: maxTokens,
            max_conversations_override: maxConversations
          });
          await loadUsers();
        } catch (error) {
          status.textContent = `保存に失敗しました: ${error.message}`;
        }
      });
    });

    list.querySelectorAll('[data-reset-settings]').forEach((button) => {
      button.addEventListener('click', async () => {
        const id = button.dataset.resetSettings;
        if (!confirm('このユーザーを全体設定に戻しますか？')) return;
        try {
          await callUserManagement({
            action: 'set_limits',
            user_id: id,
            model_override: null,
            daily_request_limit_override: null,
            daily_search_limit_override: null,
            max_output_tokens_override: null,
            max_conversations_override: null
          });
          await loadUsers();
        } catch (error) {
          const status = list.querySelector(`[data-user-status="${CSS.escape(id)}"]`);
          status.textContent = `リセットに失敗しました: ${error.message}`;
        }
      });
    });

    list.querySelectorAll('[data-delete-user-conversations]').forEach((button) => {
      button.addEventListener('click', async () => {
        const id = button.dataset.deleteUserConversations;
        if (!confirm('このユーザーの会話をすべて削除しますか？この操作は元に戻せません。')) return;
        try {
          const result = await callUserManagement({ action: 'delete_user_conversations', user_id: id });
          alert(`${result.deleted_count ?? 0}件の会話を削除しました。`);
          await loadUsers();
        } catch (error) {
          alert(error.message);
        }
      });
    });

    list.querySelectorAll('[data-status]').forEach((button) => {
      button.addEventListener('click', async () => {
        try {
          await callUserManagement({ action: 'set_status', user_id: button.dataset.id, status: button.dataset.status });
          await loadUsers();
        } catch (error) {
          alert(error.message);
        }
      });
    });

    list.querySelectorAll('[data-delete]').forEach((button) => {
      button.addEventListener('click', async () => {
        if (!confirm('このアカウントを削除しますか？')) return;
        try {
          await callUserManagement({ action: 'delete', user_id: button.dataset.delete });
          await loadUsers();
        } catch (error) {
          alert(error.message);
        }
      });
    });
  }

  async function initAdmin() {
    const user = await window.kotohaAuth.requireUser();
    if (!user) return;

    const { data: profile, error: profileError } = await client
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();
    if (profileError || !profile || profile.role !== 'admin') {
      document.querySelector('#admin-guard').textContent = 'このページにアクセスする権限がありません。';
      return;
    }

    document.querySelector('#admin-guard').hidden = true;
    document.querySelector('#admin-content').hidden = false;

    await Promise.all([loadSettings(), loadAdminOwnSettings(user.id), loadUsers()]);

    document.querySelector('#admin-settings-form').onsubmit = async (event) => {
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
          max_output_tokens_override: maxTokensOrNull(document.querySelector('#admin-max-output-tokens').value),
          max_conversations_override: null
        });
        status.textContent = '自分のAI設定を保存しました。';
      } catch (error) {
        status.textContent = `保存に失敗しました: ${error.message}`;
      }
    };

    document.querySelector('#settings-form').onsubmit = async (event) => {
      event.preventDefault();
      const status = document.querySelector('#settings-status');
      status.textContent = '保存中…';

      const dailyRequestLimit = numberOrNull(document.querySelector('#daily-request-limit').value, 0);
      const dailySearchLimit = numberOrNull(document.querySelector('#daily-search-limit').value, 0);
      const maxOutputTokens = maxTokensOrNull(document.querySelector('#max-output-tokens').value);
      const maxConversations = maxConversationsOrNull(document.querySelector('#max-conversations').value);

      if (dailyRequestLimit === null || dailySearchLimit === null || maxOutputTokens === null || maxConversations === null) {
        status.textContent = '全体設定の入力値を確認してください。';
        return;
      }

      try {
        const { error } = await client
          .from('app_settings')
          .update({
            default_model: document.querySelector('#default-model').value,
            daily_request_limit: dailyRequestLimit,
            daily_search_limit: dailySearchLimit,
            max_output_tokens: maxOutputTokens,
            max_conversations: maxConversations,
            updated_at: new Date().toISOString(),
            updated_by: user.id
          })
          .eq('id', true);
        if (error) throw error;
        status.textContent = '全体設定を保存しました。';
      } catch (error) {
        status.textContent = `保存に失敗しました: ${error.message}`;
      }
    };

    document.querySelector('#create-user-form').onsubmit = async (event) => {
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
        status.textContent = `${result.role === 'admin' ? '管理者' : 'ユーザー'}アカウントを作成しました。`;
        await loadUsers();
      } catch (error) {
        status.textContent = error.message;
      }
    };

    const [periods, logs] = await Promise.all([
      client.from('special_periods').select('*').order('start_at', { ascending: false }),
      client.from('admin_logs').select('*').order('created_at', { ascending: false }).limit(30)
    ]);
    document.querySelector('#special-periods').textContent = JSON.stringify(periods.data || [], null, 2);
    document.querySelector('#admin-logs').textContent = JSON.stringify(logs.data || [], null, 2);
  }

  initAdmin().catch((error) => {
    console.error('Admin initialization failed:', error);
    const guard = document.querySelector('#admin-guard');
    if (guard) guard.textContent = `管理画面の初期化に失敗しました: ${error.message}`;
  });
})();
