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
      // GitHub Pages上で古いセッション情報が残っても、ログイン画面へ確実に戻す。
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

  // 先に公開しておくことで、他のページ用スクリプトとの読み込み競合を防ぐ。
  window.kotohaAuth = { getCurrentUser, requireUser, signOut, getAppUrl };

  const authForm = document.querySelector('#auth-form');
  const githubLoginButton = document.querySelector('#github-login-button');
  const signoutButton = document.querySelector('#signout-button');

  if (authForm) {
    authForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!authForm.reportValidity()) return;
      const username = document.querySelector('#username').value.trim();
      const password = document.querySelector('#password').value;
      if (!username || !password) return;
      setAuthBusy(true);
      setStatus('ログインしています…');
      const email = `${username.toLowerCase()}@kotoha.local`;
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) {
        console.error('Password login failed:', error);
        setStatus('IDまたはパスワードが正しくありません。');
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

  // ログアウトは各ページ共通でここで登録する。
  if (signoutButton) {
    signoutButton.addEventListener('click', async (event) => {
      event.preventDefault();
      signoutButton.disabled = true;
      const originalText = signoutButton.textContent;
      signoutButton.textContent = 'ログアウト中…';
      try {
        await signOut();
      } finally {
        // 遷移に失敗した場合だけ元へ戻す。
        setTimeout(() => {
          signoutButton.disabled = false;
          signoutButton.textContent = originalText || 'ログアウト';
        }, 1000);
      }
    });
  }

  redirectIfAuthenticated().catch((error) => console.error('Session check failed:', error));
})();
