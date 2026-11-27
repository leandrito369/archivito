-- Only run inside transaction with candidate schema and RPC. Do not persist gate.
do $$
declare a uuid;u uuid;v uuid;k text;m uuid:='20000000-0000-4000-8000-000000000001';o1 uuid:='20000000-0000-4000-8000-000000000002';o2 uuid:='20000000-0000-4000-8000-000000000003';o3 uuid:='20000000-0000-4000-8000-000000000004';x uuid:='20000000-0000-4000-8000-000000000005';s text:=repeat('b',64);d jsonb;w1 jsonb;w2 jsonb;w3 jsonb;res jsonb;p text;n bigint;
begin
 select id,key_fingerprint into strict a,k from public.archives;
 select user_id into strict u from public.archive_members where archive_id=a and role='owner';
 select user_id into strict v from public.archive_members where archive_id=a and role='editor';
 p:=a::text||'/'||m::text||'/'||x::text||'/0';
 d:=jsonb_build_object('id',x,'born',1,'size',32,'nonce','AAAAAAAAAAAAAAAA','cipherSha256',s);
 w1:=jsonb_build_object('format','archivito-incremental-wire-v1','base',null,'header',jsonb_build_object('archiveId',a,'memoryId',m,'operationId',o1,'keyId',k,'revision',1,'refs',jsonb_build_array(d),'metadata','synthetic'),'uploads',jsonb_build_array(jsonb_build_object('id',x,'chunks',jsonb_build_array(jsonb_build_object('index',0,'path',p,'size',32,'sha256',s)))));
 w2:=jsonb_set(jsonb_set(jsonb_set(jsonb_set(w1,'{header,operationId}',to_jsonb(o2)),'{header,revision}','2'),'{base}',jsonb_build_object('revision',1,'operationId',o1)),'{uploads}','[]');
 w3:=jsonb_set(w2,'{header,operationId}',to_jsonb(o3));
 perform set_config('role','service_role',true);
 begin perform public.sync_inc_step(u,'begin',w1);raise exception 'gate bypass';exception when others then if sqlerrm<>'disabled' then raise;end if;end;
 perform set_config('role','none',true);
 alter table archivito_inc.gates drop constraint inc_gate_hard_closed;
 update archivito_inc.gates set enabled=true;
 perform set_config('role','service_role',true);
 begin perform public.sync_inc_step('20000000-0000-4000-8000-000000000009','begin',w1);raise exception 'outsider bypass';exception when others then if sqlerrm<>'not member' then raise;end if;end;
 perform public.sync_inc_step(u,'begin',w1);
 perform public.sync_inc_step(u,'begin',w1);
 if (select count(*) from archivito_inc.operations)<>1 or (select count(*) from archivito_inc.assets)<>1 then raise exception 'duplicate';end if;
 begin perform public.sync_inc_step(u,'attest',w1,x,s);raise exception 'missing object accepted';exception when others then if sqlerrm<>'bad attestation or missing object' then raise;end if;end;
 begin perform public.sync_inc_step(u,'commit',w1);raise exception 'incomplete accepted';exception when others then if sqlerrm<>'incomplete' then raise;end if;end;
 begin perform public.sync_inc_step(v,'lookup',w1);raise exception 'actor bypass';exception when others then if sqlerrm<>'intent mismatch' then raise;end if;end;
 -- Seed a synthetic previous confirmed revision under administrator role only.
 -- NOT evidence of an actual Storage transfer or attestation.
 perform set_config('role','none',true);
 update archivito_inc.assets set state='ready';
 update archivito_inc.blocks set verified=true;
 update archivito_inc.operations set state='committed';
 update archivito_inc.manifests set committed_at=now();
 insert into archivito_inc.heads values(a,m,o1,1);
 perform set_config('role','service_role',true);
 begin perform public.sync_inc_step(v,'begin',jsonb_set(w2,'{header,refs,0,nonce}','"BBBBBBBBBBBBBBBB"'));raise exception 'bad ref accepted';exception when others then if sqlerrm<>'invalid inherited reference' then raise;end if;end;
 perform public.sync_inc_step(v,'begin',w2);
 perform public.sync_inc_step(u,'begin',w3);
 res:=public.sync_inc_step(v,'commit',w2);
 if res->>'state'<>'synced' then raise exception 'metadata commit failed';end if;
 res:=public.sync_inc_step(u,'commit',w3);
 if res->>'state'<>'conflict' then raise exception 'CAS failed';end if;
 res:=public.sync_inc_step(u,'begin',w1);
 if res->>'replayed'<>'true' then raise exception 'receipt failed';end if;
 if (select count(*) from archivito_inc.assets)<>1 or (select count(*) from archivito_inc.blocks)<>1 or (select count(*) from archivito_inc.operations where state='committed')<>2 then raise exception 'unexpected counts';end if;
 if (select charged_bytes from archivito_inc.manifests where operation_id=o2)<>octet_length(w2::text) then raise exception 'bad charge';end if;
 perform set_config('role','none',true);
 if has_function_privilege('authenticated','public.sync_inc_step(uuid,text,jsonb,uuid,text)','EXECUTE') or has_function_privilege('anon','public.sync_inc_step(uuid,text,jsonb,uuid,text)','EXECUTE') or has_schema_privilege('authenticated','archivito_inc','USAGE') then raise exception 'client grants';end if;
end $$;