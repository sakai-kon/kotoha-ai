(() => {
  const client = window.supabaseClient;
  let currentUser = null;
  let currentConversationId = null;

  const config = window.KOTOHA_CONFIG || {};
  const API_URL = String(config.API_URL || '').replace(/\/$/, '');
  const SUPABASE_URL = String(config.SUPABASE_URL || '').replace(/\/$/, '');
  const SUPABASE_KEY = config.SUPABASE_PUBLISHABLE_KEY || '';

  const MODEL_LIMITS = {
    '@cf/google/gemma-4-26b-a4b-it': 5,
    '@cf/meta/llama-3.2-1b-instruct': 10
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'\"]/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&#34;'
    }[c]));
  }

  function inlineMarkdown(value) {
    let text = escapeHtml(value);
    text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    text = text.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return text;
  }

  function markdownToHtml(markdown) {
    const source = String(markdown ?? '').replace(/\r\n?/g, '\n');
    const lines = source.split('\n');
    const out = [];
    let inCode = false;
    let codeBuffer = [];
    let codeLanguage = '';
    let listType = null;

    const closeList = () => {
      if (listType) {
        out.push(`</${listType}>`);
        listType = null;
      }
    };

    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        if (!inCode) {
          closeList();
          inCode = true;
          codeLanguage = line.replace(/^\s*```/, '').trim();
          codeBuffer = [];
        } else {
          const languageClass = codeLanguage ? ` class="language-${escapeHtml(codeLanguage)}"` : '';
          out.push(`<pre><code${languageClass}>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`);
          inCode = false;
          codeLanguage = '';
          codeBuffer = [];
        }
        continue;
      }

      if (inCode) {
        codeBuffer.push(line);
        continue;
      }

      if (/^\s*$/.test(line)) {
        closeList();
        continue;
      }

      const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*$/);
      if (heading) {
        closeList();
        const level = heading[1].length;
        out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
        continue;
      }

      const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
      if (unordered) {
        if (listType !== 'ul') {
          closeList();
          out.push('<ul>');
          listType = 'ul';
        }
        out.push(`<li>${inlineMarkdown(unordered[1])}</li>`);
        continue;
      }

      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (ordered) {
        if (listType !== 'ol') {
          closeList();
          out.push('<ol>');
          listType = 'ol';
        }
        out.push(`<li>${inlineMarkdown(ordered[1])}</li>`);
        continue;
      }

      const quote = line.match(/^\s*>\s?(.*)$/);
      if (quote) {
        closeList();
        out.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);
        continue;
      }

      closeList();
      out.push(`<p>${inlineMarkdown(line)}</p>`);
    }

    if (inCode) {
      out.push(`<pre><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`);
    }
    closeList();
    return out.join('');
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
      }), 10000, 'Cloudflare Workerが応答しませんでした。');
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
    document.querySelector('#message-list').innerHTML = '';
    for (const m of messages || []) {
      renderMessage(m.role, m.content, false);
    }
    const list = document.querySelector('#message-list');
    list.scrollTop = list.scrollHeight;
  }

  async function loadUsage() {
    try {
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' });
      const rows = await dbFetch('usage_model_daily?select=model,request_count&user_id=eq.' + encodeURIComponent(currentUser.id) + '&usage_date=eq.' + encodeURIComponent(today));
      const counts = Object.fromEntries((rows || []).map(row => [row.model, row.request_count || 0]));
      const usage = document.querySelector('#usage-summary');
      if (!usage) return;
      usage.textContent = `Gemma ${counts['@cf/google/gemma-4-26b-a4b-it'] || 0}/5 · Llama ${counts['@cf/meta/llama-3.2-1b-instruct'] || 0}/10`;

      const selector = document.querySelector('#model-select');
      if (selector) {
        for (const option of selector.options) {
          const used = counts[option.value] || 0;
          const limit = MODEL_LIMITS[option.value];
          option.textContent = option.value.includes('gemma-4')
            ? `Gemma 4 26B · ${Math.max(0, limit - used)}回残り`
            : `Llama 3.2 1B · ${Math.max(0, limit - used)}回残り`;
          option.disabled = used >= limit;
        }
        const selected = selector.options[selector.selectedIndex];
        if (selected?.disabled) {
          const fallback = [...selector.options].find(option => !option.disabled);
          if (fallback) selector.value = fallback.value;
        }
      }
    } catch (error) {
      const usage = document.querySelector('#usage-summary');
      if (usage) usage.textContent = '利用状況を取得できません';
      console.error('Usage load failed:', error);
    }
  }

  function renderMessage(role, content, streaming = false) {
    const list = document.querySelector('#message-list');
    const article = document.createElement('article');
    article.className = `message ${role}`;
    if (streaming) article.dataset.streaming = 'true';
    article.innerHTML = `<strong>${role === 'user' ? 'あなた' : 'Kotoha'}</strong><div class="message-content"></div>`;
    const contentNode = article.querySelector('.message-content');
    contentNode.innerHTML = role === 'assistant'
      ? markdownToHtml(content)
      : escapeHtml(content).replace(/\n/g, '<br>');
    list.appendChild(article);
    list.scrollTop = list.scrollHeight;
    return article;
  }

  async function sendChatMessage(content, model, onChunk) {
    if (!currentConversationId) await createConversation();
    const token = await getAccessToken();
    const response = await withTimeout(fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ conversation_id: currentConversationId, message: content, model })
    }), 90000, 'AIの応答が90秒以内に完了しませんでした。');

    if (!response.ok) {
      const errorData = await response.json().catch(() => null);
      throw new Error(errorData?.error || `Worker error: ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream') || !response.body) {
      const result = await response.json().catch(() => ({ ok: false, error: 'WorkerからJSON応答を取得できませんでした。' }));
      if (!result.ok) throw new Error(result.error || 'AI応答に失敗しました。');
      onChunk(result.answer || '');
      return result.answer || '';
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let answer = '';

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
          const parsed = JSON.parse(payload);
          const part = parsed?.response || parsed?.text || parsed?.choices?.[0]?.delta?.content || parsed?.choices?.[0]?.message?.content || parsed?.choices?.[0]?.text || '';
          if (typeof part === 'string' && part) {
            answer += part;
            onChunk(answer);
          }
        } catch {
          // Ignore non-JSON SSE lines.
        }
      }
    }

    return answer.trim();
  }

  async function initChat() {
    try {
      setStatus('JavaScriptを初期化しました。');
      if (!client) throw new Error('Supabaseクライアントが読み込まれていません。');
      currentUser = await withTimeout(window.kotohaAuth.requireUser(), 10000, 'ログイン状態の確認がタイムアウトしました。');
      if (!currentUser) return;

      const signout = document.querySelector('#signout-button');
      if (signout) signout.addEventListener('click', window.kotohaAuth.signOut);
      document.querySelector('#new-chat').addEventListener('click', async () => {
        try { await createConversation(); setStatus('🟢 新しいチャットを作成しました。'); }
        catch (error) { setStatus(`🔴 ${error.message}`); }
      });

      setStatus('Cloudflare Workerへ接続しています…');
      const workerResult = await verifyWorkerConnection();
      setStatus(workerResult.ok ? `🟢 サーバー接続確認: 成功（${workerResult.user?.role || 'user'}）` : `🔴 サーバー接続確認: ${workerResult.error}`);

      await loadConversations();
      const first = document.querySelector('.conversation-item');
      if (first) await openConversation(first.dataset.id);
      await loadUsage();

      document.querySelector('#chat-form').addEventListener('submit', async event => {
        event.preventDefault();
        const input = document.querySelector('#message-input');
        const button = document.querySelector('#send-button');
        const selector = document.querySelector('#model-select');
        const content = input.value.trim();
        const model = selector?.value || '@cf/google/gemma-4-26b-a4b-it';
        if (!content || button.disabled) return;

        let assistantMessage = null;
        try {
          setBusy(button, true);
          input.value = '';
          renderMessage('user', content);
          assistantMessage = renderMessage('assistant', '生成中…', true);
          const answer = await sendChatMessage(content, model, partial => {
            if (!assistantMessage) return;
            assistantMessage.querySelector('.message-content').innerHTML = markdownToHtml(partial || '生成中…');
            const list = document.querySelector('#message-list');
            list.scrollTop = list.scrollHeight;
          });
          assistantMessage.querySelector('.message-content').innerHTML = markdownToHtml(answer || 'AIから有効な回答を取得できませんでした。');
          assistantMessage.removeAttribute('data-streaming');
          await openConversation(currentConversationId);
          await loadConversations();
          await loadUsage();
          setStatus('🟢 送信完了');
        } catch (error) {
          assistantMessage?.remove();
          input.value = content;
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
