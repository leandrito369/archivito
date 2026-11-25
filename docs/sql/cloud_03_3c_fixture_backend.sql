-- CLOUD-03.3C: isolated fixture backend, disabled by default.
create table public.sync_fixture_gate (
 archive_id uuid primary key references public.archives(id) on delete restrict,
 enabled boolean not null default false
);
create table public.sync_fixture_intents (
 archive_id uuid not null references public.sync_fixture_gate(archive_id) on delete restrict,
 operation_id uuid not null, memory_id uuid not null, actor uuid not null,
 revision bigint not null check(revision between 1 and 9007199254740991),
 header jsonb not null, committed boolean not null default false,
 created_at timestamptz not null default now(),
 primary key(archive_id,operation_id)
);
create unique index sync_fixture_committed_revision on public.sync_fixture_intents(archive_id,memory_id,revision) where committed;
alter table public.sync_fixture_gate enable row level security;
alter table public.sync_fixture_intents enable row level security;
revoke all on public.sync_fixture_gate,public.sync_fixture_intents from public,anon,authenticated;
grant select on public.sync_fixture_gate,public.sync_fixture_intents to authenticated;
grant select,insert,update on public.sync_fixture_gate,public.sync_fixture_intents to service_role;
create policy fixture_gate_member on public.sync_fixture_gate for select to authenticated using (
 exists(select 1 from public.archive_members m where m.archive_id=sync_fixture_gate.archive_id and m.user_id=(select auth.uid()))
);
create policy fixture_intent_member on public.sync_fixture_intents for select to authenticated using (
 (actor=(select auth.uid()) or committed)
 and exists(select 1 from public.sync_fixture_gate g where g.archive_id=sync_fixture_intents.archive_id and g.enabled)
 and exists(select 1 from public.archive_members m where m.archive_id=sync_fixture_intents.archive_id and m.user_id=(select auth.uid()))
);
insert into public.sync_fixture_gate(archive_id,enabled) select id,false from public.archives;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('archivito-sync-lab','archivito-sync-lab',false,8388624,array['application/octet-stream']);
-- No UPDATE/DELETE policies. Exact path in a current visible intent, only in lab bucket.
create policy fixture_upload_exact on storage.objects for insert to authenticated with check (
 bucket_id='archivito-sync-lab' and exists(
  select 1 from public.sync_fixture_intents i cross join lateral jsonb_array_elements(i.header->'assets') a
  where i.actor=(select auth.uid()) and not i.committed and a->>'path'=name
 )
);
create policy fixture_read_exact on storage.objects for select to authenticated using (
 bucket_id='archivito-sync-lab' and exists(
  select 1 from public.sync_fixture_intents i cross join lateral jsonb_array_elements(i.header->'assets') a where a->>'path'=name
 )
);
-- The Edge Function is the only intended caller: explicit authorization in transaction,
-- immutable JSON header already strictly validated by server core. No client execution grant.
create function public.sync_fixture_step(p_actor uuid,p_action text,p_header jsonb)
 returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 a uuid; op uuid; mem uuid; r bigint; expected bigint; current_rev bigint;
 g boolean; fingerprint text; saved public.sync_fixture_intents%rowtype;
begin
 if p_actor is null or p_action is null or p_action not in ('begin','lookup','commit') or p_header is null then raise exception 'invalid request'; end if;
 a:=(p_header->>'archiveId')::uuid; op:=(p_header->>'operationId')::uuid; mem:=(p_header->>'memoryId')::uuid;
 r:=(p_header->>'revision')::bigint; expected:=(p_header->>'expectedRevision')::bigint;
 if a is null or op is null or mem is null or r is null or expected is null or expected<0 or r<>expected+1 or r>9007199254740991 then raise exception 'invalid revision'; end if;
 select enabled into g from public.sync_fixture_gate where archive_id=a for update;
 if g is distinct from true then raise exception 'lab disabled'; end if;
 perform 1 from public.archive_members where archive_id=a and user_id=p_actor and role in ('owner','editor') for share;
 if not found then raise exception 'not a member';end if;
 select key_fingerprint into fingerprint from public.archives where id=a for share;
 if fingerprint is null or fingerprint is distinct from p_header->>'keyId' then raise exception 'key mismatch';end if;
 select * into saved from public.sync_fixture_intents where archive_id=a and operation_id=op;
 if found then
  if saved.actor is distinct from p_actor or saved.header is distinct from p_header then raise exception 'intent mismatch';end if;
  if saved.committed then return jsonb_build_object('state','synced','operationId',op,'revision',saved.revision,'replayed',true);end if;
 elsif p_action<>'begin' then raise exception 'missing intent';end if;
 select coalesce(max(revision),0) into current_rev from public.sync_fixture_intents where archive_id=a and memory_id=mem and committed;
 if current_rev<>expected then return jsonb_build_object('state','conflict','operationId',op,'actualRevision',current_rev);end if;
 if p_action='begin' then
  if saved.operation_id is null then
   if (select count(*) from public.sync_fixture_intents where archive_id=a)>=8 then raise exception 'lab quota';end if;
   insert into public.sync_fixture_intents(archive_id,operation_id,memory_id,actor,revision,header) values(a,op,mem,p_actor,r,p_header);
  end if;
  return jsonb_build_object('state','staging','operationId',op);
 end if;
 if p_action='lookup' then return jsonb_build_object('state','staging','operationId',op);end if;
 -- Edge verified exact bytes independently; objects are create-only to clients.
 if exists(select 1 from jsonb_array_elements(p_header->'assets') x where not exists(select 1 from storage.objects o where o.bucket_id='archivito-sync-lab' and o.name=x->>'path')) then raise exception 'missing object';end if;
 update public.sync_fixture_intents set committed=true where archive_id=a and operation_id=op;
 return jsonb_build_object('state','synced','operationId',op,'revision',r,'replayed',false);
end $$;
revoke all on function public.sync_fixture_step(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.sync_fixture_step(uuid,text,jsonb) to service_role;
