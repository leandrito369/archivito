-- Run candidate DDL then this test inside one BEGIN/ROLLBACK.
-- Execute only after candidate DDL in same transaction, then ROLLBACK.
do $$
declare a uuid;u uuid; m uuid:='10000000-0000-4000-8000-000000000001';m2 uuid:='10000000-0000-4000-8000-000000000002';
 o1 uuid:='10000000-0000-4000-8000-000000000003';o2 uuid:='10000000-0000-4000-8000-000000000004';o3 uuid:='10000000-0000-4000-8000-000000000005';
 asset uuid:='10000000-0000-4000-8000-000000000006';hold uuid:='10000000-0000-4000-8000-000000000007';k text:=repeat('a',64);d text:=repeat('b',64);
begin
 select id into strict a from public.archives;
 select user_id into strict u from public.archive_members where archive_id=a and role='owner';
 insert into archivito_inc.gates(archive_id) values(a);
 begin update archivito_inc.gates set enabled=true;raise exception 'gate opened';exception when check_violation then null;end;
 insert into archivito_inc.operations(archive_id,operation_id,memory_id,actor,key_id,revision,base_revision,base_operation_id,digest,state,receipt_bytes)
 values(a,o1,m,u,k,1,0,null,d,'committed',100),(a,o2,m,u,k,2,1,o1,d,'committed',100),(a,o3,m2,u,k,1,0,null,d,'staging',100);
 insert into archivito_inc.manifests(archive_id,memory_id,operation_id,revision,encrypted_header,charged_bytes) values(a,m,o1,1,'{}',100),(a,m,o2,2,'{}',100),(a,m2,o3,1,'{}',100);
 insert into archivito_inc.assets values(a,asset,m,o1,1,32,'AAAAAAAAAAAAAAAA',d,'ready');
 insert into archivito_inc.blocks values(a,m,asset,0,a::text||'/'||m::text||'/'||asset::text||'/0',32,d,true);
 insert into archivito_inc.refs values(a,m,o1,asset),(a,m,o2,asset);
 insert into archivito_inc.heads values(a,m,o2,2);
 insert into archivito_inc.holds values(a,m,o1,hold,'restore');
 begin insert into archivito_inc.refs values(a,m2,o3,asset);raise exception 'cross-memory accepted';exception when foreign_key_violation then null;end;
 begin insert into archivito_inc.blocks values(a,m,asset,1,'wrong/path',1,d,false);raise exception 'bad path accepted';exception when check_violation then null;end;
 begin delete from archivito_inc.assets where asset_id=asset;raise exception 'referenced asset deleted';exception when foreign_key_violation then null;end;
 begin delete from archivito_inc.manifests where operation_id=o2;raise exception 'head deleted';exception when foreign_key_violation then null;end;
 -- Hold independently blocks manifest retirement even if its refs were removed.
 begin delete from archivito_inc.refs where operation_id=o1;delete from archivito_inc.manifests where operation_id=o1;raise exception 'hold bypass';exception when foreign_key_violation then null;end;
 -- Structural rehearsal ONLY: policy forbids pruning r1 in real use.
 -- Proves the independent descriptor survives a manifest retirement.
 delete from archivito_inc.holds where hold_id=hold;
 delete from archivito_inc.refs where operation_id=o1;
 delete from archivito_inc.manifests where operation_id=o1;
 if (select count(*) from archivito_inc.assets where asset_id=asset)<>1 or (select count(*) from archivito_inc.operations where operation_id=o1)<>1 or (select count(*) from archivito_inc.refs where operation_id=o2)<>1 then raise exception 'catalog or receipt lost';end if;
 if has_schema_privilege('authenticated','archivito_inc','USAGE') or has_schema_privilege('anon','archivito_inc','USAGE') or has_schema_privilege('service_role','archivito_inc','USAGE') then raise exception 'schema accessible';end if;
 if (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='archivito_inc' and c.relkind='r' and c.relrowsecurity)<>8 then raise exception 'RLS missing';end if;
end $$;