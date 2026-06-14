-- Admin-only reset: wipes all matches, deliveries, and match_players in one shot.
-- Profiles, user_roles, and storage objects are preserved. SECURITY DEFINER so
-- the function can bypass RLS on the underlying tables; authorization is
-- enforced by app_private.is_admin() upfront.

create or replace function public.reset_app_data()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not app_private.is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  delete from public.deliveries;
  delete from public.match_players;
  delete from public.matches;
end;
$$;

revoke execute on function public.reset_app_data() from public, anon;
grant execute on function public.reset_app_data() to authenticated;
