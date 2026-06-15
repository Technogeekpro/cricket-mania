-- Ensure captain-owned team changes are delivered to clients without refresh.

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'captain_teams'
  ) then
    execute 'alter publication supabase_realtime add table public.captain_teams';
  end if;
end $$;
