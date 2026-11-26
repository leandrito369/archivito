-- Temporary acceptance guard. Removal requires a later reviewed migration.
alter table public.sync_v3_intents add constraint sync_v3_acceptance_scope check (
 memory_id='fb8b27a1-06cf-49ea-8a28-eef4a1539d45'::uuid and revision between 1 and 3
);
update public.sync_v3_gate set quota_bytes=50331648 where not enabled;
