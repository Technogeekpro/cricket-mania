-- Lightweight gully scoring: officials can update only match score, wickets,
-- legal balls, innings, and delivery labels without striker/bowler/player stats.

create or replace function public.gully_score_match_delivery(
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
  v_legal boolean;
  v_run_value integer;
  v_next_runs integer;
  v_next_wickets integer;
  v_next_legal_balls integer;
  v_total_balls integer;
  v_label text;
  v_winner text;
  v_result_note text;
  v_margin integer;
begin
  if not app_private.is_official() then
    raise exception 'Official access required' using errcode = '42501';
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

  v_total_balls := v_match.total_overs * 6;
  if v_match.legal_balls >= v_total_balls then
    raise exception 'Overs are complete. End the innings or match.';
  end if;

  v_legal := p_extra is distinct from 'WD' and p_extra is distinct from 'NB';
  v_run_value := case when p_extra is null then p_runs else p_runs + 1 end;
  v_next_runs := v_match.runs + v_run_value;
  v_next_wickets := v_match.wickets + case when p_wicket then 1 else 0 end;
  v_next_legal_balls := v_match.legal_balls + case when v_legal then 1 else 0 end;
  v_label := case
    when p_wicket then 'W'
    when p_extra is not null then p_extra || case when p_runs > 0 then '+' || p_runs::text else '' end
    else p_runs::text
  end;

  if v_match.current_innings = 2 and v_match.target is not null and v_next_runs >= v_match.target then
    v_winner := v_match.batting_team_key;
    v_result_note := case
      when v_match.batting_team_key = 'a' then coalesce(v_match.team_a_name, 'Team A')
      else coalesce(v_match.team_b_name, 'Team B')
    end || ' won';
  end if;

  if v_winner is null
    and v_match.current_innings = 2
    and v_match.target is not null
    and v_next_legal_balls >= v_total_balls then
    if v_next_runs = v_match.innings1_runs then
      v_winner := 'tie';
      v_result_note := 'Match tied';
    else
      v_margin := v_match.innings1_runs - v_next_runs;
      v_winner := case when v_match.batting_team_key = 'a' then 'b' else 'a' end;
      v_result_note := case
        when v_winner = 'a' then coalesce(v_match.team_a_name, 'Team A')
        else coalesce(v_match.team_b_name, 'Team B')
      end || ' won by ' || v_margin::text || ' run' || case when v_margin = 1 then '' else 's' end;
    end if;
  end if;

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
    null,
    null,
    null,
    auth.uid()
  );

  update public.matches
  set
    runs = v_next_runs,
    wickets = v_next_wickets,
    legal_balls = v_next_legal_balls,
    status = (case when v_winner is not null then 'completed' else 'live' end)::public.match_status,
    winner_team = v_winner,
    result_note = v_result_note,
    striker_id = null,
    non_striker_id = null,
    bowler_id = null,
    striker_name = null,
    non_striker_name = null,
    bowler_name = null
  where id = p_match_id;
end;
$$;

revoke execute on function public.gully_score_match_delivery(uuid, integer, text, boolean) from public, anon;
grant execute on function public.gully_score_match_delivery(uuid, integer, text, boolean) to authenticated;
