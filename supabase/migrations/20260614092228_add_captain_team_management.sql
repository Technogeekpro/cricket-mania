alter table public.matches
  add column if not exists captain_a_id uuid references public.profiles(id) on delete set null,
  add column if not exists captain_b_id uuid references public.profiles(id) on delete set null;

create or replace function app_private.is_captain()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles
    where user_id = auth.uid()
      and role = 'captain'
  );
$$;

create or replace function app_private.can_manage_match_team(target_match_id uuid, target_team_key text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.matches m
    where m.id = target_match_id
      and (
        app_private.is_admin()
        or (target_team_key = 'a' and m.captain_a_id = auth.uid())
        or (target_team_key = 'b' and m.captain_b_id = auth.uid())
      )
  );
$$;

drop policy if exists "profiles_select_captain" on public.profiles;
create policy "profiles_select_captain"
on public.profiles for select
to authenticated
using (app_private.is_captain());

drop policy if exists "match_players_insert_admin_only" on public.match_players;
drop policy if exists "match_players_update_admin_only" on public.match_players;
drop policy if exists "match_players_delete_admin_only" on public.match_players;
drop policy if exists "match_players_insert_admin_or_captain_team" on public.match_players;
drop policy if exists "match_players_update_admin_or_captain_team" on public.match_players;
drop policy if exists "match_players_delete_admin_or_captain_team" on public.match_players;

create policy "match_players_insert_admin_or_captain_team"
on public.match_players for insert
to authenticated
with check (
  app_private.can_manage_match_team(match_id, team_key)
);

create policy "match_players_update_admin_or_captain_team"
on public.match_players for update
to authenticated
using (
  app_private.can_manage_match_team(match_id, team_key)
)
with check (
  app_private.can_manage_match_team(match_id, team_key)
);

create policy "match_players_delete_admin_or_captain_team"
on public.match_players for delete
to authenticated
using (
  app_private.can_manage_match_team(match_id, team_key)
);

revoke execute on function app_private.is_captain() from public, anon, authenticated;
revoke execute on function app_private.can_manage_match_team(uuid, text) from public, anon, authenticated;
