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
    """)
    run((ROOT/"docs/sql/cloud_03_5c3b3d3_http_acl_candidate.sql").read_text())
    assert run("""
       select not rolcanlogin and not rolbypassrls and not rolinherit
       from pg_roles where rolname='archivito_cert_executor';
    """)=="t"
    assert run("""
       select not pg_has_role('service_role','archivito_cert_executor','MEMBER')
       and not has_schema_privilege('service_role','archivito_inc','USAGE')
       and not has_table_privilege('service_role','archivito_inc.operations','SELECT,INSERT,UPDATE,DELETE')
       and not has_function_privilege('service_role','public.sync_inc_step(uuid,text,jsonb,uuid,text)','EXECUTE')
       and not has_function_privilege('service_role','public.sync_inc_inspect(uuid,uuid,text,uuid,uuid,uuid)','EXECUTE')
       and not has_function_privilege('authenticated','public.sync_inc_cert_http(uuid,uuid,text,uuid,jsonb,uuid,uuid,uuid,text,bigint,uuid)','EXECUTE')
       and not has_function_privilege('anon','public.sync_inc_cert_http(uuid,uuid,text,uuid,jsonb,uuid,uuid,uuid,text,bigint,uuid)','EXECUTE')
       and not has_schema_privilege('authenticated','archivito_inc_cert_candidate','USAGE')
       and not has_function_privilege('service_role','archivito_inc_cert_candidate.claim(uuid,uuid,uuid,text,uuid,uuid,integer,text,bigint)','EXECUTE');
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
    run(f"insert into storage.objects values('archivito-inc-private',{lit(path)},'{{\"size\":32}}');")
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
    print("PASS least-privilege SQL candidate: legacy denied, guarded claim/intent/attest/commit/read, stale fence, session expiry/revocation")
    print("LIMIT: synthetic auth/storage rows, service_role not a compromised-key boundary")


if __name__=="__main__":
    main()
