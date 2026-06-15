-- Captain-owned team profiles. Captains create and edit teams; admins only pick
-- existing captain teams when creating matches.

create table if not exists public.captain_teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  logo_url text,
  logo_path text,
  captain_id uuid unique references public.profiles(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger captain_teams_set_updated_at
before update on public.captain_teams
for each row execute function public.set_updated_at();

alter table public.captain_teams enable row level security;

drop policy if exists "captain_teams_select_authenticated" on public.captain_teams;
create policy "captain_teams_select_authenticated"
on public.captain_teams for select
to authenticated
using (true);

drop policy if exists "captain_teams_insert_captain_own" on public.captain_teams;
create policy "captain_teams_insert_captain_own"
on public.captain_teams for insert
to authenticated
with check (
  app_private.is_captain()
  and captain_id = auth.uid()
);

drop policy if exists "captain_teams_update_admin_or_own" on public.captain_teams;
create policy "captain_teams_update_admin_or_own"
on public.captain_teams for update
to authenticated
using (
  app_private.is_admin()
  or captain_id = auth.uid()
)
with check (
  app_private.is_admin()
  or captain_id = auth.uid()
  or captain_id is null
);

create index if not exists captain_teams_captain_idx on public.captain_teams(captain_id);
create index if not exists captain_teams_created_at_idx on public.captain_teams(created_at desc);

create or replace function app_private.save_captain_team(
  p_name text,
  p_logo_url text default null,
  p_logo_path text default null
)
returns public.captain_teams
language plpgsql
security definer
set search_path = public, app_private
as $$
declare
  v_team public.captain_teams%rowtype;
  v_name text;
begin
  if not app_private.is_captain() then
    raise exception 'Captain access required' using errcode = '42501';
  end if;

  if exists (select 1 from public.profiles where id = auth.uid() and is_banned) then
    raise exception 'This account is banned' using errcode = '42501';
  end if;

  v_name := nullif(trim(coalesce(p_name, '')), '');
  if v_name is null then
    raise exception 'Team name is required';
  end if;

  select *
  into v_team
  from public.captain_teams
  where captain_id = auth.uid()
  for update;

  if found then
    update public.captain_teams
    set
      name = v_name,
      logo_url = coalesce(nullif(p_logo_url, ''), logo_url),
      logo_path = coalesce(nullif(p_logo_path, ''), logo_path)
    where id = v_team.id
    returning * into v_team;
  else
    insert into public.captain_teams (name, logo_url, logo_path, captain_id, created_by)
    values (v_name, nullif(p_logo_url, ''), nullif(p_logo_path, ''), auth.uid(), auth.uid())
    returning * into v_team;
  end if;

  return v_team;
end;
$$;

create or replace function app_private.exit_captain_team(
  p_team_id uuid
)
returns public.captain_teams
language plpgsql
security definer
set search_path = public, app_private
as $$
declare
  v_team public.captain_teams%rowtype;
begin
  select *
  into v_team
  from public.captain_teams
  where id = p_team_id
  for update;

  if not found then
    raise exception 'Team not found';
  end if;

  if v_team.captain_id <> auth.uid() then
    raise exception 'You can only exit your own team' using errcode = '42501';
  end if;

  update public.captain_teams
  set captain_id = null
  where id = p_team_id
  returning * into v_team;

  return v_team;
end;
$$;

create or replace function app_private.join_captain_team(
  p_team_id uuid
)
returns public.captain_teams
language plpgsql
security definer
set search_path = public, app_private
as $$
declare
  v_team public.captain_teams%rowtype;
begin
  if not app_private.is_captain() then
    raise exception 'Captain access required' using errcode = '42501';
  end if;

  if exists (select 1 from public.profiles where id = auth.uid() and is_banned) then
    raise exception 'This account is banned' using errcode = '42501';
  end if;

  if exists (select 1 from public.captain_teams where captain_id = auth.uid()) then
    raise exception 'Exit your current team before joining another team';
  end if;

  select *
  into v_team
  from public.captain_teams
  where id = p_team_id
  for update;

  if not found then
    raise exception 'Team not found';
  end if;

  if v_team.captain_id is not null then
    raise exception 'This team already has a captain';
  end if;

  update public.captain_teams
  set captain_id = auth.uid()
  where id = p_team_id
  returning * into v_team;

  return v_team;
end;
$$;

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
  select app_private.save_captain_team(p_name, p_logo_url, p_logo_path);
$$;

create or replace function public.exit_captain_team(
  p_team_id uuid
)
returns public.captain_teams
language sql
security invoker
set search_path = public, app_private
as $$
  select app_private.exit_captain_team(p_team_id);
$$;

create or replace function public.join_captain_team(
  p_team_id uuid
)
returns public.captain_teams
language sql
security invoker
set search_path = public, app_private
as $$
  select app_private.join_captain_team(p_team_id);
$$;

create or replace function app_private.claim_match_team(
  p_match_id uuid,
  p_team_key text
)
returns public.matches
language plpgsql
security definer
set search_path = public, app_private
as $$
declare
  v_match public.matches%rowtype;
  v_profile public.profiles%rowtype;
  v_team public.captain_teams%rowtype;
begin
  if p_team_key not in ('a', 'b') then
    raise exception 'Invalid team key';
  end if;

  if not app_private.is_captain() then
    raise exception 'Captain access required' using errcode = '42501';
  end if;

  select *
  into v_profile
  from public.profiles
  where id = auth.uid();

  if v_profile.id is null then
    raise exception 'Profile not found';
  end if;

  if v_profile.is_banned then
    raise exception 'This account is banned' using errcode = '42501';
  end if;

  select *
  into v_team
  from public.captain_teams
  where captain_id = auth.uid();

  if v_team.id is null then
    raise exception 'Create your team before joining a match';
  end if;

  select *
  into v_match
  from public.matches
  where id = p_match_id
  for update;

  if not found then
    raise exception 'Match not found';
  end if;

  if v_match.status = 'completed' then
    raise exception 'Match is already completed';
  end if;

  if v_match.captain_a_id = auth.uid() or v_match.captain_b_id = auth.uid() then
    raise exception 'You have already claimed a team';
  end if;

  if p_team_key = 'a' then
    if v_match.captain_a_id is not null then
      raise exception 'First team slot already has a captain';
    end if;

    update public.matches
    set
      captain_a_id = auth.uid(),
      team_a_name = v_team.name,
      team_a_logo_url = v_team.logo_url,
      team_a_logo_path = v_team.logo_path
    where id = p_match_id
    returning * into v_match;
  else
    if v_match.captain_b_id is not null then
      raise exception 'Second team slot already has a captain';
    end if;

    update public.matches
    set
      captain_b_id = auth.uid(),
      team_b_name = v_team.name,
      team_b_logo_url = v_team.logo_url,
      team_b_logo_path = v_team.logo_path
    where id = p_match_id
    returning * into v_match;
  end if;

  insert into public.match_players (
    match_id,
    profile_id,
    display_name,
    team_key,
    is_captain,
    skills,
    avatar_url
  )
  values (
    p_match_id,
    v_profile.id,
    v_profile.display_name,
    p_team_key,
    true,
    v_profile.skills,
    v_profile.avatar_url
  )
  on conflict do nothing;

  return v_match;
end;
$$;

revoke execute on function app_private.save_captain_team(text, text, text) from public, anon;
revoke execute on function app_private.exit_captain_team(uuid) from public, anon;
revoke execute on function app_private.join_captain_team(uuid) from public, anon;
grant execute on function app_private.save_captain_team(text, text, text) to authenticated;
grant execute on function app_private.exit_captain_team(uuid) to authenticated;
grant execute on function app_private.join_captain_team(uuid) to authenticated;

revoke execute on function public.save_captain_team(text, text, text) from public, anon;
revoke execute on function public.exit_captain_team(uuid) from public, anon;
revoke execute on function public.join_captain_team(uuid) from public, anon;
grant execute on function public.save_captain_team(text, text, text) to authenticated;
grant execute on function public.exit_captain_team(uuid) to authenticated;
grant execute on function public.join_captain_team(uuid) to authenticated;
