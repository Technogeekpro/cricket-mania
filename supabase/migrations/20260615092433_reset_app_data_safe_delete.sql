-- The Supabase safe-updates guard rejects unqualified DELETE/UPDATE with
-- SQLSTATE 21000 ("DELETE requires a WHERE clause"). reset_app_data() was
-- written with bare DELETEs which would fail for any admin trying to reset.
-- Add a trivial WHERE id IS NOT NULL to satisfy the guard while still wiping
-- every row.

create or replace function public.reset_app_data()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not app_private.is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  delete from public.deliveries where id is not null;
  delete from public.match_players where id is not null;
  delete from public.matches where id is not null;
end;
$$;
