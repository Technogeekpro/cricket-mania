-- Move captain draft writes behind private security-definer functions.
-- Public RPC wrappers stay callable from the app, while RLS-protected writes are
-- limited to the checks inside app_private.

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
      raise exception 'Team A already has a captain';
    end if;

    update public.matches
    set captain_a_id = auth.uid()
    where id = p_match_id
    returning * into v_match;
  else
    if v_match.captain_b_id is not null then
      raise exception 'Team B already has a captain';
    end if;

    update public.matches
    set captain_b_id = auth.uid()
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

create or replace function app_private.draft_match_player(
  p_match_id uuid,
  p_team_key text,
  p_profile_id uuid
)
returns public.match_players
language plpgsql
security definer
set search_path = public, app_private
as $$
declare
  v_match public.matches%rowtype;
  v_profile public.profiles%rowtype;
  v_inserted public.match_players%rowtype;
  v_team_count integer;
  v_other_count integer;
  v_next_turn text;
begin
  if p_team_key not in ('a', 'b') then
    raise exception 'Invalid team key';
  end if;

  if not app_private.can_manage_match_team(p_match_id, p_team_key) then
    raise exception 'You can only draft for your assigned team' using errcode = '42501';
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

  if v_match.captain_a_id is null or v_match.captain_b_id is null then
    raise exception 'Both captains must claim teams before drafting';
  end if;

  if v_match.draft_turn <> p_team_key then
    raise exception 'Wait for the other team to pick';
  end if;

  select count(*)
  into v_team_count
  from public.match_players
  where match_id = p_match_id
    and team_key = p_team_key;

  if v_team_count >= v_match.team_size then
    raise exception 'This team is full';
  end if;

  if exists (
    select 1
    from public.match_players
    where match_id = p_match_id
      and profile_id = p_profile_id
  ) then
    raise exception 'Player is already picked';
  end if;

  select *
  into v_profile
  from public.profiles
  where id = p_profile_id;

  if v_profile.id is null then
    raise exception 'Player profile not found';
  end if;

  if v_profile.is_banned then
    raise exception 'This player is banned';
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
    false,
    v_profile.skills,
    v_profile.avatar_url
  )
  returning * into v_inserted;

  select count(*)
  into v_other_count
  from public.match_players
  where match_id = p_match_id
    and team_key = case when p_team_key = 'a' then 'b' else 'a' end;

  v_next_turn := case when p_team_key = 'a' then 'b' else 'a' end;
  if v_other_count >= v_match.team_size then
    v_next_turn := p_team_key;
  end if;

  update public.matches
  set draft_turn = v_next_turn
  where id = p_match_id;

  return v_inserted;
end;
$$;

create or replace function public.claim_match_team(
  p_match_id uuid,
  p_team_key text
)
returns public.matches
language sql
security invoker
set search_path = public, app_private
as $$
  select app_private.claim_match_team(p_match_id, p_team_key);
$$;

create or replace function public.draft_match_player(
  p_match_id uuid,
  p_team_key text,
  p_profile_id uuid
)
returns public.match_players
language sql
security invoker
set search_path = public, app_private
as $$
  select app_private.draft_match_player(p_match_id, p_team_key, p_profile_id);
$$;

revoke execute on function app_private.claim_match_team(uuid, text) from public, anon;
revoke execute on function app_private.draft_match_player(uuid, text, uuid) from public, anon;
grant execute on function app_private.claim_match_team(uuid, text) to authenticated;
grant execute on function app_private.draft_match_player(uuid, text, uuid) to authenticated;

revoke execute on function public.claim_match_team(uuid, text) from public, anon;
revoke execute on function public.draft_match_player(uuid, text, uuid) from public, anon;
grant execute on function public.claim_match_team(uuid, text) to authenticated;
grant execute on function public.draft_match_player(uuid, text, uuid) to authenticated;
