(() => {
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

  function getAppUrl() {
    const configured = window.KOTOHA_CONFIG?.APP_URL;
    if (!configured) return window.location.origin + window.location.pathname.replace(/[^/]*$/, '');
    return configured.endsWith('/') ? configured : `${configured}/`;
  }

  async function getCurrentUser() {
    if (!client?.auth) return null;
    const { data, error } = await client.auth.getUser();
    if (error) return null;
    return data.user;
  }

  async function requireUser() {
    const user = await getCurrentUser();
    if (!user) {
      location.replace(new URL('login.html', getAppUrl()).href);
      return null;
    }
    return user;
  }

  async function signOut() {
    try {
      const { error } = await client.auth.signOut({ scope: 'local' });
      if (error) throw error;
    } catch (error) {
      console.error('Sign out failed:', error);
    } finally {
      try {
        Object.keys(localStorage)
          .filter((key) => key.startsWith('sb-') || key.includes('supabase'))
          .forEach((key) => localStorage.removeItem(key));
        Object.keys(sessionStorage)
          .filter((key) => key.startsWith('sb-') || key.includes('supabase'))
          .forEach((key) => sessionStorage.removeItem(key));
      } catch (storageError) {
        console.warn('Session storage cleanup failed:', storageError);
      }
      location.replace(new URL('login.html', getAppUrl()).href);
    }
  }

  async function redirectIfAuthenticated() {
    if (!document.querySelector('#auth-form')) return;
    const user = await getCurrentUser();
    if (user) location.replace(new URL('chat.html', getAppUrl()).href);
  }

  async function signInWithGithub() {
    setAuthBusy(true);
    setStatus('GitHubに移動しています…');
    const redirectTo = new URL('chat.html', getAppUrl()).href;
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

  window.kotohaAuth = { getCurrentUser, requireUser, signOut, getAppUrl };

  const authForm = document.querySelector('#auth-form');
  const githubLoginButton = document.querySelector('#github-login-button');
  const signoutButton = document.querySelector('#signout-button');

  if (authForm) {
    authForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!authForm.reportValidity()) return;

      const usernameInput = document.querySelector('#username');
      const passwordInput = document.querySelector('#password');
      const username = String(usernameInput?.value || '').trim().toLowerCase();
      const password = String(passwordInput?.value || '');

      if (!username || !password) return;

      setAuthBusy(true);
      setStatus('ログインしています…');

      // 管理画面で作成するアカウントもこの形式で統一する。
      const email = `${username}@kotoha.local`;

      const { data, error } = await client.auth.signInWithPassword({
        email,
        password
      });

      if (error || !data?.user) {
        console.error('Password login failed:', {
          status: error?.status,
          message: error?.message,
          code: error?.code
        });
        setStatus('IDまたはパスワードが正しくありません。管理者が作成したIDは、入力したIDの大文字・小文字を気にせず小文字として認証されます。');
        setAuthBusy(false);
        return;
      }

      location.replace(new URL('chat.html', getAppUrl()).href);
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

  if (signoutButton) {
    signoutButton.addEventListener('click', async (event) => {
      event.preventDefault();
      signoutButton.disabled = true;
      const originalText = signoutButton.textContent;
      signoutButton.textContent = 'ログアウト中…';
      try {
        await signOut();
      } finally {
        setTimeout(() => {
          signoutButton.disabled = false;
          signoutButton.textContent = originalText || 'ログアウト';
        }, 1000);
      }
    });
  }

  redirectIfAuthenticated().catch((error) => console.error('Session check failed:', error));
})();
