-- Migración aplicada 20261125160825. No ejecutar de nuevo en el proyecto existente.
alter table public.archives add column key_fingerprint text
  constraint archives_key_fingerprint_format check (key_fingerprint is null or key_fingerprint ~ '^[0-9a-f]{64}$');
comment on column public.archives.key_fingerprint is 'SHA-256 of random 256-bit archive key; public verifier, never recovery secret. Admin provisioning only; null means not commissioned.';
