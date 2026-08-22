const client = window.supabaseClient;

async function initAdmin() {
  const user = await window.kotohaAuth.requireUser();
  if (!user) return;
  const { data: profile } = await client.from('profiles').select('role').eq('id', user.id).single();
  const guard = document.querySelector('#admin-guard');
  if (!profile || profile.role !== 'admin') {
    guard.textContent = 'このページにアクセスする権限がありません。';
    return;
  }
  guard.hidden = true;
  document.querySelector('#admin-content').hidden = false;
  const [policyRes, periodsRes, logsRes] = await Promise.all([
    client.from('usage_policies').select('*').order('created_at', { ascending: false }),
    client.from('special_periods').select('*').order('start_at', { ascending: false }),
    client.from('admin_logs').select('*').order('created_at', { ascending: false }).limit(30)
  ]);
  document.querySelector('#usage-policy').textContent = JSON.stringify(policyRes.data || [], null, 2);
  document.querySelector('#special-periods').textContent = JSON.stringify(periodsRes.data || [], null, 2);
  document.querySelector('#admin-logs').textContent = JSON.stringify(logsRes.data || [], null, 2);
}

initAdmin().catch(error => console.error(error));
