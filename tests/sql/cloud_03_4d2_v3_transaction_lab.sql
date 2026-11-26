-- CLOUD-03.4D2: transaction laboratory only. Synthetic rows; always rollback.
begin;
create schema archivito_v3_tx_lab;
revoke all on schema archivito_v3_tx_lab from public,anon,authenticated;
create table archivito_v3_tx_lab.gates(archive_id uuid primary key,enabled boolean not null,key_id text not null,quota bigint not null check(quota>0));
create table archivito_v3_tx_lab.members(archive_id uuid references archivito_v3_tx_lab.gates,user_id uuid,primary key(archive_id,user_id));
create table archivito_v3_tx_lab.intents(
 archive_id uuid references archivito_v3_tx_lab.gates,operation_id uuid,memory_id uuid not null,actor uuid not null,
 expected_revision bigint not null check(expected_revision>=0),revision bigint not null check(revision=expected_revision+1),
 header jsonb not null,reserved_bytes bigint not null check(reserved_bytes>0),committed boolean not null default false,
 primary key(archive_id,operation_id));
create unique index v3_lab_rev on archivito_v3_tx_lab.intents(archive_id,memory_id,revision) where committed;
create table archivito_v3_tx_lab.blocks(
 archive_id uuid,operation_id uuid,path text,size bigint not null check(size between 1 and 4194304),
 sha256 text not null check(sha256~'^[0-9a-f]{64}$'),verified boolean not null default false,
 primary key(archive_id,operation_id,path),foreign key(archive_id,operation_id) references archivito_v3_tx_lab.intents);
alter table archivito_v3_tx_lab.gates enable row level security;
alter table archivito_v3_tx_lab.members enable row level security;
alter table archivito_v3_tx_lab.intents enable row level security;
alter table archivito_v3_tx_lab.blocks enable row level security;
revoke all on all tables in schema archivito_v3_tx_lab from public,anon,authenticated;
-- Privileged lab only; production must expose only a trusted server interface.
-- Header is assumed to have passed exact wire validation before this function.
create function archivito_v3_tx_lab.step(actor_id uuid,action text,h jsonb,verified_path text default null,verified_size bigint default null,verified_hash text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare a uuid; op uuid; mem uuid; e bigint; r bigint; current_rev bigint; n bigint; used bigint; gate archivito_v3_tx_lab.gates%rowtype; saved archivito_v3_tx_lab.intents%rowtype;
begin
 if actor_id is null or action is null or action not in ('begin','verify','commit') or h is null or h->>'format' is distinct from 'archivito-sync-record-wire-v1' then raise exception 'invalid';end if;
 a:=(h->>'archiveId')::uuid;op:=(h->>'operationId')::uuid;mem:=(h->>'memoryId')::uuid;e:=(h->>'expectedRevision')::bigint;r:=(h->>'revision')::bigint;
 if a is null or op is null or mem is null or e is null or r is null or e<0 or r<>e+1 or r>9007199254740991 then raise exception 'invalid revision';end if;
 select * into gate from archivito_v3_tx_lab.gates where archive_id=a for update;
 if gate.enabled is distinct from true then raise exception 'disabled';end if;
 if gate.key_id is distinct from h->>'keyId' then raise exception 'wrong key';end if;
 perform 1 from archivito_v3_tx_lab.members where archive_id=a and user_id=actor_id for share;
 if not found then raise exception 'not member';end if;
 select * into saved from archivito_v3_tx_lab.intents where archive_id=a and operation_id=op;
 if found then
  if saved.actor is distinct from actor_id or saved.header is distinct from h then raise exception 'intent mismatch';end if;
  if saved.committed then return jsonb_build_object('state','synced','operationId',op,'revision',r,'replayed',true);end if;
 elsif action<>'begin' then raise exception 'missing intent';end if;
 select coalesce(max(revision),0) into current_rev from archivito_v3_tx_lab.intents where archive_id=a and memory_id=mem and committed;
 if current_rev<>e then return jsonb_build_object('state','conflict','actualRevision',current_rev);end if;
 if action='begin' then
  if saved.operation_id is null then
   -- Header base64 size is conservatively charged by encoded length; blocks by ciphertext bytes.
   select coalesce(sum((c->>'size')::bigint),0)+length(h->'metadata'->>'ciphertext') into n
    from jsonb_array_elements(h->'assets') x cross join lateral jsonb_array_elements(x->'chunks') c;
   if n is null or n<=0 or n>134217728+1600+349600 then raise exception 'invalid size';end if;
   select coalesce(sum(reserved_bytes),0) into used from archivito_v3_tx_lab.intents where archive_id=a;
   if used+n>gate.quota or (select count(*) from archivito_v3_tx_lab.intents where archive_id=a and not committed)>=8 then raise exception 'quota';end if;
   insert into archivito_v3_tx_lab.intents(archive_id,operation_id,memory_id,actor,expected_revision,revision,header,reserved_bytes)
    values(a,op,mem,actor_id,e,r,h,n);
   insert into archivito_v3_tx_lab.blocks(archive_id,operation_id,path,size,sha256)
    select a,op,c->>'path',(c->>'size')::bigint,c->>'sha256'
    from jsonb_array_elements(h->'assets') x cross join lateral jsonb_array_elements(x->'chunks') c;
  end if;
  return jsonb_build_object('state','staging','operationId',op);
 end if;
 if action='verify' then
  -- Only trusted server may attest, after independent Storage read; this lab simulates it.
  update archivito_v3_tx_lab.blocks set verified=true where archive_id=a and operation_id=op and path=verified_path and size=verified_size and sha256=verified_hash;
  if not found then raise exception 'bad attestation';end if;
  return jsonb_build_object('state','verified','operationId',op);
 end if;
 if not exists(select 1 from archivito_v3_tx_lab.blocks where archive_id=a and operation_id=op) or exists(select 1 from archivito_v3_tx_lab.blocks where archive_id=a and operation_id=op and not verified) then raise exception 'incomplete';end if;
 update archivito_v3_tx_lab.intents set committed=true where archive_id=a and operation_id=op;
 return jsonb_build_object('state','synced','operationId',op,'revision',r,'replayed',false);
end $$;
revoke all on function archivito_v3_tx_lab.step(uuid,text,jsonb,text,bigint,text) from public,anon,authenticated;
do $$
declare
 a uuid:='10000000-0000-4000-8000-000000000001';u uuid:='10000000-0000-4000-8000-000000000002';v uuid:='10000000-0000-4000-8000-000000000003';
 mem uuid:='10000000-0000-4000-8000-000000000004';op uuid:='10000000-0000-4000-8000-000000000005';op2 uuid:='10000000-0000-4000-8000-000000000006';
 k text:=repeat('a',64);digest text:=repeat('b',64);h jsonb;h2 jsonb;res jsonb;rejected boolean;
begin
 insert into archivito_v3_tx_lab.gates values(a,false,k,1000);
 insert into archivito_v3_tx_lab.members values(a,u),(a,v);
 h:=jsonb_build_object('format','archivito-sync-record-wire-v1','archiveId',a,'operationId',op,'memoryId',mem,'keyId',k,'expectedRevision',0,'revision',1,'metadata',jsonb_build_object('ciphertext','synthetic'),'assets',jsonb_build_array(jsonb_build_object('chunks',jsonb_build_array(jsonb_build_object('path','test/0','size',20,'sha256',digest),jsonb_build_object('path','test/1','size',30,'sha256',digest)))));
 h2:=jsonb_set(h,'{operationId}',to_jsonb(op2));
 rejected:=false;
 begin perform archivito_v3_tx_lab.step(u,'begin',h);exception when others then if sqlerrm<>'disabled' then raise;end if;rejected:=true;end;
 if not rejected then raise exception 'gate failed';end if;
 update archivito_v3_tx_lab.gates set enabled=true;
 rejected:=false;
 begin perform archivito_v3_tx_lab.step('10000000-0000-4000-8000-000000000009','begin',h);exception when others then if sqlerrm<>'not member' then raise;end if;rejected:=true;end;
 if not rejected then raise exception 'outsider accepted';end if;
 perform archivito_v3_tx_lab.step(u,'begin',h);
 perform archivito_v3_tx_lab.step(u,'begin',h);
 if (select count(*) from archivito_v3_tx_lab.intents)<>1 then raise exception 'duplicate begin';end if;
 rejected:=false;
 begin perform archivito_v3_tx_lab.step(v,'begin',h);exception when others then if sqlerrm<>'intent mismatch' then raise;end if;rejected:=true;end;
 if not rejected then raise exception 'actor mismatch accepted';end if;
 perform archivito_v3_tx_lab.step(v,'begin',h2);
 update archivito_v3_tx_lab.gates set quota=120;
 rejected:=false;
 begin perform archivito_v3_tx_lab.step(u,'begin',jsonb_set(h,'{operationId}',to_jsonb('10000000-0000-4000-8000-000000000007'::uuid)));exception when others then if sqlerrm<>'quota' then raise;end if;rejected:=true;end;
 if not rejected then raise exception 'quota failed';end if;
 rejected:=false;
 begin perform archivito_v3_tx_lab.step(u,'verify',h,'test/0',20,repeat('c',64));exception when others then if sqlerrm<>'bad attestation' then raise;end if;rejected:=true;end;
 if not rejected then raise exception 'bad hash accepted';end if;
 perform archivito_v3_tx_lab.step(u,'verify',h,'test/0',20,digest);
 rejected:=false;
 begin perform archivito_v3_tx_lab.step(u,'commit',h);exception when others then if sqlerrm<>'incomplete' then raise;end if;rejected:=true;end;
 if not rejected then raise exception 'partial commit accepted';end if;
 perform archivito_v3_tx_lab.step(u,'verify',h,'test/1',30,digest);
 perform archivito_v3_tx_lab.step(v,'verify',h2,'test/0',20,digest);
 perform archivito_v3_tx_lab.step(v,'verify',h2,'test/1',30,digest);
 res:=archivito_v3_tx_lab.step(u,'commit',h);
 if res->>'state'<>'synced' or res->>'replayed'<>'false' then raise exception 'commit failed';end if;
 res:=archivito_v3_tx_lab.step(v,'commit',h2);
 if res->>'state'<>'conflict' or res->>'actualRevision'<>'1' then raise exception 'CAS failed';end if;
 res:=archivito_v3_tx_lab.step(u,'begin',h);
 if res->>'state'<>'synced' or res->>'replayed'<>'true' then raise exception 'receipt failed';end if;
 if (select count(*) from archivito_v3_tx_lab.intents where committed)<>1 then raise exception 'commit count';end if;
 if has_schema_privilege('authenticated','archivito_v3_tx_lab','USAGE') or has_function_privilege('authenticated','archivito_v3_tx_lab.step(uuid,text,jsonb,text,bigint,text)','EXECUTE') then raise exception 'privilege leak';end if;
end $$;
rollback;
select 'PASS: gate, outsider, actor binding, idempotent begin, quota, wrong hash, incomplete commit, CAS, replay, grants; rollback' result;