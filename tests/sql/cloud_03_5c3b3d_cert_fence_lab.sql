-- Disposable PostgreSQL only; no live data or credentials.
\set ON_ERROR_STOP on
begin;
\ir ../../docs/sql/cloud_03_5c3b3d_cert_fence_candidate.sql

do $$
declare
  win uuid:=gen_random_uuid(); arch uuid:=gen_random_uuid(); a uuid:=gen_random_uuid();
  b uuid:=gen_random_uuid(); c uuid:=gen_random_uuid(); op uuid:=gen_random_uuid();
  other uuid:=gen_random_uuid(); m uuid:='73ac551b-2df8-4da7-91b8-4adf18d83901';
  k text:=repeat('a',64); d text:=repeat('b',64); t timestamptz:=clock_timestamp();
  f archivito_inc_cert_candidate.fences%rowtype; f2 archivito_inc_cert_candidate.fences%rowtype;
begin
  insert into archivito_inc_cert_candidate.windows
  values(win,arch,a,b,k,t,t+interval '10 minutes',false,100,2);

  begin perform archivito_inc_cert_candidate.claim(win,arch,a,k,m,op,1,d,60);
    raise exception 'FAIL: closed window accepted'; exception when insufficient_privilege then null;end;
  update archivito_inc_cert_candidate.windows set enabled=true where id=win;
  begin perform archivito_inc_cert_candidate.claim(win,arch,c,k,m,op,1,d,60);
    raise exception 'FAIL: outsider accepted'; exception when insufficient_privilege then null;end;
  begin perform archivito_inc_cert_candidate.claim(win,arch,a,k,gen_random_uuid(),op,1,d,60);
    raise exception 'FAIL: arbitrary memory accepted'; exception when insufficient_privilege then null;end;
  begin perform archivito_inc_cert_candidate.claim(win,gen_random_uuid(),a,k,m,op,1,d,60);
    raise exception 'FAIL: wrong archive accepted'; exception when insufficient_privilege then null;end;
  begin perform archivito_inc_cert_candidate.claim(win,arch,a,repeat('c',64),m,op,1,d,60);
    raise exception 'FAIL: wrong key accepted'; exception when insufficient_privilege then null;end;
  begin perform archivito_inc_cert_candidate.claim(win,arch,b,k,m,op,1,d,60);
    raise exception 'FAIL: editor created initial revision'; exception when insufficient_privilege then null;end;
  f:=archivito_inc_cert_candidate.claim(win,arch,a,k,m,op,1,d,60);
  if f.generation<>1 or f.lease_until>t+interval '10 minutes' then raise exception 'FAIL: initial fence';end if;
  perform archivito_inc_cert_candidate.assert_fence(win,arch,a,k,m,op,f.generation,f.token,d,true);
  begin perform archivito_inc_cert_candidate.claim(win,arch,a,k,m,op,1,d,60);
    raise exception 'FAIL: live takeover'; exception when insufficient_privilege then null;end;
  begin perform archivito_inc_cert_candidate.claim(win,arch,a,k,m,other,2,d,41);
    raise exception 'FAIL: bytes quota'; exception when insufficient_privilege then null;end;
  update archivito_inc_cert_candidate.fences set lease_until=clock_timestamp()-interval '1 second' where operation_id=op;
  begin perform archivito_inc_cert_candidate.assert_fence(win,arch,a,k,m,op,f.generation,f.token,d);
    raise exception 'FAIL: expired fence'; exception when insufficient_privilege then null;end;
  begin perform archivito_inc_cert_candidate.claim(win,arch,a,k,m,op,1,repeat('c',64),60);
    raise exception 'FAIL: changed digest'; exception when insufficient_privilege then null;end;
  f2:=archivito_inc_cert_candidate.claim(win,arch,a,k,m,op,1,d,60);
  if f2.generation<>2 or f2.token=f.token then raise exception 'FAIL: takeover';end if;
  begin perform archivito_inc_cert_candidate.assert_fence(win,arch,a,k,m,op,f.generation,f.token,d);
    raise exception 'FAIL: stale fence'; exception when insufficient_privilege then null;end;
  perform archivito_inc_cert_candidate.assert_fence(win,arch,a,k,m,op,f2.generation,f2.token,d);
  perform archivito_inc_cert_candidate.claim(win,arch,b,k,m,other,2,d,40);
  begin perform archivito_inc_cert_candidate.claim(win,arch,b,k,m,gen_random_uuid(),3,d,1);
    raise exception 'FAIL: operation quota'; exception when insufficient_privilege then null;end;
  update archivito_inc_cert_candidate.windows set enabled=false where id=win;
  begin perform archivito_inc_cert_candidate.assert_fence(win,arch,a,k,m,op,f2.generation,f2.token,d);
    raise exception 'FAIL: close accepted'; exception when insufficient_privilege then null;end;
  update archivito_inc_cert_candidate.windows set enabled=true,opened_at=t-interval '11 minutes',expires_at=t-interval '1 minute' where id=win;
  begin perform archivito_inc_cert_candidate.assert_fence(win,arch,a,k,m,op,f2.generation,f2.token,d);
    raise exception 'FAIL: expired window'; exception when insufficient_privilege then null;end;
  raise notice 'PASS: closed/expired window, scope, quota, lease, takeover and stale fence';
end $$;
rollback;
