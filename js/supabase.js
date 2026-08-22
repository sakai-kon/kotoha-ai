const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = window.KOTOHA_CONFIG || {};
if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
  throw new Error('Supabase configuration is missing.');
}
window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
