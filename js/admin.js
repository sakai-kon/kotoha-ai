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

  const numberOrNull = (value) => {
    const text = String(value ?? '').trim();
    if (!text) return null;
    const number = Number(text);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
  };

  const maxTokensOrNull = (value) => {
    const number = numberOrNull(value);
    if (number === null) return null;
    return Math.max(64, Math.min(8192, number));
  };

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

  function userEditor(user) {
    const isAdmin = user.role === 'admin';
    const requestValue = user.daily_request_limit_override ?? '';
    const searchValue = user.daily_search_limit_override ?? '';
    const maxTokensValue = user.max_output_tokens_override ?? '';

    return `
      <div class="admin-user" data-user-card="${esc(user.id)}">
        <div class="admin-user-head">
          <div>
            <b>${esc(user.display_name || user.username || '管理者')}</b>
            <span>${esc(user.username || 'OAuth')}</span>
          </div>
          <span>${esc(user.role)} / ${esc(user.status)}</span>
        </div>

        <div class="admin-user-settings">
          <label>モデル
            <select data-field="model">${modelOptions(user.model_override || '')}</select>
          </label>

          <label>質問上限/日
            <input data-field="request-limit" type="number" min="0" step="1" value="${esc(requestValue)}" placeholder="全体設定">
          </label>

          <label>検索上限/日
            <input data-field="search-limit" type="number" min="0" step="1" value="${esc(searchValue)}" placeholder="全体設定">
          </label>

          <label>最大出力トークン
            <input data-field="max-output-tokens" type="number" min="64" max="8192" step="1" value="${esc(maxTokensValue)}" placeholder="全体設定">
          </label>
        </div>

        <div class="admin-user-actions">
          <button type="button" class="button primary" data-save-settings="${esc(user.id)}">個別設定を保存</button>
          <button type="button" class="button secondary" data-reset-settings="${esc(user.id)}">全体設定に戻す</button>
          ${isAdmin ? '<span class="status">管理者は質問回数上限なし</span>' : `
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

  async function loadUsers() {
    const { data, error } = await client
      .from('profiles')
      .select('id,username,display_name,role,status,created_at,model_override,daily_request_limit_override,daily_search_limit_override,max_output_tokens_override')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const list = document.querySelector('#user-list');
    list.innerHTML = (data || []).map(userEditor).join('');

    list.querySelectorAll('[data-save-settings]').forEach((button) => {
      button.addEventListener('click', async () => {
        const id = button.dataset.saveSettings;
        const card = list.querySelector(`[data-user-card="${CSS.escape(id)}"]`);
        const status = list.querySelector(`[data-user-status="${CSS.escape(id)}"]`);
        if (!card) return;

        const model = card.querySelector('[data-field="model"]').value || null;
        const requestLimit = numberOrNull(card.querySelector('[data-field="request-limit"]').value);
        const searchLimit = numberOrNull(card.querySelector('[data-field="search-limit"]').value);
        const maxTokens = maxTokensOrNull(card.querySelector('[data-field="max-output-tokens"]').value);

        status.textContent = '保存中…';

        try {
          const { error: updateError } = await client
            .from('profiles')
            .update({
              model_override: model,
              daily_request_limit_override: requestLimit,
              daily_search_limit_override: searchLimit,
              max_output_tokens_override: maxTokens,
              updated_at: new Date().toISOString()
            })
            .eq('id', id);

          if (updateError) throw updateError;
          status.textContent = '個別設定を保存しました。';
        } catch (error) {
          status.textContent = `保存に失敗しました: ${error.message}`;
        }
      });
    });

    list.querySelectorAll('[data-reset-settings]').forEach((button) => {
      button.addEventListener('click', async () => {
        const id = button.dataset.resetSettings;
        const card = list.querySelector(`[data-user-card="${CSS.escape(id)}"]`);
        const status = list.querySelector(`[data-user-status="${CSS.escape(id)}"]`);
        if (!card) return;

        status.textContent = '全体設定に戻しています…';

        try {
          const { error: updateError } = await client
            .from('profiles')
            .update({
              model_override: null,
              daily_request_limit_override: null,
              daily_search_limit_override: null,
              max_output_tokens_override: null,
              updated_at: new Date().toISOString()
            })
            .eq('id', id);

          if (updateError) throw updateError;
          status.textContent = '全体設定に戻しました。';
          await loadUsers();
        } catch (error) {
          status.textContent = `リセットに失敗しました: ${error.message}`;
        }
      });
    });

    list.querySelectorAll('[data-status]').forEach((button) => {
      button.addEventListener('click', async () => {
        try {
          await callUserManagement({
            action: 'set_status',
            user_id: button.dataset.id,
            status: button.dataset.status
          });
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
          await callUserManagement({
            action: 'delete',
            user_id: button.dataset.delete
          });
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

    await Promise.all([
      loadSettings(),
      loadAdminOwnSettings(user.id),
      loadUsers()
    ]);

    document.querySelector('#admin-settings-form').onsubmit = async (event) => {
      event.preventDefault();
      const status = document.querySelector('#admin-settings-status');
      status.textContent = '保存中…';

      try {
        const { error } = await client
          .from('profiles')
          .update({
            model_override: document.querySelector('#admin-model').value || null,
            max_output_tokens_override: maxTokensOrNull(document.querySelector('#admin-max-output-tokens').value),
            updated_at: new Date().toISOString()
          })
          .eq('id', user.id);

        if (error) throw error;
        status.textContent = '自分のAI設定を保存しました。';
      } catch (error) {
        status.textContent = `保存に失敗しました: ${error.message}`;
      }
    };

    document.querySelector('#settings-form').onsubmit = async (event) => {
      event.preventDefault();
      const status = document.querySelector('#settings-status');
      status.textContent = '保存中…';

      try {
        const { error } = await client
          .from('app_settings')
          .update({
            default_model: document.querySelector('#default-model').value,
            daily_request_limit: Math.max(0, Math.floor(Number(document.querySelector('#daily-request-limit').value))),
            daily_search_limit: Math.max(0, Math.floor(Number(document.querySelector('#daily-search-limit').value))),
            max_output_tokens: Math.max(64, Math.min(8192, Math.floor(Number(document.querySelector('#max-output-tokens').value)))),
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
        await callUserManagement({
          action: 'create',
          username: document.querySelector('#new-username').value.trim(),
          display_name: document.querySelector('#new-display-name').value.trim(),
          password: document.querySelector('#new-password').value
        });

        event.target.reset();
        status.textContent = 'アカウントを作成しました。';
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
