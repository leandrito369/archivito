-- CLOUD-03.5C3B1 candidate; NOT a deployed migration. No bucket or RPC.
create schema archivito_inc;
revoke all on schema archivito_inc from public,anon,authenticated,service_role;
create table archivito_inc.gates(
 archive_id uuid primary key references public.archives(id) on delete restrict,
 enabled boolean not null default false check(not enabled),
 quota_bytes bigint not null default 268435456 check(quota_bytes between 1 and 268435456)
);
-- Operation identity and receipt outlive the manifest. No operation ID reuse.
create table archivito_inc.operations(
 archive_id uuid references archivito_inc.gates(archive_id), operation_id uuid, memory_id uuid not null,
 actor uuid not null,key_id text not null check(key_id~'^[0-9a-f]{64}$'),
 revision bigint not null check(revision between 1 and 9007199254740991),
 base_revision bigint not null,base_operation_id uuid,
 digest text not null check(digest~'^[0-9a-f]{64}$'),
 state text not null check(state in ('staging','committed','fenced','aborted')),
 receipt_bytes bigint not null check(receipt_bytes between 1 and 600000),
 created_at timestamptz not null default now(),last_activity timestamptz not null default now(),
 lease_until timestamptz,
 primary key(archive_id,operation_id),
 unique(archive_id,memory_id,operation_id),
 unique(archive_id,memory_id,operation_id,revision),
 check(base_revision=revision-1 and (base_revision=0)=(base_operation_id is null) and base_operation_id is distinct from operation_id),
 foreign key(archive_id,memory_id,base_operation_id,base_revision) references archivito_inc.operations(archive_id,memory_id,operation_id,revision)
);
create unique index inc_committed_revision on archivito_inc.operations(archive_id,memory_id,revision) where state='committed';
create table archivito_inc.manifests(
 archive_id uuid,memory_id uuid,operation_id uuid,revision bigint,
 encrypted_header jsonb not null,charged_bytes bigint not null check(charged_bytes between 1 and 600000),
 pinned boolean not null default false,committed_at timestamptz,
 primary key(archive_id,memory_id,operation_id),
 unique(archive_id,memory_id,operation_id,revision),
 foreign key(archive_id,memory_id,operation_id,revision) references archivito_inc.operations(archive_id,memory_id,operation_id,revision)
);
create table archivito_inc.heads(
 archive_id uuid,memory_id uuid,operation_id uuid not null,revision bigint not null,
 primary key(archive_id,memory_id),
 foreign key(archive_id,memory_id,operation_id,revision) references archivito_inc.manifests(archive_id,memory_id,operation_id,revision)
);
-- Catalog retains descriptor and birth operation even when its manifest is retired.
create table archivito_inc.assets(
 archive_id uuid,asset_id uuid,memory_id uuid not null,birth_operation_id uuid not null,born bigint not null,
 ciphertext_bytes bigint not null check(ciphertext_bytes between 17 and 36700176),
 nonce text not null check(nonce~'^[A-Za-z0-9_-]{16}$'),
 cipher_sha256 text not null check(cipher_sha256~'^[0-9a-f]{64}$'),
 state text not null check(state in ('staging','ready','gc')),
 primary key(archive_id,asset_id),
 unique(archive_id,memory_id,asset_id),
 foreign key(archive_id,memory_id,birth_operation_id,born) references archivito_inc.operations(archive_id,memory_id,operation_id,revision)
);
create table archivito_inc.blocks(
 archive_id uuid,memory_id uuid,asset_id uuid,block_index integer check(block_index between 0 and 8),
 path text not null unique,bytes integer not null check(bytes between 1 and 4194304),
 sha256 text not null check(sha256~'^[0-9a-f]{64}$'),verified boolean not null default false,
 primary key(archive_id,asset_id,block_index),
 foreign key(archive_id,memory_id,asset_id) references archivito_inc.assets(archive_id,memory_id,asset_id),
 check(path=archive_id::text||'/'||memory_id::text||'/'||asset_id::text||'/'||block_index::text)
);
-- References of staging and committed manifests both protect the same asset.
create table archivito_inc.refs(
 archive_id uuid,memory_id uuid,operation_id uuid,asset_id uuid,
 primary key(archive_id,memory_id,operation_id,asset_id),
 foreign key(archive_id,memory_id,operation_id) references archivito_inc.manifests(archive_id,memory_id,operation_id),
 foreign key(archive_id,memory_id,asset_id) references archivito_inc.assets(archive_id,memory_id,asset_id)
);
create index inc_refs_asset on archivito_inc.refs(archive_id,memory_id,asset_id);
create table archivito_inc.holds(
 archive_id uuid,memory_id uuid,operation_id uuid,hold_id uuid,
 kind text not null check(kind in ('read','restore','backup')),
 primary key(archive_id,hold_id),
 foreign key(archive_id,memory_id,operation_id) references archivito_inc.manifests(archive_id,memory_id,operation_id)
);
-- No public exposure, direct client access, service grants or write API in B1.
do $$ declare t text; begin
 foreach t in array array['gates','operations','manifests','heads','assets','blocks','refs','holds'] loop
  execute format('alter table archivito_inc.%I enable row level security',t);
 end loop;
end $$;
revoke all on all tables in schema archivito_inc from public,anon,authenticated,service_role;
