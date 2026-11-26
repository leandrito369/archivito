-- CANDIDATE: psql only. Default ROLLBACK; apply requires separate operator
-- authorization and -v apply_closed_fixture=true. No Auth user creation here.
\set ON_ERROR_STOP on
\if :{?apply_closed_fixture}
\else
\set apply_closed_fixture false
\endif
begin;
set local lock_timeout='5s';
set local statement_timeout='15s';
-- Short exclusive administrative window: serialize archive/member/gate provisioning.
lock table public.archives,public.archive_members,archivito_inc.gates in share row exclusive mode;
do $fixture$
declare
  ar constant uuid:='73ac551b-2df8-4da7-91b8-4adf18d83900';
  a uuid;b uuid;c uuid;
begin
  if not exists(select 1 from pg_constraint where conrelid='archivito_inc.gates'::regclass
      and conname='inc_gate_hard_closed' and convalidated and pg_get_constraintdef(oid)='CHECK ((NOT enabled))')
      or exists(select 1 from archivito_inc.gates where enabled)
  then raise exception 'STOP: hard-closed gate not confirmed';end if;
  if (select count(*) from auth.users where lower(email) in
      ('archivito-cert-a@example.com','archivito-cert-b@example.com','archivito-cert-c@example.com'))<>3
  then raise exception 'STOP: three confirmed fixture accounts required';end if;
  select id into a from auth.users where lower(email)='archivito-cert-a@example.com' and email_confirmed_at is not null and deleted_at is null for share;
  select id into b from auth.users where lower(email)='archivito-cert-b@example.com' and email_confirmed_at is not null and deleted_at is null for share;
  select id into c from auth.users where lower(email)='archivito-cert-c@example.com' and email_confirmed_at is not null and deleted_at is null for share;
  if a is null or b is null or c is null or a=b or a=c or b=c then raise exception 'STOP: three confirmed fixture accounts required';end if;
  if exists(select 1 from public.archive_members where user_id in(a,b,c) and
       (archive_id<>ar or user_id=c))
  then raise exception 'STOP: fixture account has out-of-scope membership';end if;
  if exists(select 1 from archivito_inc.operations where archive_id=ar)
     or exists(select 1 from archivito_inc.heads where archive_id=ar)
     or exists(select 1 from storage.objects where bucket_id='archivito-inc-private' and name like ar::text||'/%')
  then raise exception 'STOP: fixture not empty';end if;
  if exists(select 1 from public.archives where id=ar) then
    -- Never overwrite an existing archive, roles, key or quota.
    if not exists(select 1 from public.archives where id=ar and schema_version=1 and key_fingerprint is null)
       or (select count(*) from public.archive_members where archive_id=ar)<>2
       or not exists(select 1 from public.archive_members where archive_id=ar and user_id=a and role='owner')
       or not exists(select 1 from public.archive_members where archive_id=ar and user_id=b and role='editor')
       or not exists(select 1 from archivito_inc.gates where archive_id=ar and not enabled and quota_bytes=67108864)
    then raise exception 'STOP: reserved archive collision or drift';end if;
  else
    insert into public.archives(id,schema_version,key_fingerprint) values(ar,1,null);
    insert into public.archive_members(archive_id,user_id,role) values(ar,a,'owner'),(ar,b,'editor');
    insert into archivito_inc.gates(archive_id,enabled,quota_bytes) values(ar,false,67108864);
  end if;
  if exists(select 1 from archivito_inc.gates where enabled) then raise exception 'STOP: open gate';end if;
end $fixture$;
select 'PASS: dedicated closed fixture staged; A/B members, C outsider; no key or content' as outcome;
\if :apply_closed_fixture
commit;
\echo CLOSED FIXTURE COMMITTED (no gate opening)
\else
rollback;
\echo DRY RUN ROLLED BACK
\endif
