-- An "official" is an admin OR an umpire. Umpires can run matches (create, move
-- players between teams, score) but not the admin-only powers (assign roles, ban,
-- reset-all). Those remain admin-gated in their own paths.

create or replace function app_private.is_umpire()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = auth.uid() and role = 'umpire'
  );
$$;

create or replace function app_private.is_official()
returns boolean
language sql
security definer
set search_path = public
as $$
  select app_private.is_admin() or app_private.is_umpire();
$$;

grant execute on function app_private.is_umpire() to authenticated;
grant execute on function app_private.is_official() to authenticated;

-- Captains manage their own team; officials (admin/umpire) manage any team.
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
        app_private.is_official()
        or (target_team_key = 'a' and m.captain_a_id = auth.uid())
        or (target_team_key = 'b' and m.captain_b_id = auth.uid())
      )
  );
$$;

-- matches: officials can create + update; delete stays admin-only.
drop policy if exists "matches_insert_admin_only" on public.matches;
drop policy if exists "matches_update_admin_only" on public.matches;
create policy "matches_insert_official" on public.matches
  for insert to authenticated with check (app_private.is_official());
create policy "matches_update_official" on public.matches
  for update to authenticated using (app_private.is_official()) with check (app_private.is_official());

-- deliveries: officials can write (insert via RPC, delete on reset).
drop policy if exists "deliveries_insert_admin_only" on public.deliveries;
drop policy if exists "deliveries_update_admin_only" on public.deliveries;
drop policy if exists "deliveries_delete_admin_only" on public.deliveries;
create policy "deliveries_insert_official" on public.deliveries
  for insert to authenticated with check (app_private.is_official());
create policy "deliveries_update_official" on public.deliveries
  for update to authenticated using (app_private.is_official()) with check (app_private.is_official());
create policy "deliveries_delete_official" on public.deliveries
  for delete to authenticated using (app_private.is_official());

-- Re-gate the scoring RPCs from admin-only to official, reusing their exact
-- bodies and swapping only the guard call.
do $mig$
declare
  v_def text;
begin
  v_def := pg_get_functiondef('public.score_match_delivery(uuid,integer,text,boolean)'::regprocedure);
  v_def := replace(v_def, 'app_private.is_admin()', 'app_private.is_official()');
  execute v_def;

  v_def := pg_get_functiondef('public.undo_last_match_delivery(uuid)'::regprocedure);
  v_def := replace(v_def, 'app_private.is_admin()', 'app_private.is_official()');
  execute v_def;
end
$mig$;
