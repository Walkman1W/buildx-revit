-- Reviewable migration source. Generate a versioned Supabase migration with
-- the CLI after comparing the target schema; do not apply to a remote project
-- without separate authorization. Requires PostgreSQL 15+ and Supabase Auth.
begin;
create schema if not exists buildx_private;
revoke all on schema buildx_private from public, anon, authenticated;
grant usage on schema buildx_private to authenticated, service_role;

create table buildx_private.profiles (
  user_id uuid primary key references auth.users(id), created_at timestamptz not null default now()
);
create table buildx_private.invites (
  id uuid primary key default gen_random_uuid(), code_hash bytea unique not null,
  kind text not null check (kind in ('trial','active')),
  duration_seconds bigint not null check (duration_seconds between 1 and 315360000),
  expires_at timestamptz not null, max_uses integer not null check (max_uses > 0),
  disabled_at timestamptz, created_at timestamptz not null default now()
);
create table buildx_private.licenses (
  user_id uuid primary key references auth.users(id), invite_id uuid not null references buildx_private.invites(id),
  kind text not null check (kind in ('trial','active')), starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at), disabled_at timestamptz
);
create table buildx_private.redemptions (
  user_id uuid primary key references auth.users(id), invite_id uuid not null references buildx_private.invites(id),
  redeemed_at timestamptz not null default now()
);
alter table buildx_private.profiles enable row level security;
alter table buildx_private.invites enable row level security;
alter table buildx_private.licenses enable row level security;
alter table buildx_private.redemptions enable row level security;
revoke all on all tables in schema buildx_private from public, anon, authenticated;

-- Privileged operators call this through a restricted database administration
-- path. The random code is displayed only once; only its SHA-256 is retained.
create function buildx_private.create_invite(p_kind text, p_duration_seconds bigint, p_expires_at timestamptz, p_max_uses integer)
returns text language plpgsql security definer set search_path = '' as $$
declare code text;
begin
  if p_kind not in ('trial','active') or p_duration_seconds not between 1 and 315360000 or
     p_expires_at <= clock_timestamp() or p_max_uses < 1 then raise exception 'invalid invite configuration'; end if;
  code := replace(pg_catalog.gen_random_uuid()::text, '-', '') || replace(pg_catalog.gen_random_uuid()::text, '-', '');
  insert into buildx_private.invites(code_hash,kind,duration_seconds,expires_at,max_uses)
    values (pg_catalog.sha256(pg_catalog.convert_to(code,'UTF8')),p_kind,p_duration_seconds,p_expires_at,p_max_uses);
  return code;
end $$;
revoke all on function buildx_private.create_invite(text,bigint,timestamptz,integer) from public, anon, authenticated;
grant execute on function buildx_private.create_invite(text,bigint,timestamptz,integer) to service_role;

create function buildx_private.license_status() returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); lic buildx_private.licenses%rowtype;
begin
  if uid is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) or
     not exists(select 1 from auth.users u where u.id=uid) then raise exception 'authentication required' using errcode='42501'; end if;
  select * into lic from buildx_private.licenses where user_id=uid;
  if not found then return jsonb_build_object('status','unactivated','startsAt',null,'endsAt',null); end if;
  return jsonb_build_object('status',case when lic.disabled_at is not null then 'disabled'
    when lic.ends_at <= clock_timestamp() then 'expired' else lic.kind end,
    'startsAt',lic.starts_at,'endsAt',lic.ends_at);
end $$;

create function buildx_private.redeem_invite(invite_code text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); inv buildx_private.invites%rowtype; at_time timestamptz;
begin
  if uid is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) or
     not exists(select 1 from auth.users u where u.id=uid) then raise exception 'authentication required' using errcode='42501'; end if;
  if invite_code is null or invite_code !~ '^[0-9a-f]{64}$' then raise exception 'invalid input' using errcode='22023'; end if;
  -- Serialize all first activations for this account, including different codes.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text,0));
  if exists(select 1 from buildx_private.redemptions where user_id=uid) then return buildx_private.license_status(); end if;
  select * into inv from buildx_private.invites where code_hash=pg_catalog.sha256(pg_catalog.convert_to(invite_code,'UTF8')) for update;
  at_time := clock_timestamp();
  if not found or inv.disabled_at is not null or inv.expires_at <= at_time or
     (select count(*) from buildx_private.redemptions where invite_id=inv.id) >= inv.max_uses then
    return buildx_private.license_status();
  end if;
  insert into buildx_private.profiles(user_id) values(uid) on conflict do nothing;
  insert into buildx_private.redemptions(user_id,invite_id,redeemed_at) values(uid,inv.id,at_time);
  insert into buildx_private.licenses(user_id,invite_id,kind,starts_at,ends_at)
    values(uid,inv.id,inv.kind,at_time,at_time + inv.duration_seconds * interval '1 second');
  return buildx_private.license_status();
end $$;
revoke all on function buildx_private.license_status() from public, anon;
revoke all on function buildx_private.redeem_invite(text) from public, anon;
grant execute on function buildx_private.license_status() to authenticated;
grant execute on function buildx_private.redeem_invite(text) to authenticated;

-- These invoker-only wrappers expose no table access and delegate to fixed,
-- identity-checked private functions. No user-supplied account ID is accepted.
create function public.buildx_license_status() returns jsonb language sql security invoker set search_path = ''
  as $$ select buildx_private.license_status() $$;
create function public.buildx_redeem_invite(invite_code text) returns jsonb language sql security invoker set search_path = ''
  as $$ select buildx_private.redeem_invite(invite_code) $$;
revoke all on function public.buildx_license_status() from public, anon;
revoke all on function public.buildx_redeem_invite(text) from public, anon;
grant execute on function public.buildx_license_status() to authenticated;
grant execute on function public.buildx_redeem_invite(text) to authenticated;
commit;
