-- CANDIDATE ONLY: isolated database, after C3B3D.2 sources. Never apply to hosted DB.
-- Existing hard-closed CHECK remains intact. No window rows, no opening DDL.
-- Dedicated non-login role: no bypassrls, no membership granted to API roles,
-- and no direct privileges or RLS policies on Supabase-managed auth/storage schemas.
create role archivito_cert_executor nologin noinherit nobypassrls;
grant usage on schema public,archivito_inc,archivito_inc_cert_candidate to archivito_cert_executor;
grant usage on schema archivito_inc_cert_candidate to service_role;
revoke all on schema archivito_inc from public,anon,authenticated,service_role;
revoke all on all tables in schema archivito_inc from public,anon,authenticated,service_role;
revoke all on all tables in schema archivito_inc_cert_candidate from public,anon,authenticated,service_role;
revoke all on all functions in schema archivito_inc_cert_candidate from public,anon,authenticated,service_role;
revoke all on function public.sync_inc_step(uuid,text,jsonb,uuid,text),public.sync_inc_inspect(uuid,uuid,text,uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.sync_inc_step(uuid,text,jsonb,uuid,text),public.sync_inc_inspect(uuid,uuid,text,uuid,uuid,uuid) to archivito_cert_executor;
grant execute on all functions in schema archivito_inc_cert_candidate to archivito_cert_executor;
grant select on all tables in schema archivito_inc to archivito_cert_executor;
grant update(enabled) on archivito_inc.gates to archivito_cert_executor;
grant insert,update(state,last_activity) on archivito_inc.operations to archivito_cert_executor;
grant insert,update(committed_at) on archivito_inc.manifests to archivito_cert_executor;
grant insert,update(operation_id,revision) on archivito_inc.heads to archivito_cert_executor;
grant insert,update(state) on archivito_inc.assets to archivito_cert_executor;
grant insert,update(verified) on archivito_inc.blocks to archivito_cert_executor;
grant insert on archivito_inc.refs to archivito_cert_executor;
grant select on archivito_inc_cert_candidate.windows,archivito_inc_cert_candidate.fences to archivito_cert_executor;
grant update(enabled) on archivito_inc_cert_candidate.windows to archivito_cert_executor;
grant insert,update(generation,token,lease_until) on archivito_inc_cert_candidate.fences to archivito_cert_executor;
-- Row locks need UPDATE privilege on owned app tables. WITH CHECK false prevents
-- actual mutation of authorization rows through this executor. Existing policies
-- are not replaced, and no grants/policies are created on auth.* or storage.*.
grant select(id,key_fingerprint),update(id) on public.archives to archivito_cert_executor;
grant select(archive_id,user_id,role),update(user_id) on public.archive_members to archivito_cert_executor;
create policy inc_cert_exec_read on public.archives for select to archivito_cert_executor using(true);
create policy inc_cert_exec_lock on public.archives for update to archivito_cert_executor using(true) with check(false);
create policy inc_cert_exec_read on public.archive_members for select to archivito_cert_executor using(true);
create policy inc_cert_exec_lock on public.archive_members for update to archivito_cert_executor using(true) with check(false);
do $$ declare t text; begin
 foreach t in array array['gates','operations','manifests','heads','assets','blocks','refs','holds'] loop
  execute format('create policy inc_cert_exec_read on archivito_inc.%I for select to archivito_cert_executor using(true)',t);
 end loop;
 foreach t in array array['operations','manifests','heads','assets','blocks','refs'] loop
  execute format('create policy inc_cert_exec_insert on archivito_inc.%I for insert to archivito_cert_executor with check(true)',t);
 end loop;
 foreach t in array array['operations','manifests','heads','assets','blocks'] loop
  execute format('create policy inc_cert_exec_update on archivito_inc.%I for update to archivito_cert_executor using(true) with check(true)',t);
 end loop;
end $$;
create policy inc_cert_exec_lock on archivito_inc.gates for update to archivito_cert_executor using(true) with check(false);
create policy inc_cert_exec_read on archivito_inc_cert_candidate.windows for select to archivito_cert_executor using(true);
create policy inc_cert_exec_lock on archivito_inc_cert_candidate.windows for update to archivito_cert_executor using(true) with check(false);
create policy inc_cert_exec_read on archivito_inc_cert_candidate.fences for select to archivito_cert_executor using(true);
create policy inc_cert_exec_insert on archivito_inc_cert_candidate.fences for insert to archivito_cert_executor with check(true);
create policy inc_cert_exec_update on archivito_inc_cert_candidate.fences for update to archivito_cert_executor using(true) with check(true);

-- Restrictive policies prevent an existing/future permissive UPDATE policy
-- from turning lock-only privileges into permission to change authz rows.
create policy inc_cert_exec_no_mutation on public.archives as restrictive for update to archivito_cert_executor using(true) with check(false);
create policy inc_cert_exec_no_mutation on public.archive_members as restrictive for update to archivito_cert_executor using(true) with check(false);
create policy inc_cert_exec_no_mutation on archivito_inc.gates as restrictive for update to archivito_cert_executor using(true) with check(false);
create policy inc_cert_exec_no_mutation on archivito_inc_cert_candidate.windows as restrictive for update to archivito_cert_executor using(true) with check(false);

-- Minimal private SECURITY DEFINER bridges owned by the deploying non-superuser
-- admin (postgres). No dynamic SQL, no row exposure, fixed bucket/path/size checks,
-- and EXECUTE restricted exclusively to archivito_cert_executor.
create function archivito_inc_cert_candidate.lock_session(p_actor uuid,p_session uuid)
returns void language plpgsql security definer set search_path='' as $e56_bridge$
begin
 if p_actor is null or p_session is null then
  raise exception using errcode='42501',message='certification session denied';
 end if;
 perform 1 from auth.sessions
  where id=p_session and user_id=p_actor and (not_after is null or not_after>clock_timestamp())
  for share;
 if not found then
  raise exception using errcode='42501',message='certification session denied';
 end if;
end $e56_bridge$;

create function archivito_inc_cert_candidate.object_matches(p_path text,p_size bigint)
returns boolean language sql security definer set search_path='' as $e56_bridge$
 select p_path is not null
  and p_size is not null
  and p_size between 1 and 4194304
  and p_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-8]$'
  and exists(
   select 1 from storage.objects s
   where s.bucket_id='archivito-inc-private'
     and s.name=p_path
     and (s.metadata->>'size')::bigint=p_size
  );
$e56_bridge$;
revoke all on function archivito_inc_cert_candidate.lock_session(uuid,uuid),archivito_inc_cert_candidate.object_matches(text,bigint) from public,anon,authenticated,service_role;
grant execute on function archivito_inc_cert_candidate.lock_session(uuid,uuid),archivito_inc_cert_candidate.object_matches(text,bigint) to archivito_cert_executor;

-- Surgical update of the two Storage predicates in public.sync_inc_step.
-- Pinned to the exact verified baseline prosrc MD5; aborts on any core drift.
do $e56_step$
declare
 src text;
 patched text;
 p1 text := E'exists(\n    select 1 from storage.objects s where s.bucket_id=''archivito-inc-private'' and s.name=b.path and (s.metadata->>''size'')::bigint=b.bytes)';
 p2 text := 'exists(select 1 from storage.objects s where s.bucket_id=''archivito-inc-private'' and s.name=b.path and (s.metadata->>''size'')::bigint=b.bytes)';
begin
 select prosrc into strict src from pg_proc where oid='public.sync_inc_step(uuid,text,jsonb,uuid,text)'::regprocedure;
 if md5(src)<>'2ba9746fdc9d7ae955832f7c07bf1ead' then
  raise exception 'unexpected sync_inc_step baseline prosrc';
 end if;
 patched:=replace(replace(src,p1,'archivito_inc_cert_candidate.object_matches(b.path,b.bytes)'),p2,'archivito_inc_cert_candidate.object_matches(b.path,b.bytes)');
 if md5(patched)<>'d010b597b7cc21cae66b9fa09d01e3d0' then
  raise exception 'unexpected sync_inc_step patched prosrc';
 end if;
 execute 'create or replace function public.sync_inc_step(p_actor uuid,p_action text,w jsonb,p_asset uuid default null,p_hash text default null) '
      || 'returns jsonb language plpgsql security invoker set search_path='''' as $sync_inc_step_body$'
      || patched || '$sync_inc_step_body$';
end $e56_step$;

-- Private helper; no service/client grant. It locks in the order shared with
-- the legacy core and checks fresh authz. It grants no operation by itself.
-- The caller MUST already hold the certification window row FOR UPDATE.
-- Administrative transactions touching both window and gate must use window
-- -> gate -> session -> membership -> archive, never acquire window later.
create function archivito_inc_cert_candidate.lock_actor_context(
 p_actor uuid,p_session uuid,p_archive uuid,p_role text,p_key text
) returns void language plpgsql security invoker set search_path='' as $$
declare r text; k text;
begin
 if p_actor is null or p_session is null or p_archive is null
    or p_role is null or p_role not in('owner','editor') or p_key is null
 then raise exception using errcode='42501',message='certification denied';end if;
 -- Exclusive gate lock upfront: no SHARE -> UPDATE upgrade during core step.
 -- Closed gate still rejects in the actual core RPC; this helper cannot open it.
 perform 1 from archivito_inc.gates where archive_id=p_archive for update;
 if not found then raise exception using errcode='42501',message='certification denied';end if;
 perform archivito_inc_cert_candidate.lock_session(p_actor,p_session);
 select role into r from public.archive_members where archive_id=p_archive and user_id=p_actor for share;
 select key_fingerprint into k from public.archives where id=p_archive for share;
 if k is distinct from p_key or r is distinct from p_role
 then raise exception using errcode='42501',message='certification membership denied';end if;
end $$;
revoke all on function archivito_inc_cert_candidate.lock_actor_context(uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function archivito_inc_cert_candidate.lock_actor_context(uuid,uuid,uuid,text,text) to archivito_cert_executor;

-- Trusted Edge must call getUser on the JWT before forwarding actor/session.
-- Window serializes all wrapper calls; gate precedes authz locks, then fence.
-- A final guard after core work revalidates expiry and session not_after.
create function archivito_inc_cert_candidate.actor_guard(p_actor uuid,p_session uuid,p_archive uuid)
returns archivito_inc_cert_candidate.windows language plpgsql security invoker set search_path='' as $$
declare w archivito_inc_cert_candidate.windows%rowtype;
begin
 select * into w from archivito_inc_cert_candidate.windows where archive_id=p_archive for update;
 if not found or w.enabled is distinct from true or clock_timestamp()<w.opened_at or clock_timestamp()>=w.expires_at
 then raise exception using errcode='42501',message='certification denied';end if;
 if p_actor is null or p_session is null or p_actor not in(w.owner_id,w.editor_id) then raise exception using errcode='42501',message='certification denied';end if;
 perform archivito_inc_cert_candidate.lock_actor_context(p_actor,p_session,p_archive,case when p_actor=w.owner_id then 'owner' else 'editor' end,w.key_id);
 if clock_timestamp()>=w.expires_at then raise exception using errcode='42501',message='certification denied';end if;
 return w;
end $$;

-- Only guarded private function elevates from the trusted service API role.
-- No dynamic SQL; all objects schema-qualified; dedicated NOLOGIN owner.
create function archivito_inc_cert_candidate.dispatch(
 p_actor uuid,p_session uuid,p_action text,p_archive uuid,p_wire jsonb default null,
 p_memory uuid default null,p_operation uuid default null,p_asset uuid default null,
 p_hash text default null,p_generation bigint default null,p_token uuid default null
) returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare win archivito_inc_cert_candidate.windows%rowtype; i record; f archivito_inc_cert_candidate.fences%rowtype;
 result jsonb; mem uuid;
begin
 if p_action is null or p_action not in('claim','lookup','attest','commit','intent','head','revision','catalog') then raise exception 'invalid action';end if;
 win:=archivito_inc_cert_candidate.actor_guard(p_actor,p_session,p_archive);
 if p_action in('claim','lookup','attest','commit') then
  select * into strict i from archivito_inc_cert_candidate.wire_identity(p_wire);
  if i.archive_id is distinct from p_archive then raise exception 'scope';end if;
  if p_action='claim' then
   if p_generation is not null or p_token is not null then raise exception 'unexpected fence';end if;
   result:=archivito_inc_cert_candidate.claim_begin(win.id,p_actor,p_wire);
  else
   result:=archivito_inc_cert_candidate.fenced_step(win.id,p_actor,p_generation,p_token,p_action,p_wire,p_asset,p_hash);
  end if;
 elsif p_action='intent' then
  select * into f from archivito_inc_cert_candidate.fences where window_id=win.id and operation_id=p_operation;
  if not found then raise exception using errcode='42501',message='certification fence denied';end if;
  perform archivito_inc_cert_candidate.assert_fence(win.id,p_archive,p_actor,win.key_id,f.memory_id,p_operation,p_generation,p_token,f.wire_digest,true);
  result:=public.sync_inc_inspect(p_actor,p_archive,'intent',null,p_operation,null);
  select * into strict i from archivito_inc_cert_candidate.wire_identity(result);
  if i.digest is distinct from f.wire_digest or i.memory_id is distinct from f.memory_id then raise exception 'intent mismatch';end if;
  perform archivito_inc_cert_candidate.assert_fence(win.id,p_archive,p_actor,win.key_id,f.memory_id,p_operation,p_generation,p_token,f.wire_digest);
 else
  if p_generation is not null or p_token is not null then raise exception 'unexpected fence';end if;
  mem:=p_memory;
  perform archivito_inc_cert_candidate.guard_window(win.id,p_archive,p_actor,win.key_id,mem);
  result:=public.sync_inc_inspect(p_actor,p_archive,p_action,mem,p_operation,p_asset);
  perform archivito_inc_cert_candidate.guard_window(win.id,p_archive,p_actor,win.key_id,mem);
 end if;
 perform archivito_inc_cert_candidate.actor_guard(p_actor,p_session,p_archive);
 return result;
end $$;
-- Set dispatch ACL while still owned by the deploying admin; ALTER FUNCTION OWNER
-- preserves ACLs and updates the grantor automatically for non-superuser deploys.
revoke all on function archivito_inc_cert_candidate.actor_guard(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function archivito_inc_cert_candidate.actor_guard(uuid,uuid,uuid) to archivito_cert_executor;
revoke all on function archivito_inc_cert_candidate.dispatch(uuid,uuid,text,uuid,jsonb,uuid,uuid,uuid,text,bigint,uuid) from public,anon,authenticated,service_role;
grant execute on function archivito_inc_cert_candidate.dispatch(uuid,uuid,text,uuid,jsonb,uuid,uuid,uuid,text,bigint,uuid) to service_role;
-- Non-superuser-compatible ownership transfer: grant minimal temporary CREATE
-- on candidate schema and SET-capable membership, then revoke both immediately.
grant create on schema archivito_inc_cert_candidate to archivito_cert_executor;
do $e56_owner$
declare admin_role text := current_user;
begin
 if not (select rolsuper from pg_roles where rolname=admin_role) then
  execute format('grant archivito_cert_executor to %I with set true',admin_role);
 end if;
 alter function archivito_inc_cert_candidate.dispatch(uuid,uuid,text,uuid,jsonb,uuid,uuid,uuid,text,bigint,uuid) owner to archivito_cert_executor;
 if not (select rolsuper from pg_roles where rolname=admin_role) then
  execute format('revoke archivito_cert_executor from %I',admin_role);
 end if;
end $e56_owner$;
revoke create on schema archivito_inc_cert_candidate from archivito_cert_executor;

create function public.sync_inc_cert_http(
 p_actor uuid,p_session uuid,p_action text,p_archive uuid,p_wire jsonb default null,
 p_memory uuid default null,p_operation uuid default null,p_asset uuid default null,
 p_hash text default null,p_generation bigint default null,p_token uuid default null
) returns jsonb language sql security invoker set search_path='' as $$
 select archivito_inc_cert_candidate.dispatch(p_actor,p_session,p_action,p_archive,p_wire,p_memory,p_operation,p_asset,p_hash,p_generation,p_token);
$$;
revoke all on function public.sync_inc_cert_http(uuid,uuid,text,uuid,jsonb,uuid,uuid,uuid,text,bigint,uuid) from public,anon,authenticated,service_role;
grant execute on function public.sync_inc_cert_http(uuid,uuid,text,uuid,jsonb,uuid,uuid,uuid,text,bigint,uuid) to service_role;
-- No legacy core API grants. service_role still has platform-wide powers (e.g.
-- Storage secret); the trusted Edge boundary is required, not a compromised-key defense.
