do $$
declare a uuid;u uuid;v uuid;k text;m uuid:='30000000-0000-4000-8000-000000000001';o1 uuid:='30000000-0000-4000-8000-000000000002';o2 uuid:='30000000-0000-4000-8000-000000000003';x uuid:='30000000-0000-4000-8000-000000000004';d text:=repeat('b',64);r jsonb;
begin
 select id,key_fingerprint into strict a,k from public.archives;
 select user_id into strict u from public.archive_members where archive_id=a and role='owner';
 select user_id into strict v from public.archive_members where archive_id=a and role='editor';
 perform set_config('role','service_role',true);
 begin perform public.sync_inc_inspect(u,a,'head',m);raise exception 'gate bypass';exception when others then if sqlerrm<>'disabled' then raise;end if;end;
 perform set_config('role','none',true);
 alter table archivito_inc.gates drop constraint inc_gate_hard_closed;
 update archivito_inc.gates set enabled=true where archive_id=a;
 insert into archivito_inc.operations(archive_id,operation_id,memory_id,actor,key_id,revision,base_revision,base_operation_id,digest,state,receipt_bytes)
 values(a,o1,m,u,k,1,0,null,d,'committed',512),(a,o2,m,v,k,2,1,o1,d,'committed',512);
 -- Birth operation intentionally retained without its manifest (structural test, not policy authorization).
 insert into archivito_inc.manifests(archive_id,memory_id,operation_id,revision,encrypted_header,charged_bytes,committed_at) values(a,m,o2,2,'{"synthetic":true}',100,now());
 insert into archivito_inc.assets values(a,x,m,o1,1,32,'AAAAAAAAAAAAAAAA',d,'ready');
 insert into archivito_inc.blocks values(a,m,x,0,a::text||'/'||m::text||'/'||x::text||'/0',32,d,true);
 insert into archivito_inc.refs values(a,m,o2,x);
 insert into archivito_inc.heads values(a,m,o2,2);
 perform set_config('role','service_role',true);
 r:=public.sync_inc_inspect(u,a,'head',m);
 if r->>'synthetic'<>'true' then raise exception 'head';end if;
 r:=public.sync_inc_inspect(u,a,'catalog',m,o2,x);
 if r->'ref'->>'id'<>x::text or jsonb_array_length(r->'chunks')<>1 then raise exception 'catalog';end if;
 begin perform public.sync_inc_inspect(u,a,'intent',null,o2);raise exception 'other actor intent';exception when others then if sqlerrm<>'not found' then raise;end if;end;
 begin perform public.sync_inc_inspect('30000000-0000-4000-8000-000000000009',a,'catalog',m,o2,x);raise exception 'outsider';exception when others then if sqlerrm<>'not member' then raise;end if;end;
 begin perform public.sync_inc_inspect(u,a,'catalog',m,o1,x);raise exception 'pruned revision accessible';exception when others then if sqlerrm<>'not found' then raise;end if;end;
 perform set_config('role','none',true);
 if has_function_privilege('authenticated','public.sync_inc_inspect(uuid,uuid,text,uuid,uuid,uuid)','EXECUTE') or has_function_privilege('anon','public.sync_inc_inspect(uuid,uuid,text,uuid,uuid,uuid)','EXECUTE') then raise exception 'rpc leak';end if;
end $$;