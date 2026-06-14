-- Captain-managed team branding and player avatar snapshots for match rankings.

alter table public.matches
  add column if not exists team_a_name text not null default 'Team A',
  add column if not exists team_b_name text not null default 'Team B',
  add column if not exists team_a_logo_url text,
  add column if not exists team_b_logo_url text,
  add column if not exists team_a_logo_path text,
  add column if not exists team_b_logo_path text;

alter table public.match_players
  add column if not exists avatar_url text;

update public.match_players mp
set avatar_url = p.avatar_url
from public.profiles p
where mp.profile_id = p.id
  and mp.avatar_url is null
  and p.avatar_url is not null;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'team-logos',
  'team-logos',
  true,
  1048576,
  array['image/webp', 'image/png', 'image/jpeg']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "team_logos_select_public" on storage.objects;
create policy "team_logos_select_public"
on storage.objects
for select
to public
using (bucket_id = 'team-logos');

drop policy if exists "team_logos_insert_own_folder" on storage.objects;
create policy "team_logos_insert_own_folder"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'team-logos'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and storage.extension(name) in ('webp', 'png', 'jpg', 'jpeg')
);

drop policy if exists "team_logos_update_own_folder" on storage.objects;
create policy "team_logos_update_own_folder"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'team-logos'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
)
with check (
  bucket_id = 'team-logos'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and storage.extension(name) in ('webp', 'png', 'jpg', 'jpeg')
);

drop policy if exists "team_logos_delete_own_folder" on storage.objects;
create policy "team_logos_delete_own_folder"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'team-logos'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

create or replace function public.update_match_team_branding(
  p_match_id uuid,
  p_team_key text,
  p_team_name text,
  p_logo_url text default null,
  p_logo_path text default null
)
returns public.matches
language plpgsql
security invoker
set search_path = public, app_private
as $$
declare
  v_match public.matches%rowtype;
  v_team_name text;
begin
  if p_team_key not in ('a', 'b') then
    raise exception 'Invalid team key';
  end if;

  if not app_private.can_manage_match_team(p_match_id, p_team_key) then
    raise exception 'You can only update your assigned team' using errcode = '42501';
  end if;

  v_team_name := nullif(trim(p_team_name), '');
  if v_team_name is null then
    v_team_name := case when p_team_key = 'a' then 'Team A' else 'Team B' end;
  end if;

  if p_team_key = 'a' then
    update public.matches
    set
      team_a_name = v_team_name,
      team_a_logo_url = coalesce(p_logo_url, team_a_logo_url),
      team_a_logo_path = coalesce(p_logo_path, team_a_logo_path)
    where id = p_match_id
    returning * into v_match;
  else
    update public.matches
    set
      team_b_name = v_team_name,
      team_b_logo_url = coalesce(p_logo_url, team_b_logo_url),
      team_b_logo_path = coalesce(p_logo_path, team_b_logo_path)
    where id = p_match_id
    returning * into v_match;
  end if;

  if v_match.id is null then
    raise exception 'Match not found';
  end if;

  return v_match;
end;
$$;

revoke execute on function public.update_match_team_branding(uuid, text, text, text, text) from public, anon;
grant execute on function public.update_match_team_branding(uuid, text, text, text, text) to authenticated;
