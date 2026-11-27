"""Candidate ACL/HTTP RPC in the same disposable CI DB after multisesion lab."""
import json
from test_incremental_cert_multisession import ROOT, SC, KEY, MEMORY, HASH, fixture, wire, uid, lit, run, counts


def api(actor, session, action, archive, **args):
    p=dict(p_actor=actor,p_session=session,p_action=action,p_archive=archive,**args)
    a=", ".join(k+"=>"+(str(v) if isinstance(v,int) else lit(v)+("::jsonb" if k=="p_wire" else "")) for k,v in p.items())
    return "set role service_role; select public.sync_inc_cert_http("+a+");"


def main():
    run("""
      create schema auth;
      create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
      alter table auth.sessions enable row level security;
      alter table public.archives enable row level security;
      alter table public.archive_members enable row level security;
      alter table storage.objects enable row level security;
      -- Emulate Supabase hosted postgres admin (NOSUPERUSER, CREATEROLE, BYPASSRLS,
      -- no ownership or grant option on auth/storage managed schemas).
      create role e56_deploy_admin nologin nosuperuser createrole noinherit bypassrls;
      grant create,usage on schema public to e56_deploy_admin with grant option;
      grant usage on schema auth,storage to e56_deploy_admin;
      grant select(id,user_id,not_after),update(id) on auth.sessions to e56_deploy_admin;
      grant select(bucket_id,name,metadata) on storage.objects to e56_deploy_admin;
      alter table public.archives owner to e56_deploy_admin;
      alter table public.archive_members owner to e56_deploy_admin;
      alter schema archivito_inc owner to e56_deploy_admin;
      alter schema archivito_inc_cert_candidate owner to e56_deploy_admin;
      alter function public.sync_inc_step(uuid,text,jsonb,uuid,text) owner to e56_deploy_admin;
      alter function public.sync_inc_inspect(uuid,uuid,text,uuid,uuid,uuid) owner to e56_deploy_admin;
      do $$ declare r record; begin
        for r in select schemaname,tablename from pg_tables where schemaname in ('archivito_inc','archivito_inc_cert_candidate') loop
          execute format('alter table %I.%I owner to e56_deploy_admin',r.schemaname,r.tablename);
        end loop;
        for r in select oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='archivito_inc_cert_candidate' loop
          execute format('alter function %s owner to e56_deploy_admin',r.sig);
        end loop;
      end $$;
    """)
    run("begin;\nset local role e56_deploy_admin;\n"
        +(ROOT/"docs/sql/cloud_03_5c3b3d3_http_acl_candidate.sql").read_text()
        +"\ncommit;")
    assert run("""
       select not rolcanlogin and not rolbypassrls and not rolinherit and not rolsuper
       from pg_roles where rolname='archivito_cert_executor';
    """)=="t"
    assert run("""
       select not rolsuper and rolcreaterole and rolbypassrls
       from pg_roles where rolname='e56_deploy_admin';
    """)=="t"
    assert run("""
       select not pg_has_role('service_role','archivito_cert_executor','MEMBER')
       and not pg_has_role('e56_deploy_admin','archivito_cert_executor','SET')
       and not has_schema_privilege('e56_deploy_admin','auth','USAGE WITH GRANT OPTION')
       and not has_column_privilege('e56_deploy_admin','auth.sessions','id','UPDATE WITH GRANT OPTION')
       and not has_schema_privilege('archivito_cert_executor','auth','USAGE')
       and not has_schema_privilege('archivito_cert_executor','storage','USAGE')
       and not has_schema_privilege('archivito_cert_executor','archivito_inc_cert_candidate','CREATE')
       and not has_column_privilege('archivito_cert_executor','auth.sessions','id','SELECT')
       and not has_column_privilege('archivito_cert_executor','auth.sessions','id','UPDATE')
       and not has_column_privilege('archivito_cert_executor','storage.objects','metadata','SELECT')
       and not exists(select 1 from pg_policies where 'archivito_cert_executor'=any(roles) and schemaname in ('auth','storage'))
       and not has_schema_privilege('service_role','archivito_inc','USAGE')
       and not has_table_privilege('service_role','archivito_inc.operations','SELECT,INSERT,UPDATE,DELETE')
       and not has_function_privilege('service_role','public.sync_inc_step(uuid,text,jsonb,uuid,text)','EXECUTE')
       and not has_function_privilege('service_role','public.sync_inc_inspect(uuid,uuid,text,uuid,uuid,uuid)','EXECUTE')
       and not has_function_privilege('authenticated','public.sync_inc_cert_http(uuid,uuid,text,uuid,jsonb,uuid,uuid,uuid,text,bigint,uuid)','EXECUTE')
       and not has_function_privilege('anon','public.sync_inc_cert_http(uuid,uuid,text,uuid,jsonb,uuid,uuid,uuid,text,bigint,uuid)','EXECUTE')
       and not has_schema_privilege('authenticated','archivito_inc_cert_candidate','USAGE')
       and not has_function_privilege('service_role','archivito_inc_cert_candidate.claim(uuid,uuid,uuid,text,uuid,uuid,integer,text,bigint)','EXECUTE')
       and not has_function_privilege('service_role','archivito_inc_cert_candidate.lock_session(uuid,uuid)','EXECUTE')
       and not has_function_privilege('service_role','archivito_inc_cert_candidate.object_matches(text,bigint)','EXECUTE')
       and not has_function_privilege('authenticated','archivito_inc_cert_candidate.lock_session(uuid,uuid)','EXECUTE')
       and not has_function_privilege('authenticated','archivito_inc_cert_candidate.object_matches(text,bigint)','EXECUTE')
       and not has_function_privilege('anon','archivito_inc_cert_candidate.lock_session(uuid,uuid)','EXECUTE')
       and not has_function_privilege('anon','archivito_inc_cert_candidate.object_matches(text,bigint)','EXECUTE')
       and (select pg_get_userbyid(proowner)='archivito_cert_executor' and prosecdef
            from pg_proc where oid='archivito_inc_cert_candidate.dispatch(uuid,uuid,text,uuid,jsonb,uuid,uuid,uuid,text,bigint,uuid)'::regprocedure)
       and (select pg_get_userbyid(proowner)='e56_deploy_admin' and prosecdef and proconfig @> array['search_path=']
            from pg_proc where oid='archivito_inc_cert_candidate.lock_session(uuid,uuid)'::regprocedure)
       and (select pg_get_userbyid(proowner)='e56_deploy_admin' and prosecdef and proconfig @> array['search_path=']
            from pg_proc where oid='archivito_inc_cert_candidate.object_matches(text,bigint)'::regprocedure)
       and (select md5(prosrc)='d010b597b7cc21cae66b9fa09d01e3d0' and not prosecdef
            from pg_proc where oid='public.sync_inc_step(uuid,text,jsonb,uuid,text)'::regprocedure);
    """)=="t"
    x=fixture();w=wire(x);a,b,archive=x["a"],x["b"],x["archive"]
    sa,sb,sc,outsider=uid(),uid(),uid(),uid()
    run(f"insert into auth.sessions values({lit(sa)},{lit(a)},null),({lit(sb)},{lit(b)},null),({lit(sc)},{lit(outsider)},null);")
    claim=lambda actor,session: api(actor,session,"claim",archive,p_wire=w)
    run(claim(a,sb),error="certification session denied")
    run(claim(outsider,sc),error="certification denied")
    run("set role service_role; select public.sync_inc_step("+lit(a)+",'begin',"+lit(w)+"::jsonb);",error="permission denied")
    run("set role authenticated; select public.sync_inc_cert_http("+lit(a)+","+lit(sa)+",'claim',"+lit(archive)+","+lit(w)+"::jsonb);",error="permission denied")
    run(f"set role service_role; select * from archivito_inc.operations;",error="permission denied")
    f=json.loads(run(claim(a,sa)));assert f["result"]["state"]=="staging"
    token=dict(p_generation=f["generation"],p_token=f["token"])
    op=w["header"]["operationId"]
    intent=lambda session,**kw: api(a,session,"intent",archive,p_operation=op,**kw)
    run(intent(sa),error="certification fence denied")
    assert json.loads(run(intent(sa,**token)))==w
    run(api(b,sb,"intent",archive,p_operation=op,**token),error="certification fence denied")
    path=w["uploads"][0]["chunks"][0]["path"]
    # Negative Storage bridge checks before uploading exact object.
    run(api(a,sa,"attest",archive,p_wire=w,p_asset=x["asset"],p_hash=HASH,**token),error="bad attestation or missing object")
    run(f"insert into storage.objects values('other-bucket',{lit(path)},'{{\"size\":32}}');")
    run(f"insert into storage.objects values('archivito-inc-private',{lit(path)},'{{\"size\":31}}');")
    assert run(f"""set role archivito_cert_executor; select
      not {SC}.object_matches({lit(path)},32)
      and not {SC}.object_matches('../escape',32)
      and not {SC}.object_matches({lit(path[:-1]+'9')},31)
      and not {SC}.object_matches({lit(path)},0)
      and not {SC}.object_matches({lit(path)},4194305)
      and not {SC}.object_matches(null,32);""")=="t"
    run(api(a,sa,"attest",archive,p_wire=w,p_asset=x["asset"],p_hash=HASH,**token),error="bad attestation or missing object")
    run(f"update storage.objects set metadata='{{\"size\":32}}' where bucket_id='archivito-inc-private' and name={lit(path)};")
    assert run(f"set role archivito_cert_executor; select {SC}.object_matches({lit(path)},32);")=="t"
    r=json.loads(run(api(a,sa,"attest",archive,p_wire=w,p_asset=x["asset"],p_hash=HASH,**token)));assert r["state"]=="verified"
    r=json.loads(run(api(a,sa,"commit",archive,p_wire=w,**token)));assert r["state"]=="synced"
    assert counts(x)=="1"
    assert json.loads(run(api(b,sb,"head",archive,p_memory=MEMORY)))==w
    assert json.loads(run(api(b,sb,"catalog",archive,p_memory=MEMORY,p_operation=op,p_asset=x["asset"])))["ref"]["id"]==x["asset"]
    run(api(b,sb,"head",archive,p_memory=uid()),error="certification denied")
    # Lost acquisition: no reclaim while live; same operation only after expiry.
    run(claim(a,sa),error="certification lease denied")
    run(f"update {SC}.fences set lease_until=clock_timestamp()-interval '1 second' where operation_id={lit(op)};")
    new=json.loads(run(claim(a,sa)));assert new["generation"]==2 and new["result"]["replayed"] is True
    run(api(a,sa,"commit",archive,p_wire=w,**token),error="certification fence denied")
    run(f"update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id={lit(sb)};")
    run(api(b,sb,"head",archive,p_memory=MEMORY),error="certification session denied")
    run(f"delete from auth.sessions where id={lit(sa)};")
    run(api(a,sa,"head",archive,p_memory=MEMORY),error="certification session denied")
    print("PASS non-superuser deployed SQL candidate + private bridges: legacy denied, guarded claim/intent/attest/commit/read, stale fence, session expiry/revocation")
    print("LIMIT: synthetic auth/storage rows, service_role not a compromised-key boundary")


if __name__=="__main__":
    main()
