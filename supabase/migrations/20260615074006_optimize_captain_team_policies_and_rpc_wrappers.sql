-- Remove per-row auth function re-evaluation for captain team policies and
-- make public RPC wrappers return composite rows as columns.

drop policy if exists "captain_teams_insert_captain_own" on public.captain_teams;
create policy "captain_teams_insert_captain_own"
on public.captain_teams for insert
to authenticated
with check (
  (select app_private.is_captain())
  and captain_id = (select auth.uid())
);

drop policy if exists "captain_teams_update_admin_or_own" on public.captain_teams;
create policy "captain_teams_update_admin_or_own"
on public.captain_teams for update
to authenticated
using (
  (select app_private.is_admin())
  or captain_id = (select auth.uid())
)
with check (
  (select app_private.is_admin())
  or captain_id = (select auth.uid())
  or captain_id is null
);

create or replace function public.save_captain_team(
  p_name text,
  p_logo_url text default null,
  p_logo_path text default null
)
returns public.captain_teams
language sql
security invoker
set search_path = public, app_private
as $$
  select * from app_private.save_captain_team(p_name, p_logo_url, p_logo_path);
$$;

create or replace function public.exit_captain_team(
  p_team_id uuid
)
returns public.captain_teams
language sql
security invoker
set search_path = public, app_private
as $$
  select * from app_private.exit_captain_team(p_team_id);
$$;

create or replace function public.join_captain_team(
  p_team_id uuid
)
returns public.captain_teams
language sql
security invoker
set search_path = public, app_private
as $$
  select * from app_private.join_captain_team(p_team_id);
$$;

revoke execute on function public.save_captain_team(text, text, text) from public, anon;
revoke execute on function public.exit_captain_team(uuid) from public, anon;
revoke execute on function public.join_captain_team(uuid) from public, anon;
grant execute on function public.save_captain_team(text, text, text) to authenticated;
grant execute on function public.exit_captain_team(uuid) to authenticated;
grant execute on function public.join_captain_team(uuid) to authenticated;
