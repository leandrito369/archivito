begin;
-- CLOUD-03.2A: private, disposable SQL rehearsal ONLY. Not a production migration.
create schema archivito_sync_lab;
revoke all on schema archivito_sync_lab from public, anon, authenticated;
create table archivito_sync_lab.archives (
 id uuid primary key, key_id text not null check(key_id ~ '^[a-f0-9]{64}$')
);
create table archivito_sync_lab.staged (
 archive_id uuid not null references archivito_sync_lab.archives(id),
 operation_id uuid not null, asset_id uuid not null, revision bigint not null check(revision>0),
 nonce bytea not null check(octet_length(nonce)=12),
 ciphertext bytea not null check(octet_length(ciphertext) between 17 and 8388624),
 primary key(archive_id,operation_id,asset_id)
);
create table archivito_sync_lab.revisions (
 archive_id uuid not null references archivito_sync_lab.archives(id),
 memory_id uuid not null, revision bigint not null check(revision>0), operation_id uuid not null,
 metadata_nonce bytea not null check(octet_length(metadata_nonce)=12),
 metadata_ciphertext bytea not null check(octet_length(metadata_ciphertext) between 16 and 65552),
 asset_ids uuid[] not null check(cardinality(asset_ids) between 1 and 8),
 primary key(archive_id,memory_id,revision), unique(archive_id,operation_id)
);
alter table archivito_sync_lab.archives enable row level security;
alter table archivito_sync_lab.staged enable row level security;
alter table archivito_sync_lab.revisions enable row level security;
revoke all on all tables in schema archivito_sync_lab from public, anon, authenticated;
-- Admin-only rehearsal; archive lock serializes publishers and staging must be immutable
-- during publication. Real storage and writer authorization are deliberately absent.
create function archivito_sync_lab.publish(
 p_archive uuid,p_memory uuid,p_operation uuid,p_expected bigint,p_key text,
 p_nonce bytea,p_ciphertext bytea,p_assets uuid[]
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 v_key text; v_actual bigint; v_receipt archivito_sync_lab.revisions%rowtype;
 v_count bigint; v_bytes bigint; v_ids uuid[]; v_expected_ids uuid[];
begin
 if p_archive is null or p_memory is null or p_operation is null or p_expected is null
 or p_expected<0 or p_expected>=9007199254740991 or p_key is null
 or p_nonce is null or octet_length(p_nonce)<>12 or p_ciphertext is null
 or octet_length(p_ciphertext) not between 16 and 65552
 or p_assets is null or cardinality(p_assets) not between 1 and 8
 or array_ndims(p_assets)<>1 or array_position(p_assets,null) is not null
 or p_memory=any(p_assets) then raise exception 'invalid publication'; end if;
 select array_agg(distinct a order by a) into v_expected_ids from unnest(p_assets) a;
 if cardinality(v_expected_ids)<>cardinality(p_assets) then raise exception 'duplicate asset'; end if;
 select key_id into v_key from archivito_sync_lab.archives where id=p_archive for update;
 if not found or v_key is distinct from p_key then raise exception 'archive/key mismatch'; end if;
 select * into v_receipt from archivito_sync_lab.revisions where archive_id=p_archive and operation_id=p_operation;
 if found then
  if v_receipt.memory_id is distinct from p_memory or v_receipt.revision<>p_expected+1
  or v_receipt.metadata_nonce is distinct from p_nonce or v_receipt.metadata_ciphertext is distinct from p_ciphertext
  or v_receipt.asset_ids is distinct from v_expected_ids then raise exception 'operation reuse'; end if;
  return jsonb_build_object('state','synced','revision',v_receipt.revision,'replayed',true);
 end if;
 select coalesce(max(revision),0) into v_actual from archivito_sync_lab.revisions where archive_id=p_archive and memory_id=p_memory;
 if v_actual<>p_expected then return jsonb_build_object('state','conflict','actualRevision',v_actual); end if;
 select count(*),coalesce(sum(octet_length(ciphertext)-16),0),array_agg(asset_id order by asset_id)
 into v_count,v_bytes,v_ids from archivito_sync_lab.staged where archive_id=p_archive and operation_id=p_operation;
 if v_count<>cardinality(p_assets) or v_ids is distinct from v_expected_ids or v_bytes>8388608
 or exists(select 1 from archivito_sync_lab.staged where archive_id=p_archive and operation_id=p_operation and revision<>p_expected+1)
 then raise exception 'incomplete or incompatible staging'; end if;
 insert into archivito_sync_lab.revisions values(p_archive,p_memory,p_expected+1,p_operation,p_nonce,p_ciphertext,v_expected_ids);
 return jsonb_build_object('state','synced','revision',p_expected+1,'replayed',false);
end $$;
revoke all on all functions in schema archivito_sync_lab from public, anon, authenticated;

-- Synthetic bytes, never actual memories or keys.
do $$
declare
 a uuid:='10000000-0000-4000-8000-000000000001'; m uuid:='10000000-0000-4000-8000-000000000002';
 op1 uuid:='10000000-0000-4000-8000-000000000003'; op2 uuid:='10000000-0000-4000-8000-000000000004';
 op3 uuid:='10000000-0000-4000-8000-000000000005'; f uuid:='10000000-0000-4000-8000-000000000006';
 b uuid:='10000000-0000-4000-8000-000000000007';
 k text:=repeat('a',64); n bytea:=decode(repeat('00',12),'hex'); c bytea:=decode(repeat('ab',17),'hex');
 r jsonb; rejected boolean;
begin
 insert into archivito_sync_lab.archives values(a,k);
 insert into archivito_sync_lab.staged values(a,op1,f,1,n,c);
 rejected:=false;
 begin perform archivito_sync_lab.publish(a,m,op1,0,k,n,c,array[f,b]); exception when others then
  if sqlerrm<>'incomplete or incompatible staging' then raise; end if; rejected:=true; end;
 if not rejected or exists(select 1 from archivito_sync_lab.revisions) then raise exception 'partial commit'; end if;
 insert into archivito_sync_lab.staged values(a,op1,b,1,n,c);
 r:=archivito_sync_lab.publish(a,m,op1,0,k,n,c,array[f,b]);
 if r is distinct from '{"state":"synced","revision":1,"replayed":false}'::jsonb then raise exception 'publish failed'; end if;
 r:=archivito_sync_lab.publish(a,m,op1,0,k,n,c,array[b,f]);
 if r is distinct from '{"state":"synced","revision":1,"replayed":true}'::jsonb then raise exception 'retry failed'; end if;
 rejected:=false;
 begin perform archivito_sync_lab.publish(a,m,op1,0,k,n,c||c,array[f,b]); exception when others then
 if sqlerrm<>'operation reuse' then raise; end if; rejected:=true; end;
 if not rejected then raise exception 'operation reuse accepted'; end if;
 insert into archivito_sync_lab.staged values(a,op2,f,2,n,c),(a,op2,b,2,n,c),(a,op3,f,2,n,c),(a,op3,b,2,n,c);
 r:=archivito_sync_lab.publish(a,m,op2,1,k,n,c,array[f,b]);
 if r is distinct from '{"state":"synced","revision":2,"replayed":false}'::jsonb then raise exception 'revision 2 failed'; end if;
 r:=archivito_sync_lab.publish(a,m,op3,1,k,n,c,array[f,b]);
 if r is distinct from '{"state":"conflict","actualRevision":2}'::jsonb then raise exception 'conflict failed'; end if;
 if (select count(*) from archivito_sync_lab.revisions)<>2 then raise exception 'unexpected revisions'; end if;
 rejected:=false;
 begin perform archivito_sync_lab.publish(a,m,op3,2,repeat('b',64),n,c,array[f,b]); exception when others then
 if sqlerrm<>'archive/key mismatch' then raise; end if; rejected:=true; end;
 if not rejected then raise exception 'wrong key accepted'; end if;
 if has_schema_privilege('authenticated','archivito_sync_lab','USAGE') or has_schema_privilege('anon','archivito_sync_lab','USAGE')
 or has_table_privilege('authenticated','archivito_sync_lab.revisions','INSERT')
 or has_function_privilege('authenticated','archivito_sync_lab.publish(uuid,uuid,uuid,bigint,text,bytea,bytea,uuid[])','EXECUTE')
 or has_function_privilege('anon','archivito_sync_lab.publish(uuid,uuid,uuid,bigint,text,bytea,bytea,uuid[])','EXECUTE') then raise exception 'lab exposed'; end if;
end $$;

rollback;
select 'PASS: atomic staging, revision, replay, conflict, wrong key, permissions; rolled back' as result;
