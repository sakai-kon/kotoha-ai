create or replace function public.consume_daily_request(
  p_user_id uuid,
  p_limit integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  insert into public.usage_daily (user_id, usage_date, request_count)
  values (p_user_id, current_date, 0)
  on conflict (user_id, usage_date) do nothing;

  update public.usage_daily
  set request_count = request_count + 1,
      updated_at = now()
  where user_id = p_user_id
    and usage_date = current_date
    and request_count < greatest(p_limit, 0)
  returning request_count into v_count;

  return found;
end;
$$;

revoke all on function public.consume_daily_request(uuid, integer) from public;
revoke all on function public.consume_daily_request(uuid, integer) from anon;
revoke all on function public.consume_daily_request(uuid, integer) from authenticated;
grant execute on function public.consume_daily_request(uuid, integer) to service_role;
