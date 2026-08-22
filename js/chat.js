(() => {
const client = window.supabaseClient;
let currentUser = null;
let currentConversationId = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&#34;' }[c]));
}
function setStatus(message) { const note = document.querySelector('#worker-status'); if (note) note.textContent = message; }
function setBusy(button, busy) { if (button) button.disabled = busy; }
function withTimeout(promise, ms, message) { let id; const timeout = new Promise((_, reject) => { id = setTimeout(() => reject(new Error(message)), ms); }); return Promise.race([promise, timeout]).finally(() => clearTimeout(id)); }
function getApiUrl() { return window.KOTOHA_CONFIG?.API_URL?.replace(/\/$/, '') || ''; }
async function getAccessToken() { const { data, error } = await client.auth.getSession(); if (error || !data?.session?.access_token) throw new Error('ログインセッションを取得できませんでした。'); return data.session.access_token; }
async function verifyWorkerConnection() {
  const apiUrl = getApiUrl(); if (!apiUrl) return { ok:false, error:'Cloudflare Worker URLが設定されていません。' };
  try { const token = await withTimeout(getAccessToken(),5000,'Supabaseセッション取得がタイムアウトしました。'); const response = await withTimeout(fetch(apiUrl,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},body:JSON.stringify({action:'auth_test'})}),15000,'Cloudflare Workerが15秒以内に応答しませんでした。'); const result = await response.json().catch(()=>({ok:false,error:'WorkerからJSON応答を取得できませんでした。'})); return (!response.ok || !result.ok) ? {ok:false,error:result.error || `Worker error: ${response.status}`} : result; } catch (error) { return {ok:false,error:error instanceof Error ? error.message : String(error)}; }
}
async function createConversation() { const {data,error}=await client.from('conversations').insert({user_id:currentUser.id}).select('id,title,updated_at').single(); if(error) throw new Error(`会話作成に失敗しました: ${error.message}`); currentConversationId=data.id; document.querySelector('#conversation-title').textContent=data.title||'新しいチャット'; document.querySelector('#message-list').innerHTML=''; await loadConversations(); }
async function loadConversations() { const {data,error}=await client.from('conversations').select('id,title,updated_at').eq('user_id',currentUser.id).order('updated_at',{ascending:false}); if(error) throw new Error(`会話一覧の取得に失敗しました: ${error.message}`); const list=document.querySelector('#conversation-list'); list.innerHTML=(data||[]).map(c=>`<button class="conversation-item" data-id="${escapeHtml(c.id)}">${escapeHtml(c.title)}</button>`).join(''); list.querySelectorAll('.conversation-item').forEach(button=>button.addEventListener('click',()=>openConversation(button.dataset.id).catch(error=>setStatus(`🔴 ${error.message}`)))); }
async function openConversation(id) { const {data:conversation,error:conversationError}=await client.from('conversations').select('id,title').eq('id',id).eq('user_id',currentUser.id).single(); if(conversationError) throw new Error(`会話の取得に失敗しました: ${conversationError.message}`); currentConversationId=conversation.id; document.querySelector('#conversation-title').textContent=conversation.title||'チャット'; const {data,error}=await client.from('messages').select('role,content,created_at').eq('conversation_id',id).order('created_at',{ascending:true}); if(error) throw new Error(`メッセージの取得に失敗しました: ${error.message}`); document.querySelector('#message-list').innerHTML=(data||[]).map(m=>`<article class="message ${escapeHtml(m.role)}"><strong>${m.role==='user'?'あなた':m.role==='assistant'?'Kotoha':escapeHtml(m.role)}</strong><p>${escapeHtml(m.content)}</p></article>`).join(''); }
async function loadUsage() { const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Tokyo'}); const [{data:usage,error:usageError},{data:policy,error:policyError}]=await Promise.all([client.from('usage_daily').select('request_count,search_count').eq('user_id',currentUser.id).eq('usage_date',today).maybeSingle(),client.from('usage_policies').select('daily_request_limit').eq('is_active',true).order('created_at',{ascending:false}).limit(1).maybeSingle()]); if(usageError) throw new Error(usageError.message); if(policyError) throw new Error(policyError.message); document.querySelector('#usage-summary').textContent=`今日: ${usage?.request_count||0} / ${policy?.daily_request_limit??'-'} 回`; }
function renderMessage(role,content,thinking=false) { const list=document.querySelector('#message-list'); const article=document.createElement('article'); article.className=`message ${role}`; if(thinking) article.dataset.thinking='true'; article.innerHTML=`<strong>${role==='user'?'あなた':'Kotoha'}</strong><p>${escapeHtml(content)}</p>`; list.appendChild(article); list.scrollTop=list.scrollHeight; }
function removeThinkingMessage(){document.querySelectorAll('[data-thinking="true"]').forEach(el=>el.remove());}
async function sendChatMessage(content) { if(!currentConversationId) await createConversation(); const token=await getAccessToken(); const response=await withTimeout(fetch(getApiUrl(),{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},body:JSON.stringify({conversation_id:currentConversationId,message:content})}),90000,'AIの応答が90秒以内に完了しませんでした。'); const result=await response.json().catch(()=>({ok:false,error:'WorkerからJSON応答を取得できませんでした。'})); if(!response.ok||!result.ok) throw new Error(result.error||`Worker error: ${response.status}`); return result; }
async function initChat(){
  try {
    setStatus('JavaScriptを初期化しました。');
    if(!client) throw new Error('Supabaseクライアントが読み込まれていません。');
    if(!window.kotohaAuth?.requireUser) throw new Error('認証モジュールが読み込まれていません。');
    setStatus('ログイン状態を確認しています…'); currentUser=await withTimeout(window.kotohaAuth.requireUser(),10000,'ログイン状態の確認がタイムアウトしました。'); if(!currentUser) return;
    document.querySelector('#signout-button').addEventListener('click',window.kotohaAuth.signOut);
    document.querySelector('#new-chat').addEventListener('click',()=>createConversation().then(()=>setStatus('🟢 新しいチャットを作成しました。')).catch(e=>setStatus(`🔴 ${e.message}`)));
    setStatus('Cloudflare Workerへ接続しています…'); const workerResult=await verifyWorkerConnection(); setStatus(workerResult.ok?`🟢 サーバー接続確認: 成功（${workerResult.user?.role||'user'}）`:`🔴 サーバー接続確認: ${workerResult.error||'失敗'}`);
    document.querySelector('#chat-form').addEventListener('submit',async event=>{event.preventDefault();const input=document.querySelector('#message-input');const button=document.querySelector('#send-button');const content=input.value.trim();if(!content||button.disabled)return;try{setBusy(button,true);input.value='';if(!currentConversationId)await createConversation();renderMessage('user',content);renderMessage('assistant','考えています…',true);setStatus('Kotohaが考えています…');await sendChatMessage(content);removeThinkingMessage();await openConversation(currentConversationId);await loadConversations();await loadUsage();setStatus('🟢 送信完了');}catch(error){removeThinkingMessage();input.value=content;setStatus(`🔴 ${error.message||'メッセージ送信に失敗しました。'}`);}finally{setBusy(button,false);input.focus();}});
    await loadConversations(); await loadUsage(); const first=document.querySelector('.conversation-item'); if(first&&!currentConversationId) await openConversation(first.dataset.id);
  } catch(error){console.error('Kotoha initialization error:',error);setStatus(`🔴 初期化エラー: ${error.message||'不明なエラー'}`);}
}
initChat();
})();
