-- Disposable integration candidate. NOT a migration; no grant or live gate change.
-- Requires the existing closed RPC and C3B3D candidate installed in a test database.
-- One certification window per archive in this candidate, avoiding competing
-- window namespaces for the same operation. Renewal across windows is not supported.
alter table archivito_inc_cert_candidate.windows add unique(archive_id);

create function archivito_inc_cert_candidate.wire_identity(w jsonb)
returns table(archive_id uuid,memory_id uuid,operation_id uuid,key_id text,revision integer,digest text,reservation bigint)
language plpgsql security invoker set search_path='' as $$
declare h jsonb; fresh bigint;
begin
 h:=w->'header';
 if w->>'format' is distinct from 'archivito-incremental-wire-v1'
 or jsonb_typeof(h->'refs') is distinct from 'array' or jsonb_array_length(h->'refs') not between 1 and 100
 or octet_length(w::text)>600000 then raise exception 'invalid wire';end if;
 archive_id:=(h->>'archiveId')::uuid;memory_id:=(h->>'memoryId')::uuid;
 operation_id:=(h->>'operationId')::uuid;key_id:=h->>'keyId';revision:=(h->>'revision')::integer;
 if archive_id is null or memory_id is null or operation_id is null or key_id is null or revision is null
 or revision not between 1 and 24 then raise exception 'invalid wire';end if;
 if exists(select 1 from jsonb_array_elements(h->'refs') as r
  where (r->>'born')::bigint is null or (r->>'born')::bigint not between 1 and revision
  or (r->>'size')::bigint is null or (r->>'size')::bigint not between 17 and 36700176) then raise exception 'invalid reference';end if;
 select coalesce(sum((r->>'size')::bigint),0) into fresh from jsonb_array_elements(h->'refs') r where (r->>'born')::bigint=revision;
 digest:=encode(sha256(convert_to(w::text,'UTF8')),'hex');
 reservation:=octet_length(w::text)+512+fresh;
 return next;
end $$;

-- Full wire validation and trusted fresh actor/session are still required at the
-- future Edge boundary. Reservation/digest are derived, not accepted from client.
-- Lock order: window -> fence -> existing archive gate -> membership -> archive.
create function archivito_inc_cert_candidate.claim_begin(p_window uuid,p_actor uuid,w jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare i record; f archivito_inc_cert_candidate.fences%rowtype; result jsonb;
begin
 select * into strict i from archivito_inc_cert_candidate.wire_identity(w);
 f:=archivito_inc_cert_candidate.claim(p_window,i.archive_id,p_actor,i.key_id,i.memory_id,i.operation_id,i.revision,i.digest,i.reservation);
 result:=public.sync_inc_step(p_actor,'begin',w);
 perform archivito_inc_cert_candidate.assert_fence(p_window,i.archive_id,p_actor,i.key_id,i.memory_id,i.operation_id,f.generation,f.token,i.digest);
 return jsonb_build_object('generation',f.generation,'token',f.token,'result',result);
end $$;

create function archivito_inc_cert_candidate.fenced_step(
 p_window uuid,p_actor uuid,p_generation bigint,p_token uuid,p_action text,w jsonb,
 p_asset uuid default null,p_hash text default null
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare i record; result jsonb;
begin
 if p_action is null or p_action not in ('begin','lookup','attest','commit') then raise exception 'invalid action';end if;
 select * into strict i from archivito_inc_cert_candidate.wire_identity(w);
 perform archivito_inc_cert_candidate.assert_fence(p_window,i.archive_id,p_actor,i.key_id,i.memory_id,i.operation_id,p_generation,p_token,i.digest,true);
 result:=public.sync_inc_step(p_actor,p_action,w,p_asset,p_hash);
 -- Recheck after core work; any failure rolls back the core mutation as well.
 perform archivito_inc_cert_candidate.assert_fence(p_window,i.archive_id,p_actor,i.key_id,i.memory_id,i.operation_id,p_generation,p_token,i.digest);
 return result;
end $$;
revoke all on all functions in schema archivito_inc_cert_candidate from public;
-- No service_role grants. The legacy core entry point must be made inaccessible
-- to bypass paths before any deployment; this candidate does not do that.
