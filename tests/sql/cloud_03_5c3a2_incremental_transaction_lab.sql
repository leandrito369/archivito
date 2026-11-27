-- CLOUD-03.5C3A2: isolated rollback laboratory. No existing archive rows touched.
begin;
create schema archivito_inc_tx_lab;
revoke all on schema archivito_inc_tx_lab from public,anon,authenticated;
create table archivito_inc_tx_lab.gates(a uuid primary key,enabled boolean not null,key_id text not null,quota bigint not null check(quota>0));
create table archivito_inc_tx_lab.members(a uuid references archivito_inc_tx_lab.gates,u uuid,primary key(a,u));
create table archivito_inc_tx_lab.intents(
 a uuid references archivito_inc_tx_lab.gates,op uuid,m uuid not null,actor uuid not null,rev bigint not null check(rev>0),
 wire jsonb not null,reserved bigint not null check(reserved>0),committed boolean not null default false,primary key(a,op));
create unique index inc_lab_rev on archivito_inc_tx_lab.intents(a,m,rev) where committed;
create table archivito_inc_tx_lab.assets(
 a uuid,id uuid,m uuid not null,birth_op uuid not null,descriptor jsonb not null,primary key(a,id),
 foreign key(a,birth_op) references archivito_inc_tx_lab.intents(a,op));
create table archivito_inc_tx_lab.refs(
 a uuid,op uuid,id uuid,primary key(a,op,id),foreign key(a,op) references archivito_inc_tx_lab.intents(a,op),
 foreign key(a,id) references archivito_inc_tx_lab.assets(a,id));
create table archivito_inc_tx_lab.blocks(
 a uuid,id uuid,path text,size bigint not null check(size between 1 and 4194304),sha text not null check(sha~'^[0-9a-f]{64}$'),
 verified boolean not null default false,primary key(a,path),foreign key(a,id) references archivito_inc_tx_lab.assets(a,id));
alter table archivito_inc_tx_lab.gates enable row level security;
alter table archivito_inc_tx_lab.members enable row level security;
alter table archivito_inc_tx_lab.intents enable row level security;
alter table archivito_inc_tx_lab.assets enable row level security;
alter table archivito_inc_tx_lab.refs enable row level security;
alter table archivito_inc_tx_lab.blocks enable row level security;
revoke all on all tables in schema archivito_inc_tx_lab from public,anon,authenticated;
-- Trusted lab assumes exact wire validation in JS, and simulates trusted readback.
create function archivito_inc_tx_lab.step(p_actor uuid,p_action text,w jsonb,p_path text default null,p_size bigint default null,p_sha text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare a_id uuid;o_id uuid;m_id uuid;r_id uuid;r bigint;b_rev bigint;b_op uuid;cur bigint;cur_op uuid;h jsonb;d jsonb;up jsonb;gate archivito_inc_tx_lab.gates%rowtype;old archivito_inc_tx_lab.intents%rowtype;needed bigint;used bigint;
begin
 if p_actor is null or p_action is null or p_action not in ('begin','verify','commit') or w->>'format' is distinct from 'archivito-incremental-wire-v1' then raise exception 'invalid';end if;
 h:=w->'header';a_id:=(h->>'archiveId')::uuid;o_id:=(h->>'operationId')::uuid;m_id:=(h->>'memoryId')::uuid;r:=(h->>'revision')::bigint;
 b_rev:=coalesce((w->'base'->>'revision')::bigint,0);b_op:=(w->'base'->>'operationId')::uuid;
 if a_id is null or o_id is null or m_id is null or r is null or r<1 or r>9007199254740991 or r<>b_rev+1 or (b_rev=0)<>(b_op is null) or b_op=o_id then raise exception 'invalid base';end if;
 select * into gate from archivito_inc_tx_lab.gates where a=a_id for update;
 if gate.enabled is distinct from true then raise exception 'disabled';end if;
 if gate.key_id is distinct from h->>'keyId' then raise exception 'wrong key';end if;
 perform 1 from archivito_inc_tx_lab.members where a=a_id and u=p_actor for share;
 if not found then raise exception 'not member';end if;
 select * into old from archivito_inc_tx_lab.intents where a=a_id and op=o_id;
 if found then
  if old.actor is distinct from p_actor or old.wire is distinct from w then raise exception 'intent mismatch';end if;
  if old.committed then return jsonb_build_object('state','synced','revision',r,'operationId',o_id,'replayed',true);end if;
 elsif p_action<>'begin' then raise exception 'missing intent';end if;
 select rev,op into cur,cur_op from archivito_inc_tx_lab.intents where a=a_id and m=m_id and committed order by rev desc limit 1;
 if coalesce(cur,0)<>b_rev or cur_op is distinct from b_op then return jsonb_build_object('state','conflict','actualRevision',coalesce(cur,0),'actualOperationId',cur_op);end if;
 if p_action='begin' and old.op is null then
  needed:=octet_length(w::text);
  for d in select value from jsonb_array_elements(h->'refs') loop
   r_id:=(d->>'id')::uuid;
   if (d->>'born')::bigint=r then
    if exists(select 1 from archivito_inc_tx_lab.assets x where x.a=a_id and x.id=r_id) then raise exception 'asset identity already used';end if;
    needed:=needed+(d->>'size')::bigint;
   elsif not exists(
    select 1 from archivito_inc_tx_lab.refs f join archivito_inc_tx_lab.assets x on x.a=f.a and x.id=f.id
    join archivito_inc_tx_lab.intents i on i.a=x.a and i.op=x.birth_op
    where f.a=a_id and f.op=b_op and f.id=r_id and x.m=m_id and x.descriptor=d and i.committed
   ) then raise exception 'invalid inherited reference';end if;
  end loop;
  select coalesce(sum(reserved),0) into used from archivito_inc_tx_lab.intents where a=a_id;
  if used+needed>gate.quota or (select count(*) from archivito_inc_tx_lab.intents where a=a_id)>=512 or (select count(*) from archivito_inc_tx_lab.intents where a=a_id and not committed)>=8 then raise exception 'quota';end if;
  insert into archivito_inc_tx_lab.intents values(a_id,o_id,m_id,p_actor,r,w,needed,false);
  for d in select value from jsonb_array_elements(h->'refs') loop
   r_id:=(d->>'id')::uuid;
   if (d->>'born')::bigint=r then
    insert into archivito_inc_tx_lab.assets values(a_id,r_id,m_id,o_id,d);
    select value into strict up from jsonb_array_elements(w->'uploads') where value->>'id'=r_id::text;
    insert into archivito_inc_tx_lab.blocks(a,id,path,size,sha)
     select a_id,r_id,c->>'path',(c->>'size')::bigint,c->>'sha256' from jsonb_array_elements(up->'chunks') c;
   end if;
   insert into archivito_inc_tx_lab.refs values(a_id,o_id,r_id);
  end loop;
 end if;
 if p_action='begin' then return jsonb_build_object('state','staging','operationId',o_id);end if;
 if p_action='verify' then
  update archivito_inc_tx_lab.blocks b set verified=true from archivito_inc_tx_lab.assets x
   where b.a=a_id and b.a=x.a and b.id=x.id and x.birth_op=o_id and b.path=p_path and b.size=p_size and b.sha=p_sha;
  if not found then raise exception 'bad attestation';end if;
  return jsonb_build_object('state','verified','operationId',o_id);
 end if;
 -- Every new asset needs blocks of exact aggregate size, all attested.
 if exists(select 1 from archivito_inc_tx_lab.assets x where x.a=a_id and x.birth_op=o_id and
   ((select coalesce(sum(b.size),0) from archivito_inc_tx_lab.blocks b where b.a=x.a and b.id=x.id)<>(x.descriptor->>'size')::bigint
   or exists(select 1 from archivito_inc_tx_lab.blocks b where b.a=x.a and b.id=x.id and not b.verified))) then raise exception 'incomplete';end if;
 update archivito_inc_tx_lab.intents set committed=true where a=a_id and op=o_id;
 return jsonb_build_object('state','synced','revision',r,'operationId',o_id,'replayed',false);
end $$;
revoke all on function archivito_inc_tx_lab.step(uuid,text,jsonb,text,bigint,text) from public,anon,authenticated;
-- Assert exact expected exception, never swallow a different SQL failure.
create function archivito_inc_tx_lab.rejects(u uuid,act text,w jsonb,reason text,p text default null,n bigint default null,h text default null)
returns void language plpgsql security invoker set search_path='' as $$
begin
 begin perform archivito_inc_tx_lab.step(u,act,w,p,n,h);
 exception when others then if sqlerrm<>reason then raise;end if;return;end;
 raise exception 'expected rejection: %',reason;
end $$;
revoke all on function archivito_inc_tx_lab.rejects(uuid,text,jsonb,text,text,bigint,text) from public,anon,authenticated;
do $$
declare a uuid:='10000000-0000-4000-8000-000000000001';u uuid:='10000000-0000-4000-8000-000000000002';v uuid:='10000000-0000-4000-8000-000000000003';m uuid:='10000000-0000-4000-8000-000000000004';
 op1 uuid:='10000000-0000-4000-8000-000000000005';op2 uuid:='10000000-0000-4000-8000-000000000006';op3 uuid:='10000000-0000-4000-8000-000000000007';asset uuid:='10000000-0000-4000-8000-000000000008';
 p text; k text:=repeat('a',64);s text:=repeat('b',64);d jsonb;w1 jsonb;w2 jsonb;w3 jsonb;res jsonb;before_bytes bigint;
begin
 p:=a::text||'/'||m::text||'/'||asset::text||'/0';
 d:=jsonb_build_object('id',asset,'born',1,'size',32,'nonce','AAAAAAAAAAAAAAAA','cipherSha256',s);
 w1:=jsonb_build_object('format','archivito-incremental-wire-v1','base',null,'header',jsonb_build_object('archiveId',a,'memoryId',m,'operationId',op1,'keyId',k,'revision',1,'refs',jsonb_build_array(d),'metadata','synthetic'),'uploads',jsonb_build_array(jsonb_build_object('id',asset,'chunks',jsonb_build_array(jsonb_build_object('path',p,'size',32,'sha256',s)))));
 w2:=jsonb_set(jsonb_set(jsonb_set(jsonb_set(w1,'{header,operationId}',to_jsonb(op2)),'{header,revision}','2'),'{base}',jsonb_build_object('revision',1,'operationId',op1)),'{uploads}','[]');
 w3:=jsonb_set(w2,'{header,operationId}',to_jsonb(op3));
 insert into archivito_inc_tx_lab.gates values(a,false,k,100000);
 insert into archivito_inc_tx_lab.members values(a,u),(a,v);
 perform archivito_inc_tx_lab.rejects(u,'begin',w1,'disabled');
 update archivito_inc_tx_lab.gates set enabled=true;
 perform archivito_inc_tx_lab.rejects('10000000-0000-4000-8000-000000000009','begin',w1,'not member');
 perform archivito_inc_tx_lab.rejects(u,'begin',jsonb_set(w1,'{header,keyId}',to_jsonb(repeat('c',64))),'wrong key');
 perform archivito_inc_tx_lab.step(u,'begin',w1);
 select sum(reserved) into before_bytes from archivito_inc_tx_lab.intents;
 perform archivito_inc_tx_lab.step(u,'begin',w1);
 if (select sum(reserved) from archivito_inc_tx_lab.intents)<>before_bytes then raise exception 'double reserve';end if;
 perform archivito_inc_tx_lab.rejects(v,'begin',w1,'intent mismatch');
 perform archivito_inc_tx_lab.rejects(u,'commit',w1,'incomplete');
 perform archivito_inc_tx_lab.rejects(u,'verify',w1,'bad attestation',p,32,repeat('c',64));
 perform archivito_inc_tx_lab.step(u,'verify',w1,p,32,s);
 res:=archivito_inc_tx_lab.step(u,'commit',w1);
 if res->>'state'<>'synced' then raise exception 'r1 failed';end if;
 perform archivito_inc_tx_lab.rejects(v,'begin',jsonb_set(w2,'{header,refs,0,nonce}','"BBBBBBBBBBBBBBBB"'),'invalid inherited reference');
 update archivito_inc_tx_lab.gates set quota=before_bytes;
 perform archivito_inc_tx_lab.rejects(v,'begin',w2,'quota');
 update archivito_inc_tx_lab.gates set quota=100000;
 perform archivito_inc_tx_lab.step(v,'begin',w2);
 if (select reserved from archivito_inc_tx_lab.intents where op=op2)<>octet_length(w2::text) then raise exception 'metadata-only charged asset';end if;
 perform archivito_inc_tx_lab.step(u,'begin',w3);
 res:=archivito_inc_tx_lab.step(v,'commit',w2);
 if res->>'state'<>'synced' then raise exception 'r2 failed';end if;
 res:=archivito_inc_tx_lab.step(u,'commit',w3);
 if res->>'state'<>'conflict' or res->>'actualRevision'<>'2' then raise exception 'CAS failed';end if;
 res:=archivito_inc_tx_lab.step(u,'begin',w1);
 if res->>'replayed'<>'true' then raise exception 'replay failed';end if;
 if (select count(*) from archivito_inc_tx_lab.assets)<>1 or (select count(*) from archivito_inc_tx_lab.blocks)<>1 or (select count(*) from archivito_inc_tx_lab.intents where committed)<>2 then raise exception 'duplicate asset or commit';end if;
 if (select count(*) from archivito_inc_tx_lab.refs f join archivito_inc_tx_lab.intents i on i.a=f.a and i.op=f.op where i.committed)<>2 then raise exception 'history refs missing';end if;
 if has_schema_privilege('authenticated','archivito_inc_tx_lab','USAGE') or has_function_privilege('authenticated','archivito_inc_tx_lab.step(uuid,text,jsonb,text,bigint,text)','EXECUTE') then raise exception 'privilege leak';end if;
end $$;
rollback;
select 'PASS: gate, outsider, key, actor, exact retry, quota, inherited refs, incomplete, hash, metadata-only, CAS, history, grants; rollback' result;