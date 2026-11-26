-- CLOUD-03.4D3 — persistent closed v3 backend, no client upload privileges.
create table public.sync_v3_gate(
 archive_id uuid primary key references public.archives(id) on delete restrict,
 enabled boolean not null default false,
 quota_bytes bigint not null default 268435456 check(quota_bytes between 1 and 268435456)
);
create table public.sync_v3_intents(
 archive_id uuid not null references public.sync_v3_gate(archive_id) on delete restrict,
 operation_id uuid not null, memory_id uuid not null, actor uuid not null,
 expected_revision bigint not null check(expected_revision>=0),
 revision bigint not null check(revision=expected_revision+1 and revision<=9007199254740991),
 header jsonb not null, reserved_bytes bigint not null check(reserved_bytes>0),
 committed boolean not null default false, created_at timestamptz not null default now(),
 primary key(archive_id,operation_id)
);
create unique index sync_v3_revision_unique on public.sync_v3_intents(archive_id,memory_id,revision) where committed;
create table public.sync_v3_blocks(
 archive_id uuid not null, operation_id uuid not null, path text not null,
 size bigint not null check(size between 1 and 4194304),
 sha256 text not null check(sha256~'^[0-9a-f]{64}$'),
 verified boolean not null default false,
 primary key(archive_id,operation_id,path),
 unique(path),
 foreign key(archive_id,operation_id) references public.sync_v3_intents(archive_id,operation_id)
);
alter table public.sync_v3_gate enable row level security;
alter table public.sync_v3_intents enable row level security;
alter table public.sync_v3_blocks enable row level security;
revoke all on public.sync_v3_gate,public.sync_v3_intents,public.sync_v3_blocks from public,anon,authenticated,service_role;
grant select on public.sync_v3_gate,public.sync_v3_intents,public.sync_v3_blocks to authenticated;
grant select,update(enabled) on public.sync_v3_gate to service_role;
grant select,insert,update(committed) on public.sync_v3_intents to service_role;
grant select,insert,update(verified) on public.sync_v3_blocks to service_role;
create policy v3_gate_member on public.sync_v3_gate for select to authenticated using(
 exists(select 1 from public.archive_members m where m.archive_id=sync_v3_gate.archive_id and m.user_id=(select auth.uid()) and m.role in ('owner','editor'))
);
create policy v3_intent_read on public.sync_v3_intents for select to authenticated using(
 (committed or actor=(select auth.uid())) and
 exists(select 1 from public.sync_v3_gate g where g.archive_id=sync_v3_intents.archive_id and g.enabled) and
 exists(select 1 from public.archive_members m where m.archive_id=sync_v3_intents.archive_id and m.user_id=(select auth.uid()) and m.role in ('owner','editor')) and
 exists(select 1 from public.archives a where a.id=sync_v3_intents.archive_id and a.key_fingerprint=sync_v3_intents.header->>'keyId')
);
create policy v3_block_read on public.sync_v3_blocks for select to authenticated using(
 exists(select 1 from public.sync_v3_intents i where i.archive_id=sync_v3_blocks.archive_id and i.operation_id=sync_v3_blocks.operation_id)
);
insert into public.sync_v3_gate(archive_id) select id from public.archives;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('archivito-v3-private','archivito-v3-private',false,4194304,array['application/octet-stream']);
-- No authenticated INSERT, UPDATE or DELETE policy for this bucket.
create policy v3_object_read on storage.objects for select to authenticated using(
 bucket_id='archivito-v3-private' and exists(select 1 from public.sync_v3_blocks b where b.path=name and b.verified)
);
-- Only trusted backend. Strict wire validation and verification of actual bytes
-- are prerequisites in Edge handler; service role is never given to browsers.
create function public.sync_v3_step(p_actor uuid,p_action text,p_header jsonb,p_path text default null,p_size bigint default null,p_hash text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare a uuid;op uuid;mem uuid;e bigint;r bigint;cur bigint;n bigint;used bigint;fingerprint text;
 gate public.sync_v3_gate%rowtype;saved public.sync_v3_intents%rowtype;
begin
 if p_actor is null or p_action is null or p_action not in ('begin','lookup','verify','commit') or p_header is null or p_header->>'format' is distinct from 'archivito-sync-record-wire-v1' then raise exception 'invalid';end if;
 a:=(p_header->>'archiveId')::uuid;op:=(p_header->>'operationId')::uuid;mem:=(p_header->>'memoryId')::uuid;e:=(p_header->>'expectedRevision')::bigint;r:=(p_header->>'revision')::bigint;
 if a is null or op is null or mem is null or e is null or r is null or e<0 or r<>e+1 or r>9007199254740991 then raise exception 'invalid revision';end if;
 select * into gate from public.sync_v3_gate where archive_id=a for update;
 if gate.enabled is distinct from true then raise exception 'disabled';end if;
 perform 1 from public.archive_members where archive_id=a and user_id=p_actor and role in ('owner','editor') for share;
 if not found then raise exception 'not member';end if;
 select key_fingerprint into fingerprint from public.archives where id=a for share;
 if fingerprint is null or fingerprint is distinct from p_header->>'keyId' then raise exception 'wrong key';end if;
 select * into saved from public.sync_v3_intents where archive_id=a and operation_id=op;
 if found then
  if saved.actor is distinct from p_actor or saved.header is distinct from p_header then raise exception 'intent mismatch';end if;
  if saved.committed then return jsonb_build_object('state','synced','operationId',op,'revision',r,'replayed',true);end if;
 elsif p_action<>'begin' then raise exception 'missing intent';end if;
 select coalesce(max(revision),0) into cur from public.sync_v3_intents where archive_id=a and memory_id=mem and committed;
 if cur<>e then return jsonb_build_object('state','conflict','operationId',op,'actualRevision',cur);end if;
 if p_action='begin' then
  if saved.operation_id is null then
   select coalesce(sum((c->>'size')::bigint),0)+octet_length(p_header::text) into n
   from jsonb_array_elements(p_header->'assets') x cross join lateral jsonb_array_elements(x->'chunks') c;
   if n is null or n<=0 or n>134217728+1600+600000 then raise exception 'invalid size';end if;
   select coalesce(sum(reserved_bytes),0) into used from public.sync_v3_intents where archive_id=a;
   if used+n>gate.quota_bytes or (select count(*) from public.sync_v3_intents where archive_id=a and not committed)>=8 or (select count(*) from public.sync_v3_intents where archive_id=a)>=512 then raise exception 'quota';end if;
   insert into public.sync_v3_intents(archive_id,operation_id,memory_id,actor,expected_revision,revision,header,reserved_bytes)
    values(a,op,mem,p_actor,e,r,p_header,n);
   insert into public.sync_v3_blocks(archive_id,operation_id,path,size,sha256)
    select a,op,c->>'path',(c->>'size')::bigint,c->>'sha256'
    from jsonb_array_elements(p_header->'assets') x cross join lateral jsonb_array_elements(x->'chunks') c;
  end if;
 end if;
 if p_action in ('begin','lookup') then
  return jsonb_build_object('state','staging','operationId',op,'verifiedPaths',coalesce((select jsonb_agg(path order by path) from public.sync_v3_blocks where archive_id=a and operation_id=op and verified),'[]'::jsonb));
 end if;
 if p_action='verify' then
  update public.sync_v3_blocks b set verified=true where b.archive_id=a and b.operation_id=op and b.path=p_path and b.size=p_size and b.sha256=p_hash
   and exists(select 1 from storage.objects o where o.bucket_id='archivito-v3-private' and o.name=b.path and (o.metadata->>'size')::bigint=b.size);
  if not found then raise exception 'bad attestation or missing object';end if;
  return jsonb_build_object('state','verified','operationId',op,'path',p_path);
 end if;
 if not exists(select 1 from public.sync_v3_blocks where archive_id=a and operation_id=op)
 or exists(select 1 from public.sync_v3_blocks b where b.archive_id=a and b.operation_id=op and
 (not b.verified or not exists(select 1 from storage.objects o where o.bucket_id='archivito-v3-private' and o.name=b.path and (o.metadata->>'size')::bigint=b.size))) then raise exception 'incomplete';end if;
 update public.sync_v3_intents set committed=true where archive_id=a and operation_id=op;
 return jsonb_build_object('state','synced','operationId',op,'revision',r,'replayed',false);
end $$;
revoke all on function public.sync_v3_step(uuid,text,jsonb,text,bigint,text) from public,anon,authenticated;
grant execute on function public.sync_v3_step(uuid,text,jsonb,text,bigint,text) to service_role;
