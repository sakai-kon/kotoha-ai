const client = window.supabaseClient;

function setStatus(message = '') {
  const el = document.querySelector('#auth-status');
  if (el) el.textContent = message;
}

function setAuthBusy(busy) {
  document.querySelectorAll('#auth-form input, #auth-form button, #github-login-button').forEach((el) => {
    el.disabled = busy;
  });
}

async function getCurrentUser() {
  const { data, error } = await client.auth.getUser();
  if (error) return null;
  return data.user;
}

async function requireUser() {
  const user = await getCurrentUser();
  if (!user) {
    location.replace('login.html');
    return null;
  }
  return user;
}

async function signOut() {
  const { error } = await client.auth.signOut();
  if (error) console.error('Sign out failed:', error);
  location.replace('index.html');
}

async function redirectIfAuthenticated() {
  if (!document.querySelector('#auth-form')) return;
  const user = await getCurrentUser();
  if (user) location.replace('chat.html');
}

async function signInWithGithub() {
  setAuthBusy(true);
  setStatus('GitHubに移動しています…');

  const redirectTo = new URL('chat.html', window.location.href).href;
  const { error } = await client.auth.signInWithOAuth({
    provider: 'github',
    options: { redirectTo }
  });

  if (error) {
    console.error('GitHub OAuth failed:', error);
    setStatus('GitHubログインを開始できませんでした。設定を確認してください。');
    setAuthBusy(false);
  }
}

const authForm = document.querySelector('#auth-form');
const githubLoginButton = document.querySelector('#github-login-button');

if (authForm) {
  authForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!authForm.reportValidity()) return;

    const username = document.querySelector('#username').value.trim();
    const password = document.querySelector('#password').value;
    if (!username || !password) return;

    setAuthBusy(true);
    setStatus('ログインしています…');

    // Supabase Auth requires an email internally. General-user IDs are
    // provisioned by the administrator as username@kotoha.local.
    const email = `${username.toLowerCase()}@kotoha.local`;
    const { error } = await client.auth.signInWithPassword({ email, password });

    if (error) {
      console.error('Password login failed:', error);
      setStatus('IDまたはパスワードが正しくありません。');
      setAuthBusy(false);
      return;
    }

    location.replace('chat.html');
  });
}

if (githubLoginButton) {
  githubLoginButton.addEventListener('click', () => {
    signInWithGithub().catch((error) => {
      console.error(error);
      setStatus('GitHubログイン中にエラーが発生しました。');
      setAuthBusy(false);
    });
  });
}

redirectIfAuthenticated().catch((error) => console.error('Session check failed:', error));

window.kotohaAuth = { getCurrentUser, requireUser, signOut };
