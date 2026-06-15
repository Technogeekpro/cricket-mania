create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  expiration_time timestamptz,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create trigger push_subscriptions_set_updated_at
before update on public.push_subscriptions
for each row execute function public.set_updated_at();

alter table public.push_subscriptions enable row level security;

create policy "push_subscriptions_select_own"
on public.push_subscriptions for select
to authenticated
using (user_id = (select auth.uid()));

create policy "push_subscriptions_delete_own"
on public.push_subscriptions for delete
to authenticated
using (user_id = (select auth.uid()));

create index push_subscriptions_user_idx on public.push_subscriptions(user_id);
create index push_subscriptions_last_seen_idx on public.push_subscriptions(last_seen_at desc);

create or replace function app_private.save_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_expiration_time timestamptz default null,
  p_user_agent text default null
)
returns public.push_subscriptions
language plpgsql
security definer
set search_path = public, app_private
as $$
declare
  v_profile public.profiles%rowtype;
  v_subscription public.push_subscriptions%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Login required' using errcode = '42501';
  end if;

  select *
  into v_profile
  from public.profiles
  where id = auth.uid();

  if v_profile.id is null then
    raise exception 'Profile not found' using errcode = '42501';
  end if;

  if v_profile.is_banned then
    raise exception 'This account is banned' using errcode = '42501';
  end if;

  if nullif(trim(p_endpoint), '') is null or nullif(trim(p_p256dh), '') is null or nullif(trim(p_auth), '') is null then
    raise exception 'Invalid push subscription';
  end if;

  insert into public.push_subscriptions (
    user_id,
    endpoint,
    p256dh,
    auth,
    expiration_time,
    user_agent,
    last_seen_at
  )
  values (
    auth.uid(),
    p_endpoint,
    p_p256dh,
    p_auth,
    p_expiration_time,
    left(p_user_agent, 500),
    now()
  )
  on conflict (endpoint) do update
  set
    user_id = excluded.user_id,
    p256dh = excluded.p256dh,
    auth = excluded.auth,
    expiration_time = excluded.expiration_time,
    user_agent = excluded.user_agent,
    last_seen_at = now(),
    updated_at = now()
  returning * into v_subscription;

  return v_subscription;
end;
$$;

create or replace function public.save_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_expiration_time timestamptz default null,
  p_user_agent text default null
)
returns public.push_subscriptions
language sql
security invoker
set search_path = public, app_private
as $$
  select * from app_private.save_push_subscription(p_endpoint, p_p256dh, p_auth, p_expiration_time, p_user_agent);
$$;

revoke execute on function public.save_push_subscription(text, text, text, timestamptz, text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text, timestamptz, text) to authenticated;
