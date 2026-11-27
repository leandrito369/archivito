"""Closed-gate administrative concurrency and effective ACL regression.
Runs only after the closed-runtime test initialized the disposable CI database.
No enabled window, no gate opening, no Auth/Storage hosted access.
"""
import os
import time
from test_incremental_closed_runtime import ARCHIVE, ACTORS, SESSIONS, OP, KEY, SC, closed
from test_incremental_cert_multisession import run, hold, waiter, release, finish, lit

EXEC="archivito_cert_executor"
A=lit(ACTORS["A"])
B=lit(ACTORS["B"])
SA=lit(SESSIONS["A"])
SB=lit(SESSIONS["B"])
AR=lit(ARCHIVE)
W=lit(OP)
K=lit(KEY)
HELPER=f"{SC}.lock_actor_context(uuid,uuid,uuid,text,text)"
def context(actor=A,session=SA,role="owner",key=K):
    return (f"set role {EXEC}; select id from {SC}.windows where id={W} for update;"
            f"select {SC}.lock_actor_context({actor},{session},{AR},{lit(role)},{key});")
def check_context(*args, error=None):
    return run('begin;'+context(*args)+'commit;',error=error)

def restore_member():
    run(f"insert into public.archive_members values({AR},{A},'owner');")
def restore_session():
    run(f"insert into auth.sessions values({SA},{A},null);")
def check_acl():
    assert run(f"""select
      not pg_has_role('service_role','{EXEC}','MEMBER')
      and not pg_has_role('authenticated','{EXEC}','MEMBER')
      and not pg_has_role('anon','{EXEC}','MEMBER')
      and not has_function_privilege('service_role','{HELPER}','EXECUTE')
      and not has_function_privilege('anon','{HELPER}','EXECUTE')
      and not has_function_privilege('authenticated','{HELPER}','EXECUTE')
      and has_function_privilege('{EXEC}','{HELPER}','EXECUTE')
      and not has_schema_privilege('service_role','archivito_inc','USAGE')
      and not has_function_privilege('service_role','public.sync_inc_step(uuid,text,jsonb,uuid,text)','EXECUTE')
      and not has_function_privilege('service_role','public.sync_inc_inspect(uuid,uuid,text,uuid,uuid,uuid)','EXECUTE')
      and not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace,
      lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where (n.nspname='{SC}' or (n.nspname='public' and p.proname='sync_inc_cert_http')) and a.grantee=0 and a.privilege_type='EXECUTE')
      and (select not rolcanlogin and not rolbypassrls and not rolsuper and not rolcreaterole and not rolcreatedb from pg_roles where rolname='{EXEC}')
      and not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('archivito_inc','{SC}','auth','storage','public') and c.relowner=(select oid from pg_roles where rolname='{EXEC}') and c.relkind='r')
      and not has_schema_privilege('{EXEC}','auth','USAGE')
      and not has_schema_privilege('{EXEC}','storage','USAGE')
      and not has_schema_privilege('{EXEC}','{SC}','CREATE')
      and not has_column_privilege('{EXEC}','auth.sessions','id','SELECT')
      and not has_column_privilege('{EXEC}','auth.sessions','id','UPDATE')
      and not has_column_privilege('{EXEC}','auth.sessions','not_after','UPDATE')
      and not has_column_privilege('{EXEC}','storage.objects','metadata','SELECT')
      and not has_column_privilege('{EXEC}','public.archives','key_fingerprint','UPDATE')
      and not has_column_privilege('{EXEC}','public.archive_members','role','UPDATE')
      and not has_table_privilege('{EXEC}','storage.objects','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
      and not has_table_privilege('{EXEC}','auth.sessions','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
      and not exists(select 1 from pg_policies where '{EXEC}'=any(roles) and schemaname in ('auth','storage'))
      and not has_function_privilege('service_role','{SC}.lock_session(uuid,uuid)','EXECUTE')
      and not has_function_privilege('authenticated','{SC}.lock_session(uuid,uuid)','EXECUTE')
      and not has_function_privilege('anon','{SC}.lock_session(uuid,uuid)','EXECUTE')
      and not has_function_privilege('service_role','{SC}.object_matches(text,bigint)','EXECUTE')
      and not has_function_privilege('authenticated','{SC}.object_matches(text,bigint)','EXECUTE')
      and not has_function_privilege('anon','{SC}.object_matches(text,bigint)','EXECUTE')
      and (select md5(prosrc)='d010b597b7cc21cae66b9fa09d01e3d0' from pg_proc where oid='public.sync_inc_step(uuid,text,jsonb,uuid,text)'::regprocedure)
      and not has_table_privilege('{EXEC}','public.archives','INSERT,DELETE,TRUNCATE')
      and not has_table_privilege('{EXEC}','public.archive_members','INSERT,DELETE,TRUNCATE')
      and not has_table_privilege('{EXEC}','archivito_inc.gates','INSERT,DELETE,TRUNCATE')
      and not has_table_privilege('{EXEC}','{SC}.windows','INSERT,DELETE,TRUNCATE')
      and not has_table_privilege('{EXEC}','archivito_inc.operations','DELETE,TRUNCATE')
      and not has_table_privilege('{EXEC}','{SC}.fences','DELETE,TRUNCATE')
      and (select proconfig @> array['lock_timeout=5s'] and pg_get_userbyid(proowner)='{EXEC}' from pg_proc where oid='{SC}.dispatch(uuid,uuid,text,uuid,jsonb,uuid,uuid,uuid,text,bigint,uuid)'::regprocedure);""")=="t"
    print("PASS effective ACL, no PUBLIC EXECUTE or client/legacy/managed direct access",flush=True)

def check_lock_only():
    # Model an accidentally permissive future policy. The restrictive policy
    # must still deny a no-op UPDATE on owned tables; managed tables have no
    # direct table/column privileges at all.
    rows=[
      ("public.archives","id=id",f"id={AR}"),
      ("public.archive_members","user_id=user_id",f"archive_id={AR} and user_id={A}"),
      ("archivito_inc.gates","enabled=false",f"archive_id={AR}"),
      (f"{SC}.windows","enabled=false",f"id={W}")]
    for table,assignment,where in rows:
        run(f"create policy lab_permissive on {table} for update to {EXEC} using(true) with check(true);")
        run(f"set role {EXEC}; update {table} set {assignment} where {where};",error="row-level security policy")
        run(f"drop policy lab_permissive on {table};")
    run(f"set role {EXEC}; select id from auth.sessions where id={SA};",error="permission denied")
    run(f"set role {EXEC}; update auth.sessions set id=id where id={SA};",error="permission denied")
    run(f"set role {EXEC}; select name from storage.objects;",error="permission denied")
    check_context()
    check_context(B,SB,"editor")
    check_context(A,SB,error="certification session denied")
    check_context(B,SB,"owner",error="certification membership denied")
    print("PASS restrictive RLS on owned tables, direct managed denial, private bridge locks and identity checks work",flush=True)

def admin_wins(mutation,error,restore,tag):
    # Admin locks gate first; candidate holds window and waits at the gate.
    # The mutation must succeed while candidate is waiting, proving it did
    # not prematurely acquire a conflicting authz row lock.
    h=hold(f"select archive_id from archivito_inc.gates where archive_id={AR} for update;")
    p=waiter(context())
    h.stdin.write(mutation+"\n");h.stdin.flush()
    release(h)
    finish(p,error)
    run(restore)
    assert closed()
    print("PASS gate-first admin "+tag+" wins without deadlock",flush=True)

def main():
    if os.environ.get("GITHUB_ACTIONS")!="true" or os.environ.get("ARCHIVITO_DISPOSABLE_LAB")!="closed-runtime":
        raise SystemExit("CI disposable runtime only")
    assert closed()
    check_acl()
    check_lock_only()
    admin_wins(f"delete from public.archive_members where archive_id={AR} and user_id={A};",
               "certification membership denied",f"insert into public.archive_members values({AR},{A},'owner');","membership removal")
    admin_wins(f"update public.archives set key_fingerprint={lit('b'*64)} where id={AR};",
               "certification membership denied",f"update public.archives set key_fingerprint={K} where id={AR};","key rotation")
    admin_wins(f"delete from auth.sessions where id={SA};",
               "certification session denied",f"insert into auth.sessions values({SA},{A},null);","session revocation")
    # Logout wins by locking session before candidate gets to the session row.
    h=hold(f"delete from auth.sessions where id={SA};")
    p=waiter(context())
    release(h);finish(p,"certification session denied");restore_session()
    # Reverse order: a context holds SHARE on session; logout waits, then
    # completes. Next context must reject the revoked session.
    h=hold(context())
    p=waiter(f"delete from auth.sessions where id={SA};")
    release(h);finish(p)
    check_context(error="certification session denied");restore_session()
    print("PASS logout linearization in both orders; subsequent context rejected",flush=True)
    run(f"update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id={SA};")
    check_context(error="certification session denied")
    # Session expires naturally while lock_actor_context waits on the gate lock.
    run(f"update auth.sessions set not_after=clock_timestamp()+interval '2 seconds' where id={SA};")
    h=hold(f"select archive_id from archivito_inc.gates where archive_id={AR} for update;")
    p=waiter(context())
    time.sleep(2.3)
    release(h);finish(p,"certification session denied")
    run(f"update auth.sessions set not_after=null where id={SA};")
    print("PASS session expiry under lock wait rejected by lock_session",flush=True)
    # Window remains closed; actual dispatch must never return data.
    run(f"set role service_role; select public.sync_inc_cert_http({A},{SA},'head',{AR},p_memory=>{lit('73ac551b-2df8-4da7-91b8-4adf18d83901')});",error="certification denied")
    assert closed()
    print("PASS expired session and actual closed dispatch; zero fences/operations/heads/objects; gate intact",flush=True)
    print("LIMIT helper tested separately under dedicated role; no open-gate transaction or managed Auth/Storage proof",flush=True)
if __name__=="__main__": main()
