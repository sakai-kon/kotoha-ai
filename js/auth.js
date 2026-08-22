const client = window.supabaseClient;

async function getCurrentUser() {
  const { data: { user } } = await client.auth.getUser();
  return user;
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
  await client.auth.signOut();
  location.replace('index.html');
}

const authForm = document.querySelector('#auth-form');
const signupButton = document.querySelector('#signup-button');
const authStatus = document.querySelector('#auth-status');

if (authForm) {
  authForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    authStatus.textContent = 'ログインしています…';
    const email = document.querySelector('#email').value.trim();
    const password = document.querySelector('#password').value;
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) {
      authStatus.textContent = error.message;
      return;
    }
    location.replace('chat.html');
  });
}

if (signupButton) {
  signupButton.addEventListener('click', async () => {
    const email = document.querySelector('#email').value.trim();
    const password = document.querySelector('#password').value;
    if (!email || !password) {
      authStatus.textContent = 'メールアドレスと8文字以上のパスワードを入力してください。';
      return;
    }
    authStatus.textContent = '登録しています…';
    const { error } = await client.auth.signUp({ email, password });
    authStatus.textContent = error ? error.message : '登録を受け付けました。メール確認が必要な場合は受信メールを確認してください。';
  });
}

window.kotohaAuth = { getCurrentUser, requireUser, signOut };
