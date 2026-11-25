-- Applied follow-up migration: archivito_fixture_backend_service_privileges.
-- Trusted server only; FOR SHARE requires UPDATE on at least one column.
grant select on public.archives,public.archive_members to service_role;
grant update(created_at) on public.archives,public.archive_members to service_role;
