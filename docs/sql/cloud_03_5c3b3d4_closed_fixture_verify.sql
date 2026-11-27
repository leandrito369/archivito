-- Read-only operator verification. Returns only booleans and counts.
with fixture as (select '73ac551b-2df8-4da7-91b8-4adf18d83900'::uuid as ar),
accounts as (
 select id,case lower(email) when 'archivito-cert-a@example.com' then 'A'
 when 'archivito-cert-b@example.com' then 'B' else 'C' end label
 from auth.users where lower(email) in ('archivito-cert-a@example.com','archivito-cert-b@example.com','archivito-cert-c@example.com')
 and email_confirmed_at is not null and deleted_at is null
)
select
 (select count(*) from accounts) confirmed_accounts,
 (select count(*) from public.archives a,fixture f where a.id=f.ar and a.key_fingerprint is null) empty_key_fixture,
 (select count(*) from public.archive_members m,fixture f where m.archive_id=f.ar) fixture_members,
 (select count(*) from public.archive_members m join accounts u on u.id=m.user_id cross join fixture f
 where m.archive_id=f.ar and ((u.label='A' and m.role='owner') or (u.label='B' and m.role='editor'))) correct_memberships,
 (select count(*) from public.archive_members m join accounts u on u.id=m.user_id cross join fixture f
 where m.archive_id<>f.ar or u.label='C') unexpected_memberships,
 (select count(*) from archivito_inc.gates g,fixture f where g.archive_id=f.ar and not g.enabled and g.quota_bytes=67108864) dedicated_closed_gate,
 (select count(*) from archivito_inc.gates where enabled) open_gates,
 exists(select 1 from pg_constraint where conrelid='archivito_inc.gates'::regclass and conname='inc_gate_hard_closed' and convalidated and pg_get_constraintdef(oid)='CHECK ((NOT enabled))') hard_closed,
 (select count(*) from archivito_inc.operations o,fixture f where o.archive_id=f.ar) fixture_operations,
 (select count(*) from archivito_inc.heads h,fixture f where h.archive_id=f.ar) fixture_heads,
 (select count(*) from storage.objects o,fixture f where o.bucket_id='archivito-inc-private' and o.name like f.ar::text||'/%') fixture_objects;
