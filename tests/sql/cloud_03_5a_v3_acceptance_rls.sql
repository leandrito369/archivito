-- Reusable certification against the three accepted synthetic revisions.
-- Gate is toggled only inside a rolled-back transaction; no external session sees it.
begin;
do $$
declare a uuid;u uuid;v uuid; outsider uuid:='10000000-0000-4000-8000-000000000009'; who uuid; n int;
begin
 select archive_id into strict a from public.sync_v3_gate;
 select user_id into strict u from public.archive_members where archive_id=a and role='owner';
 select user_id into strict v from public.archive_members where archive_id=a and role='editor';
 if (select count(*) from public.sync_v3_intents where committed)<>3 or (select count(*) from public.sync_v3_blocks where verified)<>18 or (select count(*) from storage.objects where bucket_id='archivito-v3-private')<>18 then raise exception 'acceptance baseline changed';end if;
 if exists(select 1 from public.sync_v3_gate where enabled) then raise exception 'gate must be closed';end if;
 if has_function_privilege('authenticated','public.sync_v3_step(uuid,text,jsonb,text,bigint,text)','EXECUTE') or has_function_privilege('anon','public.sync_v3_step(uuid,text,jsonb,text,bigint,text)','EXECUTE') or has_table_privilege('authenticated','public.sync_v3_intents','INSERT') or has_column_privilege('authenticated','public.sync_v3_gate','enabled','UPDATE') then raise exception 'unexpected privileges';end if;
 update public.sync_v3_gate set enabled=true where archive_id=a;
 perform set_config('role','authenticated',true);
 foreach who in array array[u,v,outsider] loop
  perform set_config('request.jwt.claim.sub',who::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',who,'role','authenticated')::text,true);
  n:=case when who=outsider then 0 else 3 end;
  if (select count(*) from public.sync_v3_intents where committed)<>n then raise exception 'unexpected revision visibility';end if;
  if (select count(*) from public.sync_v3_blocks where verified)<>n*6 then raise exception 'unexpected block visibility';end if;
  if (select count(*) from storage.objects where bucket_id='archivito-v3-private')<>n*6 then raise exception 'unexpected storage visibility';end if;
 end loop;
 perform set_config('role','none',true);
 update public.sync_v3_gate set enabled=false where archive_id=a;
 perform set_config('role','authenticated',true);
 foreach who in array array[u,v] loop
  perform set_config('request.jwt.claim.sub',who::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',who,'role','authenticated')::text,true);
  if exists(select 1 from public.sync_v3_intents) or exists(select 1 from public.sync_v3_blocks) or exists(select 1 from storage.objects where bucket_id='archivito-v3-private') then raise exception 'gate leak';end if;
 end loop;
 perform set_config('role','none',true);
end $$;
rollback;
select 'PASS: committed revisions, verified blocks and actual storage rows: owner/editor visible, simulated outsider denied, closed gate denies all; rollback' as result;