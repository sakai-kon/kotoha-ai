const client = window.supabaseClient;
let currentUser = null;
let currentConversationId = null;

function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[c]));
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
  currentUser = await window.kotohaAuth.requireUser();
  if (!currentUser) return;
  document.querySelector('#signout-button').addEventListener('click', window.kotohaAuth.signOut);
  document.querySelector('#new-chat').addEventListener('click', createConversation);
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

initChat().catch(error => console.error(error));
