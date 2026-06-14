-- Overs limit, two-innings flow with auto winner, and per-player batting/bowling stats.

-- matches: overs limit + two-innings + live striker/bowler refs + result
alter table public.matches
  add column if not exists total_overs integer not null default 6 check (total_overs between 1 and 50),
  add column if not exists current_innings smallint not null default 1 check (current_innings in (1, 2)),
  add column if not exists first_batting_team text not null default 'a' check (first_batting_team in ('a', 'b')),
  add column if not exists batting_team_key text not null default 'a' check (batting_team_key in ('a', 'b')),
  add column if not exists target integer check (target >= 0),
  add column if not exists innings1_runs integer not null default 0 check (innings1_runs >= 0),
  add column if not exists innings1_wickets integer not null default 0 check (innings1_wickets >= 0),
  add column if not exists innings1_balls integer not null default 0 check (innings1_balls >= 0),
  add column if not exists striker_id uuid references public.match_players(id) on delete set null,
  add column if not exists non_striker_id uuid references public.match_players(id) on delete set null,
  add column if not exists bowler_id uuid references public.match_players(id) on delete set null,
  add column if not exists winner_team text check (winner_team in ('a', 'b', 'tie')),
  add column if not exists result_note text;

-- deliveries: which innings + who was on strike / bowling
alter table public.deliveries
  add column if not exists innings smallint not null default 1 check (innings in (1, 2)),
  add column if not exists striker_id uuid references public.match_players(id) on delete set null,
  add column if not exists bowler_id uuid references public.match_players(id) on delete set null;

-- match_players: per-match batting + bowling tallies maintained by the umpire while scoring
alter table public.match_players
  add column if not exists runs_scored integer not null default 0 check (runs_scored >= 0),
  add column if not exists balls_faced integer not null default 0 check (balls_faced >= 0),
  add column if not exists fours integer not null default 0 check (fours >= 0),
  add column if not exists sixes integer not null default 0 check (sixes >= 0),
  add column if not exists is_out boolean not null default false,
  add column if not exists dismissal text,
  add column if not exists balls_bowled integer not null default 0 check (balls_bowled >= 0),
  add column if not exists runs_conceded integer not null default 0 check (runs_conceded >= 0),
  add column if not exists wickets_taken integer not null default 0 check (wickets_taken >= 0);

create index if not exists deliveries_match_innings_idx on public.deliveries(match_id, innings, created_at desc);
create index if not exists match_players_profile_idx on public.match_players(profile_id);
