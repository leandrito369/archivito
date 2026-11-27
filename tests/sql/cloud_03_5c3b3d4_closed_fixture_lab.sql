\set ON_ERROR_STOP on
-- Disposable DB only. Minimal schema matching inspected constraints.
create schema auth;
create schema storage;
create schema archivito_inc;
create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,deleted_at timestamptz);
create table public.archives(id uuid primary key,schema_version integer not null check(schema_version=1),key_fingerprint text);
create table public.archive_members(archive_id uuid references public.archives(id),user_id uuid references auth.users(id),role text check(role in ('owner','editor')),primary key(archive_id,user_id),unique(archive_id,role));
create table archivito_inc.gates(archive_id uuid primary key references public.archives(id),enabled boolean not null constraint inc_gate_hard_closed check(not enabled),quota_bytes bigint not null check(quota_bytes between 1 and 268435456));
create table archivito_inc.operations(archive_id uuid);
create table archivito_inc.heads(archive_id uuid);
create table storage.objects(bucket_id text,name text);
insert into auth.users values
 ('00000000-0000-4000-8000-000000000001','archivito-cert-a@example.com',now(),null),
 ('00000000-0000-4000-8000-000000000002','archivito-cert-b@example.com',now(),null),
 ('00000000-0000-4000-8000-000000000003','archivito-cert-c@example.com',now(),null),
 ('00000000-0000-4000-8000-000000000004','unrelated-fixture@example.com',now(),null);
insert into public.archives values('00000000-0000-4000-8000-000000000005',1,repeat('a',64));
insert into public.archive_members values('00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000004','owner');
insert into archivito_inc.gates values('00000000-0000-4000-8000-000000000005',false,123);
\ir ../../docs/sql/cloud_03_5c3b3d4_closed_fixture_provision.sql
do $$begin
 if (select count(*) from public.archives)<>1 or (select count(*) from archivito_inc.gates)<>1 then raise exception 'dry run persisted';end if;
end$$;
\set apply_closed_fixture true
\ir ../../docs/sql/cloud_03_5c3b3d4_closed_fixture_provision.sql
\ir ../../docs/sql/cloud_03_5c3b3d4_closed_fixture_provision.sql
do $$begin
 if (select count(*) from public.archives)<>2 or (select count(*) from public.archive_members)<>3 or (select count(*) from archivito_inc.gates)<>2
 or exists(select 1 from archivito_inc.gates where enabled)
 or not exists(select 1 from public.archives where id='00000000-0000-4000-8000-000000000005' and key_fingerprint=repeat('a',64))
 or not exists(select 1 from archivito_inc.gates where archive_id='00000000-0000-4000-8000-000000000005' and quota_bytes=123)
 or exists(select 1 from public.archive_members where user_id='00000000-0000-4000-8000-000000000003')
 then raise exception 'fixture isolation/idempotence failed';end if;
end$$;
\ir ../../docs/sql/cloud_03_5c3b3d4_closed_fixture_verify.sql
select 'PASS dry-run rollback, closed fixture apply, idempotent retry, unrelated fixture unchanged' as result;
