-- CLOUD-03.5C3B1 candidate; NOT a deployed migration. No bucket or RPC.
create schema archivito_inc;
revoke all on schema archivito_inc from public,anon,authenticated,service_role;
create table archivito_inc.gates(
 archive_id uuid primary key references public.archives(id) on delete restrict,
 enabled boolean not null default false constraint inc_gate_hard_closed check(not enabled),
 quota_bytes bigint not null default 268435456 check(quota_bytes between 1 and 268435456)
);
-- Operation identity and receipt outlive the manifest. No operation ID reuse.
create table archivito_inc.operations(
 archive_id uuid references archivito_inc.gates(archive_id), operation_id uuid, memory_id uuid not null,
 actor uuid not null,key_id text not null check(key_id~'^[0-9a-f]{64}$'),
 revision bigint not null check(revision between 1 and 9007199254740991),
 base_revision bigint not null,base_operation_id uuid,
 digest text not null check(digest~'^[0-9a-f]{64}$'),
 state text not null check(state in ('staging','committed','fenced','aborted')),
 receipt_bytes bigint not null check(receipt_bytes between 1 and 600000),
 created_at timestamptz not null default now(),last_activity timestamptz not null default now(),
 lease_until timestamptz,
 primary key(archive_id,operation_id),
 unique(archive_id,memory_id,operation_id),
 unique(archive_id,memory_id,operation_id,revision),
 check(base_revision=revision-1 and (base_revision=0)=(base_operation_id is null) and base_operation_id is distinct from operation_id),
 foreign key(archive_id,memory_id,base_operation_id,base_revision) references archivito_inc.operations(archive_id,memory_id,operation_id,revision)
);
create unique index inc_committed_revision on archivito_inc.operations(archive_id,memory_id,revision) where state='committed';
create table archivito_inc.manifests(
 archive_id uuid,memory_id uuid,operation_id uuid,revision bigint,
 encrypted_header jsonb not null,charged_bytes bigint not null check(charged_bytes between 1 and 600000),
 pinned boolean not null default false,committed_at timestamptz,
 primary key(archive_id,memory_id,operation_id),
 unique(archive_id,memory_id,operation_id,revision),
 foreign key(archive_id,memory_id,operation_id,revision) references archivito_inc.operations(archive_id,memory_id,operation_id,revision)
);
create table archivito_inc.heads(
 archive_id uuid,memory_id uuid,operation_id uuid not null,revision bigint not null,
 primary key(archive_id,memory_id),
 foreign key(archive_id,memory_id,operation_id,revision) references archivito_inc.manifests(archive_id,memory_id,operation_id,revision)
);
-- Catalog retains descriptor and birth operation even when its manifest is retired.
create table archivito_inc.assets(
 archive_id uuid,asset_id uuid,memory_id uuid not null,birth_operation_id uuid not null,born bigint not null,
 ciphertext_bytes bigint not null check(ciphertext_bytes between 17 and 36700176),
 nonce text not null check(nonce~'^[A-Za-z0-9_-]{16}$'),
 cipher_sha256 text not null check(cipher_sha256~'^[0-9a-f]{64}$'),
 state text not null check(state in ('staging','ready','gc')),
 primary key(archive_id,asset_id),
 unique(archive_id,memory_id,asset_id),
 foreign key(archive_id,memory_id,birth_operation_id,born) references archivito_inc.operations(archive_id,memory_id,operation_id,revision)
);
create table archivito_inc.blocks(
 archive_id uuid,memory_id uuid,asset_id uuid,block_index integer check(block_index between 0 and 8),
 path text not null unique,bytes integer not null check(bytes between 1 and 4194304),
 sha256 text not null check(sha256~'^[0-9a-f]{64}$'),verified boolean not null default false,
 primary key(archive_id,asset_id,block_index),
 foreign key(archive_id,memory_id,asset_id) references archivito_inc.assets(archive_id,memory_id,asset_id),
 check(path=archive_id::text||'/'||memory_id::text||'/'||asset_id::text||'/'||block_index::text)
);
-- References of staging and committed manifests both protect the same asset.
create table archivito_inc.refs(
 archive_id uuid,memory_id uuid,operation_id uuid,asset_id uuid,
 primary key(archive_id,memory_id,operation_id,asset_id),
 foreign key(archive_id,memory_id,operation_id) references archivito_inc.manifests(archive_id,memory_id,operation_id),
 foreign key(archive_id,memory_id,asset_id) references archivito_inc.assets(archive_id,memory_id,asset_id)
);
create index inc_refs_asset on archivito_inc.refs(archive_id,memory_id,asset_id);
create table archivito_inc.holds(
 archive_id uuid,memory_id uuid,operation_id uuid,hold_id uuid,
 kind text not null check(kind in ('read','restore','backup')),
 primary key(archive_id,hold_id),
 foreign key(archive_id,memory_id,operation_id) references archivito_inc.manifests(archive_id,memory_id,operation_id)
);
-- No public exposure, direct client access, service grants or write API in B1.
do $$ declare t text; begin
 foreach t in array array['gates','operations','manifests','heads','assets','blocks','refs','holds'] loop
  execute format('alter table archivito_inc.%I enable row level security',t);
 end loop;
end $$;
revoke all on all tables in schema archivito_inc from public,anon,authenticated,service_role;

-- CLOUD-03.5C3B2A: closed RPC, trusted server only. No Storage writes or GC.
grant usage on schema archivito_inc to service_role;
grant select on all tables in schema archivito_inc to service_role;
grant update(enabled) on archivito_inc.gates to service_role;
grant insert,update(state,last_activity) on archivito_inc.operations to service_role;
grant insert,update(committed_at) on archivito_inc.manifests to service_role;
grant insert,update(operation_id,revision) on archivito_inc.heads to service_role;
grant insert,update(state) on archivito_inc.assets to service_role;
grant insert,update(verified) on archivito_inc.blocks to service_role;
grant insert on archivito_inc.refs to service_role;
insert into archivito_inc.gates(archive_id) select id from public.archives;
-- The future Edge service MUST validateIncrementalWire, authenticate getUser,
-- and independently read/hash the whole ciphertext before calling attest.
create function public.sync_inc_step(p_actor uuid,p_action text,w jsonb,p_asset uuid default null,p_hash text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare a uuid;o uuid;m uuid;r bigint;br bigint;bo uuid;h jsonb;d jsonb;up jsonb;x uuid;fp text;dg text;
 g archivito_inc.gates%rowtype;old archivito_inc.operations%rowtype;cur archivito_inc.heads%rowtype;
 need bigint;used bigint;header_bytes bigint;
begin
 if p_actor is null or p_action is null or p_action not in ('begin','lookup','attest','commit') or w->>'format' is distinct from 'archivito-incremental-wire-v1' then raise exception 'invalid';end if;
 h:=w->'header';a:=(h->>'archiveId')::uuid;o:=(h->>'operationId')::uuid;m:=(h->>'memoryId')::uuid;r:=(h->>'revision')::bigint;
 br:=coalesce((w->'base'->>'revision')::bigint,0);bo:=(w->'base'->>'operationId')::uuid;
 header_bytes:=octet_length(w::text);
 if a is null or o is null or m is null or r is null or r<1 or r>9007199254740991 or r<>br+1 or (br=0)<>(bo is null) or bo=o
 or header_bytes>600000 or jsonb_typeof(h->'refs') is distinct from 'array' or jsonb_typeof(w->'uploads') is distinct from 'array' then raise exception 'invalid';end if;
 if jsonb_array_length(h->'refs') not between 1 and 100 or jsonb_array_length(w->'uploads')>100 then raise exception 'invalid';end if;
 select * into g from archivito_inc.gates where archive_id=a for update;
 if g.enabled is distinct from true then raise exception 'disabled';end if;
 perform 1 from public.archive_members where archive_id=a and user_id=p_actor and role in ('owner','editor') for share;
 if not found then raise exception 'not member';end if;
 select key_fingerprint into fp from public.archives where id=a for share;
 if fp is null or fp is distinct from h->>'keyId' then raise exception 'wrong key';end if;
 dg:=encode(sha256(convert_to(w::text,'UTF8')),'hex');
 select * into old from archivito_inc.operations where archive_id=a and operation_id=o;
 if found then
  if old.actor is distinct from p_actor or old.digest is distinct from dg then raise exception 'intent mismatch';end if;
  if old.state='committed' then return jsonb_build_object('state','synced','operationId',o,'revision',r,'replayed',true);end if;
  if old.state<>'staging' then raise exception 'fenced';end if;
 elsif p_action<>'begin' then raise exception 'missing intent';end if;
 select * into cur from archivito_inc.heads where archive_id=a and memory_id=m;
 if coalesce(cur.revision,0)<>br or cur.operation_id is distinct from bo then
  return jsonb_build_object('state','conflict','operationId',o,'actualRevision',coalesce(cur.revision,0),'actualOperationId',cur.operation_id);
 end if;
 if p_action='begin' and old.operation_id is null then
  need:=header_bytes+512;
  for d in select value from jsonb_array_elements(h->'refs') loop
   x:=(d->>'id')::uuid;
   if (d->>'born')::bigint=r then
    if exists(select 1 from archivito_inc.assets z where z.archive_id=a and z.asset_id=x) then raise exception 'asset identity used';end if;
    need:=need+(d->>'size')::bigint;
   elsif not exists(select 1 from archivito_inc.refs f join archivito_inc.assets z using(archive_id,memory_id,asset_id)
    join archivito_inc.operations birth on birth.archive_id=z.archive_id and birth.operation_id=z.birth_operation_id
    where f.archive_id=a and f.memory_id=m and f.operation_id=bo and z.asset_id=x and z.state='ready' and birth.state='committed' and birth.key_id=fp
    and z.born=(d->>'born')::bigint and z.ciphertext_bytes=(d->>'size')::bigint and z.nonce=d->>'nonce' and z.cipher_sha256=d->>'cipherSha256') then raise exception 'invalid inherited reference';end if;
  end loop;
  select coalesce((select sum(receipt_bytes) from archivito_inc.operations where archive_id=a),0)
   +coalesce((select sum(charged_bytes) from archivito_inc.manifests where archive_id=a),0)
   +coalesce((select sum(ciphertext_bytes) from archivito_inc.assets where archive_id=a),0) into used;
  if used+need>g.quota_bytes or (select count(*) from archivito_inc.operations where archive_id=a)>=512 or
   (select count(*) from archivito_inc.operations where archive_id=a and state='staging')>=8 then raise exception 'quota';end if;
  insert into archivito_inc.operations(archive_id,operation_id,memory_id,actor,key_id,revision,base_revision,base_operation_id,digest,state,receipt_bytes)
   values(a,o,m,p_actor,fp,r,br,bo,dg,'staging',512);
  insert into archivito_inc.manifests(archive_id,memory_id,operation_id,revision,encrypted_header,charged_bytes) values(a,m,o,r,w,header_bytes);
  for d in select value from jsonb_array_elements(h->'refs') loop
   x:=(d->>'id')::uuid;
   if (d->>'born')::bigint=r then
    insert into archivito_inc.assets values(a,x,m,o,r,(d->>'size')::bigint,d->>'nonce',d->>'cipherSha256','staging');
    select value into strict up from jsonb_array_elements(w->'uploads') where value->>'id'=x::text;
    insert into archivito_inc.blocks(archive_id,memory_id,asset_id,block_index,path,bytes,sha256)
     select a,m,x,(c->>'index')::integer,c->>'path',(c->>'size')::integer,c->>'sha256' from jsonb_array_elements(up->'chunks') c;
   end if;
   insert into archivito_inc.refs values(a,m,o,x);
  end loop;
 end if;
 update archivito_inc.operations set last_activity=clock_timestamp() where archive_id=a and operation_id=o;
 if p_action in ('begin','lookup') then
  return jsonb_build_object('state','staging','operationId',o,'verifiedAssets',coalesce((select jsonb_agg(asset_id order by asset_id) from archivito_inc.assets where archive_id=a and birth_operation_id=o and state='ready'),'[]'::jsonb));
 end if;
 if p_action='attest' then
  -- Actual object existence/length, no SQL writes to storage.objects. Hash is
  -- evidence from a trusted whole-asset readback, not a client attestation.
  perform 1 from archivito_inc.assets z where z.archive_id=a and z.birth_operation_id=o and z.asset_id=p_asset and z.cipher_sha256=p_hash and z.state in ('staging','ready')
   and (select coalesce(sum(b.bytes),0) from archivito_inc.blocks b where b.archive_id=a and b.asset_id=p_asset)=z.ciphertext_bytes
   and not exists(select 1 from archivito_inc.blocks b where b.archive_id=a and b.asset_id=p_asset and not exists(
    select 1 from storage.objects s where s.bucket_id='archivito-inc-private' and s.name=b.path and (s.metadata->>'size')::bigint=b.bytes));
  if not found then raise exception 'bad attestation or missing object';end if;
  update archivito_inc.blocks set verified=true where archive_id=a and asset_id=p_asset;
  update archivito_inc.assets set state='ready' where archive_id=a and asset_id=p_asset;
  return jsonb_build_object('state','verified','operationId',o,'assetId',p_asset);
 end if;
 if exists(select 1 from archivito_inc.refs f join archivito_inc.assets z using(archive_id,memory_id,asset_id) where f.archive_id=a and f.operation_id=o and z.state<>'ready')
 or exists(select 1 from archivito_inc.assets z join archivito_inc.blocks b using(archive_id,memory_id,asset_id) where z.archive_id=a and z.birth_operation_id=o and
 (not b.verified or not exists(select 1 from storage.objects s where s.bucket_id='archivito-inc-private' and s.name=b.path and (s.metadata->>'size')::bigint=b.bytes)))
 then raise exception 'incomplete';end if;
 update archivito_inc.operations set state='committed' where archive_id=a and operation_id=o;
 update archivito_inc.manifests set committed_at=clock_timestamp() where archive_id=a and operation_id=o;
 insert into archivito_inc.heads values(a,m,o,r) on conflict(archive_id,memory_id) do update set operation_id=excluded.operation_id,revision=excluded.revision;
 return jsonb_build_object('state','synced','operationId',o,'revision',r,'replayed',false);
end $$;
revoke all on function public.sync_inc_step(uuid,text,jsonb,uuid,text) from public,anon,authenticated;
grant execute on function public.sync_inc_step(uuid,text,jsonb,uuid,text) to service_role;
