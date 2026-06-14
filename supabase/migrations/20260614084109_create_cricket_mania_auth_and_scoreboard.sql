create type public.app_role as enum ('player', 'admin');
create type public.match_status as enum ('setup', 'live', 'completed');

create schema if not exists app_private;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text not null,
  phone text,
  skills text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role public.app_role not null default 'player',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.matches (
  id uuid primary key default gen_random_uuid(),
  title text not null default 'Turf Match',
  venue text not null default 'Local Turf',
  team_size integer not null default 6 check (team_size between 2 and 11),
  status public.match_status not null default 'setup',
  batting_team text not null default 'Team A',
  bowling_team text not null default 'Team B',
  runs integer not null default 0 check (runs >= 0),
  wickets integer not null default 0 check (wickets >= 0),
  legal_balls integer not null default 0 check (legal_balls >= 0),
  striker_name text,
  non_striker_name text,
  bowler_name text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.match_players (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  profile_id uuid references public.profiles(id) on delete set null,
  display_name text not null,
  team_key text not null default 'pool' check (team_key in ('pool', 'a', 'b')),
  is_captain boolean not null default false,
  batting_order integer,
  skills text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique(match_id, profile_id)
);

create table public.deliveries (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  label text not null,
  runs integer not null default 0 check (runs >= 0),
  legal boolean not null default true,
  wicket boolean not null default false,
  extra text check (extra in ('WD', 'NB', 'B', 'LB')),
  ball_index integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create or replace function app_private.is_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles
    where user_id = auth.uid()
      and role = 'admin'
  );
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at before update on public.profiles for each row execute function public.set_updated_at();
create trigger user_roles_set_updated_at before update on public.user_roles for each row execute function public.set_updated_at();
create trigger matches_set_updated_at before update on public.matches for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), split_part(coalesce(new.email, 'Player'), '@', 1))
  )
  on conflict (id) do nothing;

  insert into public.user_roles (user_id, role)
  values (new.id, 'player')
  on conflict (user_id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.matches enable row level security;
alter table public.match_players enable row level security;
alter table public.deliveries enable row level security;

create policy "profiles_select_own_or_admin" on public.profiles for select to authenticated using (id = auth.uid() or app_private.is_admin());
create policy "profiles_update_own_or_admin" on public.profiles for update to authenticated using (id = auth.uid() or app_private.is_admin()) with check (id = auth.uid() or app_private.is_admin());
create policy "roles_select_own_or_admin" on public.user_roles for select to authenticated using (user_id = auth.uid() or app_private.is_admin());
create policy "roles_update_admin_only" on public.user_roles for update to authenticated using (app_private.is_admin()) with check (app_private.is_admin());
create policy "matches_select_authenticated" on public.matches for select to authenticated using (true);
create policy "matches_insert_admin_only" on public.matches for insert to authenticated with check (app_private.is_admin());
create policy "matches_update_admin_only" on public.matches for update to authenticated using (app_private.is_admin()) with check (app_private.is_admin());
create policy "matches_delete_admin_only" on public.matches for delete to authenticated using (app_private.is_admin());
create policy "match_players_select_authenticated" on public.match_players for select to authenticated using (true);
create policy "match_players_insert_admin_only" on public.match_players for insert to authenticated with check (app_private.is_admin());
create policy "match_players_update_admin_only" on public.match_players for update to authenticated using (app_private.is_admin()) with check (app_private.is_admin());
create policy "match_players_delete_admin_only" on public.match_players for delete to authenticated using (app_private.is_admin());
create policy "deliveries_select_authenticated" on public.deliveries for select to authenticated using (true);
create policy "deliveries_insert_admin_only" on public.deliveries for insert to authenticated with check (app_private.is_admin());
create policy "deliveries_update_admin_only" on public.deliveries for update to authenticated using (app_private.is_admin()) with check (app_private.is_admin());
create policy "deliveries_delete_admin_only" on public.deliveries for delete to authenticated using (app_private.is_admin());

create index matches_status_created_at_idx on public.matches(status, created_at desc);
create index deliveries_match_created_at_idx on public.deliveries(match_id, created_at desc);
create index match_players_match_team_idx on public.match_players(match_id, team_key);
