-- Snapshot documental del bootstrap aplicado a Archivito el 25/11/2026.
-- Migración registrada en Supabase: 20261125140258 archivito_private_archive_readonly_bootstrap.
-- NO ejecutar de nuevo contra el proyecto existente. No contiene IDs de usuarios ni secretos.
-- Estado: solo lectura de miembros, sin acceso de escritura ni policies Storage.
create table public.archives (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  schema_version integer not null default 1 check (schema_version = 1)
);
create table public.archive_members (
  archive_id uuid not null references public.archives(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','editor')),
  created_at timestamptz not null default now(),
  primary key (archive_id,user_id),
  unique (archive_id,role)
);
create index archive_members_user_id_idx on public.archive_members(user_id);
create table public.memories (
  id uuid primary key default gen_random_uuid(),
  archive_id uuid not null references public.archives(id) on delete restrict,
  revision bigint not null default 1 check (revision > 0),
  encrypted_payload bytea not null check (octet_length(encrypted_payload) >= 16),
  nonce bytea not null check (octet_length(nonce) = 12),
  crypto_version integer not null default 1 check (crypto_version = 1),
  updated_at timestamptz not null default now()
);
create index memories_archive_id_idx on public.memories(archive_id);
alter table public.archives enable row level security;
alter table public.archive_members enable row level security;
alter table public.memories enable row level security;
revoke all on public.archives, public.archive_members, public.memories from public, anon, authenticated;
grant select on public.archives, public.archive_members, public.memories to authenticated;
create policy archive_members_read_self on public.archive_members
  for select to authenticated using (user_id = (select auth.uid()));
create policy archives_read_member on public.archives
  for select to authenticated using (exists (
    select 1 from public.archive_members m where m.archive_id = archives.id and m.user_id = (select auth.uid())
  ));
create policy memories_read_member on public.memories
  for select to authenticated using (exists (
    select 1 from public.archive_members m where m.archive_id = memories.archive_id and m.user_id = (select auth.uid())
  ));
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('archivito-private','archivito-private',false,37748736,array['application/octet-stream']::text[]);
insert into public.archives default values;
