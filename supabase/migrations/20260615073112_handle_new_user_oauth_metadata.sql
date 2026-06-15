-- Make handle_new_user OAuth-aware: pull display name and avatar URL from
-- Google / other OAuth metadata when present so first-time OAuth signups land
-- with a real name and profile photo instead of an email prefix.

create or replace function app_private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_display_name text;
  v_avatar_url text;
begin
  v_display_name := coalesce(
    nullif(new.raw_user_meta_data->>'display_name', ''),
    nullif(new.raw_user_meta_data->>'full_name', ''),
    nullif(new.raw_user_meta_data->>'name', ''),
    nullif(new.raw_user_meta_data->>'preferred_username', ''),
    split_part(coalesce(new.email, 'Player'), '@', 1)
  );

  v_avatar_url := coalesce(
    nullif(new.raw_user_meta_data->>'avatar_url', ''),
    nullif(new.raw_user_meta_data->>'picture', '')
  );

  insert into public.profiles (id, email, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.email, ''),
    v_display_name,
    v_avatar_url
  )
  on conflict (id) do update
    set
      email = excluded.email,
      display_name = case
        when public.profiles.display_name is null
          or public.profiles.display_name = ''
          or public.profiles.display_name = split_part(public.profiles.email, '@', 1)
        then excluded.display_name
        else public.profiles.display_name
      end,
      avatar_url = coalesce(public.profiles.avatar_url, excluded.avatar_url);

  insert into public.user_roles (user_id, role)
  values (new.id, 'player')
  on conflict (user_id) do nothing;

  return new;
end;
$$;
