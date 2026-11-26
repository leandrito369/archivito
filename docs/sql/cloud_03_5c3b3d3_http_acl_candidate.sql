-- CANDIDATE ONLY: isolated database, after C3B3D.2 sources. Never apply to hosted DB.
-- Existing hard-closed CHECK remains intact. No window rows, no opening DDL.
-- Dedicated non-login role: no bypassrls, no membership granted to API roles.
create role archivito_cert_executor nologin noinherit nobypassrls;
grant usage on schema public,auth,storage,archivito_inc,archivito_inc_cert_candidate to archivito_cert_executor;
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
-- Row locks need UPDATE privilege. WITH CHECK false prevents actual mutation of
-- authorization rows through this executor. Existing policies are not replaced.
grant select(id,key_fingerprint),update(id) on public.archives to archivito_cert_executor;
grant select(archive_id,user_id,role),update(user_id) on public.archive_members to archivito_cert_executor;
grant select(id,user_id,not_after),update(id) on auth.sessions to archivito_cert_executor;
grant select(bucket_id,name,metadata) on storage.objects to archivito_cert_executor;
create policy inc_cert_exec_read on public.archives for select to archivito_cert_executor using(true);
create policy inc_cert_exec_lock on public.archives for update to archivito_cert_executor using(true) with check(false);
create policy inc_cert_exec_read on public.archive_members for select to archivito_cert_executor using(true);
create policy inc_cert_exec_lock on public.archive_members for update to archivito_cert_executor using(true) with check(false);
create policy inc_cert_exec_read on auth.sessions for select to archivito_cert_executor using(true);
create policy inc_cert_exec_lock on auth.sessions for update to archivito_cert_executor using(true) with check(false);
create policy inc_cert_exec_read on storage.objects for select to archivito_cert_executor using(bucket_id='archivito-inc-private');
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

-- Trusted Edge must call getUser on the JWT before forwarding actor/session.
-- Session lookup is an additional revocation check, not JWT verification.
create function archivito_inc_cert_candidate.actor_guard(p_actor uuid,p_session uuid,p_archive uuid)
returns archivito_inc_cert_candidate.windows language plpgsql security invoker set search_path='' as $$
declare w archivito_inc_cert_candidate.windows%rowtype; r text; k text;
begin
 select * into w from archivito_inc_cert_candidate.windows where archive_id=p_archive for update;
 if not found or w.enabled is distinct from true or clock_timestamp()<w.opened_at or clock_timestamp()>=w.expires_at
 then raise exception using errcode='42501',message='certification denied';end if;
 if p_actor is null or p_session is null or p_actor not in(w.owner_id,w.editor_id) then raise exception using errcode='42501',message='certification denied';end if;
 perform 1 from auth.sessions where id=p_session and user_id=p_actor and (not_after is null or not_after>clock_timestamp()) for share;
 if not found then raise exception using errcode='42501',message='certification session denied';end if;
 select role into r from public.archive_members where archive_id=p_archive and user_id=p_actor for share;
 select key_fingerprint into k from public.archives where id=p_archive for share;
 if k is distinct from w.key_id or r is distinct from (case when p_actor=w.owner_id then 'owner' else 'editor' end)
 then raise exception using errcode='42501',message='certification membership denied';end if;
 return w;
end $$;

-- Only guarded private function elevates from the trusted service API role.
-- No dynamic SQL; all objects schema-qualified; dedicated NOLOGIN owner.
create function archivito_inc_cert_candidate.dispatch(
 p_actor uuid,p_session uuid,p_action text,p_archive uuid,p_wire jsonb default null,
 p_memory uuid default null,p_operation uuid default null,p_asset uuid default null,
 p_hash text default null,p_generation bigint default null,p_token uuid default null
) returns jsonb language plpgsql security definer set search_path='' as $$
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
-- Owner assignment requires an administrative deployment review; lab runs as postgres.
alter function archivito_inc_cert_candidate.dispatch(uuid,uuid,text,uuid,jsonb,uuid,uuid,uuid,text,bigint,uuid) owner to archivito_cert_executor;
revoke all on function archivito_inc_cert_candidate.actor_guard(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function archivito_inc_cert_candidate.actor_guard(uuid,uuid,uuid) to archivito_cert_executor;
revoke all on function archivito_inc_cert_candidate.dispatch(uuid,uuid,text,uuid,jsonb,uuid,uuid,uuid,text,bigint,uuid) from public,anon,authenticated,service_role;
grant execute on function archivito_inc_cert_candidate.dispatch(uuid,uuid,text,uuid,jsonb,uuid,uuid,uuid,text,bigint,uuid) to service_role;

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
