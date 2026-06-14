-- Realtime scoreboard updates, transactional scoring, undo, and automatic match completion.

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'matches'
  ) then
    execute 'alter publication supabase_realtime add table public.matches';
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'deliveries'
  ) then
    execute 'alter publication supabase_realtime add table public.deliveries';
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'match_players'
  ) then
    execute 'alter publication supabase_realtime add table public.match_players';
  end if;
end $$;

alter table public.deliveries
  add column if not exists non_striker_id uuid references public.match_players(id) on delete set null;

create index if not exists matches_created_by_idx on public.matches(created_by);
create index if not exists matches_captain_a_idx on public.matches(captain_a_id);
create index if not exists matches_captain_b_idx on public.matches(captain_b_id);
create index if not exists matches_striker_idx on public.matches(striker_id);
create index if not exists matches_non_striker_idx on public.matches(non_striker_id);
create index if not exists matches_bowler_idx on public.matches(bowler_id);
create index if not exists deliveries_created_by_idx on public.deliveries(created_by);
create index if not exists deliveries_striker_idx on public.deliveries(striker_id);
create index if not exists deliveries_non_striker_idx on public.deliveries(non_striker_id);
create index if not exists deliveries_bowler_idx on public.deliveries(bowler_id);

create or replace function public.score_match_delivery(
  p_match_id uuid,
  p_runs integer,
  p_extra text default null,
  p_wicket boolean default false
)
returns void
language plpgsql
security invoker
set search_path = public, app_private
as $$
declare
  v_match public.matches%rowtype;
  v_striker public.match_players%rowtype;
  v_bowler public.match_players%rowtype;
  v_batting_squad integer;
  v_legal boolean;
  v_off_bat boolean;
  v_run_value integer;
  v_next_runs integer;
  v_next_wickets integer;
  v_next_legal_balls integer;
  v_total_balls integer;
  v_over_complete boolean;
  v_label text;
  v_bowler_runs integer;
  v_next_striker uuid;
  v_next_non_striker uuid;
  v_swap boolean;
  v_winner text;
  v_result_note text;
  v_wickets_left integer;
  v_margin integer;
begin
  if not app_private.is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  if p_runs < 0 or p_runs > 6 then
    raise exception 'Runs must be between 0 and 6';
  end if;

  if p_extra is not null and p_extra not in ('WD', 'NB', 'B', 'LB') then
    raise exception 'Invalid extra type';
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
    raise exception 'This match is already complete';
  end if;

  if v_match.striker_id is null or v_match.bowler_id is null then
    raise exception 'Pick a striker and a bowler before scoring';
  end if;

  select *
  into v_striker
  from public.match_players
  where id = v_match.striker_id
  for update;

  select *
  into v_bowler
  from public.match_players
  where id = v_match.bowler_id
  for update;

  if v_striker.id is null or v_bowler.id is null then
    raise exception 'Striker or bowler is not part of this match';
  end if;

  select count(*)
  into v_batting_squad
  from public.match_players
  where match_id = p_match_id
    and team_key = v_match.batting_team_key;

  v_total_balls := v_match.total_overs * 6;
  if v_match.legal_balls >= v_total_balls then
    raise exception 'Overs are complete. End the innings or match.';
  end if;

  if v_batting_squad > 0 and v_match.wickets >= greatest(0, v_batting_squad - 1) then
    raise exception 'Team is all out. End the innings or match.';
  end if;

  v_legal := p_extra is distinct from 'WD' and p_extra is distinct from 'NB';
  v_off_bat := p_extra is null;
  v_run_value := case when p_extra is null then p_runs else p_runs + 1 end;
  v_next_runs := v_match.runs + v_run_value;
  v_next_wickets := v_match.wickets + case when p_wicket then 1 else 0 end;
  v_next_legal_balls := v_match.legal_balls + case when v_legal then 1 else 0 end;
  v_over_complete := v_legal and v_next_legal_balls % 6 = 0;
  v_label := case
    when p_wicket then 'W'
    when p_extra is not null then p_extra || case when p_runs > 0 then '+' || p_runs::text else '' end
    else p_runs::text
  end;

  insert into public.deliveries (
    match_id,
    label,
    runs,
    legal,
    wicket,
    extra,
    ball_index,
    innings,
    striker_id,
    non_striker_id,
    bowler_id,
    created_by
  )
  values (
    p_match_id,
    v_label,
    v_run_value,
    v_legal,
    p_wicket,
    p_extra,
    v_next_legal_balls,
    v_match.current_innings,
    v_match.striker_id,
    v_match.non_striker_id,
    v_match.bowler_id,
    auth.uid()
  );

  update public.match_players
  set
    runs_scored = runs_scored + case when v_off_bat then p_runs else 0 end,
    balls_faced = balls_faced + case when v_off_bat or p_extra in ('B', 'LB') then 1 else 0 end,
    fours = fours + case when v_off_bat and p_runs = 4 then 1 else 0 end,
    sixes = sixes + case when v_off_bat and p_runs = 6 then 1 else 0 end,
    is_out = case when p_wicket then true else is_out end,
    dismissal = case when p_wicket then 'b ' || v_bowler.display_name else dismissal end
  where id = v_match.striker_id;

  v_bowler_runs := case when p_extra in ('B', 'LB') then 0 else v_run_value end;
  update public.match_players
  set
    balls_bowled = balls_bowled + case when v_legal then 1 else 0 end,
    runs_conceded = runs_conceded + v_bowler_runs,
    wickets_taken = wickets_taken + case when p_wicket then 1 else 0 end
  where id = v_match.bowler_id;

  v_next_striker := v_match.striker_id;
  v_next_non_striker := v_match.non_striker_id;

  if p_wicket then
    v_next_striker := null;
  else
    v_swap := (v_off_bat or p_extra in ('B', 'LB')) and p_runs % 2 = 1;
    if v_over_complete then
      v_swap := not v_swap;
    end if;

    if v_swap and v_next_non_striker is not null then
      v_next_striker := v_match.non_striker_id;
      v_next_non_striker := v_match.striker_id;
    end if;
  end if;

  if v_match.current_innings = 2 and v_match.target is not null and v_next_runs >= v_match.target then
    v_winner := v_match.batting_team_key;
    v_wickets_left := greatest(0, v_batting_squad - 1 - v_next_wickets);
    v_result_note := case when v_wickets_left = 1
      then (case when v_winner = 'a' then 'Team A' else 'Team B' end) || ' won by 1 wicket'
      else (case when v_winner = 'a' then 'Team A' else 'Team B' end) || ' won by ' || v_wickets_left::text || ' wickets'
    end;
  elsif v_match.current_innings = 2
    and (v_next_legal_balls >= v_total_balls or (v_batting_squad > 0 and v_next_wickets >= greatest(0, v_batting_squad - 1))) then
    if v_next_runs > v_match.innings1_runs then
      v_winner := v_match.batting_team_key;
      v_wickets_left := greatest(0, v_batting_squad - 1 - v_next_wickets);
      v_result_note := case when v_wickets_left = 1
        then (case when v_winner = 'a' then 'Team A' else 'Team B' end) || ' won by 1 wicket'
        else (case when v_winner = 'a' then 'Team A' else 'Team B' end) || ' won by ' || v_wickets_left::text || ' wickets'
      end;
    elsif v_next_runs = v_match.innings1_runs then
      v_winner := 'tie';
      v_result_note := 'Match tied';
    else
      v_winner := case when v_match.batting_team_key = 'a' then 'b' else 'a' end;
      v_margin := v_match.innings1_runs - v_next_runs;
      v_result_note := case when v_margin = 1
        then (case when v_winner = 'a' then 'Team A' else 'Team B' end) || ' won by 1 run'
        else (case when v_winner = 'a' then 'Team A' else 'Team B' end) || ' won by ' || v_margin::text || ' runs'
      end;
    end if;
  end if;

  update public.matches
  set
    runs = v_next_runs,
    wickets = v_next_wickets,
    legal_balls = v_next_legal_balls,
    status = case when v_winner is null then 'live'::public.match_status else 'completed'::public.match_status end,
    striker_id = case when v_winner is null then v_next_striker else null end,
    non_striker_id = case when v_winner is null then v_next_non_striker else null end,
    bowler_id = case when v_winner is null then v_match.bowler_id else null end,
    striker_name = case
      when v_winner is not null or v_next_striker is null then null
      else (select display_name from public.match_players where id = v_next_striker)
    end,
    non_striker_name = case
      when v_winner is not null or v_next_non_striker is null then null
      else (select display_name from public.match_players where id = v_next_non_striker)
    end,
    bowler_name = case when v_winner is null then v_bowler.display_name else null end,
    winner_team = v_winner,
    result_note = v_result_note
  where id = p_match_id;
end;
$$;

create or replace function public.undo_last_match_delivery(p_match_id uuid)
returns void
language plpgsql
security invoker
set search_path = public, app_private
as $$
declare
  v_match public.matches%rowtype;
  v_delivery public.deliveries%rowtype;
  v_extra text;
  v_off_bat boolean;
  v_bowler_runs integer;
  v_new_runs integer;
  v_new_wickets integer;
  v_new_legal_balls integer;
begin
  if not app_private.is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  select *
  into v_match
  from public.matches
  where id = p_match_id
  for update;

  if not found then
    raise exception 'Match not found';
  end if;

  select *
  into v_delivery
  from public.deliveries
  where match_id = p_match_id
  order by created_at desc
  limit 1
  for update;

  if not found then
    raise exception 'No delivery to undo';
  end if;

  if v_delivery.innings <> v_match.current_innings then
    raise exception 'Can only undo the current innings. Reset the match to change earlier balls.';
  end if;

  v_extra := v_delivery.extra;
  v_off_bat := v_extra is null;
  v_bowler_runs := case when v_extra in ('B', 'LB') then 0 else v_delivery.runs end;
  v_new_runs := greatest(0, v_match.runs - v_delivery.runs);
  v_new_wickets := greatest(0, v_match.wickets - case when v_delivery.wicket then 1 else 0 end);
  v_new_legal_balls := greatest(0, v_match.legal_balls - case when v_delivery.legal then 1 else 0 end);

  if v_delivery.striker_id is not null then
    update public.match_players
    set
      runs_scored = greatest(0, runs_scored - case when v_off_bat then v_delivery.runs else 0 end),
      balls_faced = greatest(0, balls_faced - case when v_off_bat or v_extra in ('B', 'LB') then 1 else 0 end),
      fours = greatest(0, fours - case when v_off_bat and v_delivery.runs = 4 then 1 else 0 end),
      sixes = greatest(0, sixes - case when v_off_bat and v_delivery.runs = 6 then 1 else 0 end),
      is_out = case when v_delivery.wicket then false else is_out end,
      dismissal = case when v_delivery.wicket then null else dismissal end
    where id = v_delivery.striker_id;
  end if;

  if v_delivery.bowler_id is not null then
    update public.match_players
    set
      balls_bowled = greatest(0, balls_bowled - case when v_delivery.legal then 1 else 0 end),
      runs_conceded = greatest(0, runs_conceded - v_bowler_runs),
      wickets_taken = greatest(0, wickets_taken - case when v_delivery.wicket then 1 else 0 end)
    where id = v_delivery.bowler_id;
  end if;

  delete from public.deliveries
  where id = v_delivery.id;

  update public.matches
  set
    runs = v_new_runs,
    wickets = v_new_wickets,
    legal_balls = v_new_legal_balls,
    status = 'live',
    striker_id = v_delivery.striker_id,
    non_striker_id = v_delivery.non_striker_id,
    bowler_id = v_delivery.bowler_id,
    striker_name = case
      when v_delivery.striker_id is null then null
      else (select display_name from public.match_players where id = v_delivery.striker_id)
    end,
    non_striker_name = case
      when v_delivery.non_striker_id is null then null
      else (select display_name from public.match_players where id = v_delivery.non_striker_id)
    end,
    bowler_name = case
      when v_delivery.bowler_id is null then null
      else (select display_name from public.match_players where id = v_delivery.bowler_id)
    end,
    winner_team = null,
    result_note = null
  where id = p_match_id;
end;
$$;

revoke execute on function public.score_match_delivery(uuid, integer, text, boolean) from public, anon;
revoke execute on function public.undo_last_match_delivery(uuid) from public, anon;
grant execute on function public.score_match_delivery(uuid, integer, text, boolean) to authenticated;
grant execute on function public.undo_last_match_delivery(uuid) to authenticated;
