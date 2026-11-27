-- Closed incremental storage and service-only catalogue. No direct client policies.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('archivito-inc-private','archivito-inc-private',false,4194304,array['application/octet-stream']);
create function public.sync_inc_inspect(p_actor uuid,p_archive uuid,p_action text,p_memory uuid default null,p_operation uuid default null,p_asset uuid default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare fp text; op uuid; m uuid; result jsonb; g boolean;
begin
 if p_actor is null or p_archive is null or p_action is null or p_action not in ('intent','head','revision','catalog') then raise exception 'invalid';end if;
 select enabled into g from archivito_inc.gates where archive_id=p_archive for share;
 if g is distinct from true then raise exception 'disabled';end if;
 perform 1 from public.archive_members where archive_id=p_archive and user_id=p_actor and role in ('owner','editor') for share;
 if not found then raise exception 'not member';end if;
 select key_fingerprint into fp from public.archives where id=p_archive for share;
 if fp is null then raise exception 'wrong key';end if;
 if p_action='intent' then
  if p_operation is null or p_memory is not null or p_asset is not null then raise exception 'invalid';end if;
  select f.encrypted_header into result from archivito_inc.operations o join archivito_inc.manifests f using(archive_id,memory_id,operation_id,revision)
   where o.archive_id=p_archive and o.operation_id=p_operation and o.actor=p_actor and o.key_id=fp and o.state in ('staging','committed');
  if result is null then raise exception 'not found';end if;
  return result;
 end if;
 if p_memory is null then raise exception 'invalid';end if;
 if p_action='head' then
  if p_operation is not null or p_asset is not null then raise exception 'invalid';end if;
  select operation_id into op from archivito_inc.heads where archive_id=p_archive and memory_id=p_memory;
  if op is null then return null;end if;
 else
  if p_operation is null then raise exception 'invalid';end if;
  op:=p_operation;
 end if;
 perform 1 from archivito_inc.operations o join archivito_inc.manifests f using(archive_id,memory_id,operation_id,revision)
 where o.archive_id=p_archive and o.memory_id=p_memory and o.operation_id=op and o.state='committed' and o.key_id=fp;
 if not found then raise exception 'not found';end if;
 if p_action in ('head','revision') then
  if p_asset is not null then raise exception 'invalid';end if;
  select encrypted_header into result from archivito_inc.manifests where archive_id=p_archive and memory_id=p_memory and operation_id=op;
  return result;
 end if;
 if p_asset is null then raise exception 'invalid';end if;
 select jsonb_build_object('archiveId',p_archive,'memoryId',p_memory,'operationId',op,'keyId',fp,
 'ref',jsonb_build_object('id',z.asset_id,'born',z.born,'size',z.ciphertext_bytes,'nonce',z.nonce,'cipherSha256',z.cipher_sha256),
 'chunks',(select jsonb_agg(jsonb_build_object('index',b.block_index,'path',b.path,'size',b.bytes,'sha256',b.sha256) order by b.block_index)
  from archivito_inc.blocks b where b.archive_id=z.archive_id and b.asset_id=z.asset_id and b.verified))
 into result from archivito_inc.refs f join archivito_inc.assets z using(archive_id,memory_id,asset_id)
 join archivito_inc.operations birth on birth.archive_id=z.archive_id and birth.operation_id=z.birth_operation_id
 where f.archive_id=p_archive and f.memory_id=p_memory and f.operation_id=op and z.asset_id=p_asset and z.state='ready' and birth.state='committed' and birth.key_id=fp;
 if result is null then raise exception 'not found';end if;
 return result;
end $$;
revoke all on function public.sync_inc_inspect(uuid,uuid,text,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.sync_inc_inspect(uuid,uuid,text,uuid,uuid,uuid) to service_role;
