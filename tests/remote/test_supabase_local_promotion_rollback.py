"""E.5: local committed SQL promotion/rollback and two staged real Edge bundles.
No hosted deployment, no gate opening, no same-slug rollout simulation claim.
"""
import json
import os
from pathlib import Path
import tempfile
import time

from test_supabase_local_closed_stack import (
    Lab, ROOT, SOURCES, SC, ARCHIVE, MEMORY, KEY, BUCKET, FUNCTION, ORIGIN,
    Stop, require, passed, lit
)

LEGACY=FUNCTION+"-legacy-lab"
STEP="public.sync_inc_step(uuid,text,jsonb,uuid,text)"
INSPECT="public.sync_inc_inspect(uuid,uuid,text,uuid,uuid,uuid)"
RPC="public.sync_inc_cert_http(uuid,uuid,text,uuid,jsonb,uuid,uuid,uuid,text,bigint,uuid)"
EXECUTOR="archivito_cert_executor"
TABLES=("gates","operations","manifests","heads","assets","blocks","refs","holds")
MANAGED=(("public","archives"),("public","archive_members"),("auth","sessions"),("storage","objects"))

class PromotionLab(Lab):
    def configure(self):
        super().configure()
        target=self.work/"supabase/functions"/LEGACY/"index.ts"
        target.parent.mkdir()
        # Immutable historical source, no duplicated handler and no network fetch.
        legacy_sha="3e3f7eaf501f5f1252f549203cc6c96f4eadc572"
        path="supabase/functions/"+FUNCTION+"/index.ts"
        source=self.cmd(["git","-C",str(ROOT),"show",legacy_sha+":"+path]).stdout
        old="../../../server/sync-incremental-service.mjs"
        require(source.count(old)==1,"legacy import anchor")
        target.write_text(source.replace(old,"../_shared/archivito/server/sync-incremental-service.mjs"))
        conf=self.work/"supabase/config.toml"
        with conf.open("a") as out:out.write("\n[functions."+LEGACY+"]\nverify_jwt = false\n")
        passed("legacy and candidate Edge packages staged in distinct local slots")
    def invariant(self,sessions):
        require(self.sql(f"""select
          (select count(*) from auth.users)=3 and (select count(*) from auth.sessions)={sessions}
          and (select count(*) from public.archives)=1 and (select count(*) from public.archive_members)=2
          and (select count(*) from archivito_inc.gates where archive_id={lit(ARCHIVE)} and not enabled)=1
          and not exists(select 1 from archivito_inc.gates where enabled)
          and exists(select 1 from pg_constraint where conrelid='archivito_inc.gates'::regclass
            and conname='inc_gate_hard_closed' and convalidated and pg_get_constraintdef(oid)='CHECK ((NOT enabled))')
          and not exists(select 1 from archivito_inc.operations)
          and not exists(select 1 from archivito_inc.manifests)
          and not exists(select 1 from archivito_inc.heads)
          and not exists(select 1 from archivito_inc.assets)
          and not exists(select 1 from archivito_inc.blocks)
          and not exists(select 1 from archivito_inc.refs)
          and not exists(select 1 from archivito_inc.holds)
          and not exists(select 1 from storage.objects where bucket_id='{BUCKET}')
          and exists(select 1 from storage.buckets where id='{BUCKET}' and not public
            and file_size_limit=4194304 and allowed_mime_types=array['application/octet-stream']);""")=="t","promotion hard-closed invariants")
    def snapshot(self):
        # Compare canonical catalog contents, not OIDs/order or textual ACL arrays.
        # Includes grantor/grantee, grant option, column grants, policies and
        # core function definitions; no personal data, raw snapshot never logged.
        q="""with rels as (
          select c.*,n.nspname from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where (n.nspname='archivito_inc' and c.relkind='r')
             or (n.nspname,c.relname) in (('public','archives'),('public','archive_members'),('auth','sessions'),('storage','objects'))
        ), funcs as (
          select p.* from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname in ('sync_inc_step','sync_inc_inspect')
        ), facts as (
          select jsonb_build_array('schema',n.nspname,pg_get_userbyid(n.nspowner),a.grantor,a.grantee,a.privilege_type,a.is_grantable) v
          from pg_namespace n cross join lateral aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a where n.nspname='archivito_inc'
          union all select jsonb_build_array('rel',nspname,relname,pg_get_userbyid(relowner),relrowsecurity,relforcerowsecurity) from rels
          union all select jsonb_build_array('table_acl',r.nspname,r.relname,a.grantor,a.grantee,a.privilege_type,a.is_grantable)
          from rels r cross join lateral aclexplode(coalesce(r.relacl,acldefault('r',r.relowner))) a
          union all select jsonb_build_array('column_acl',r.nspname,r.relname,c.attname,a.grantor,a.grantee,a.privilege_type,a.is_grantable)
          from rels r join pg_attribute c on c.attrelid=r.oid cross join lateral aclexplode(c.attacl) a where c.attnum>0 and not c.attisdropped
          union all select jsonb_build_array('function',proname,pg_get_function_identity_arguments(oid),pg_get_userbyid(proowner),md5(pg_get_functiondef(oid))) from funcs
          union all select jsonb_build_array('function_acl',p.proname,a.grantor,a.grantee,a.privilege_type,a.is_grantable)
          from funcs p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          union all select jsonb_build_array('policy',p.schemaname,p.tablename,p.policyname,p.permissive,p.roles,p.cmd,p.qual,p.with_check)
          from pg_policies p join rels r on r.nspname=p.schemaname and r.relname=p.tablename
          union all select jsonb_build_array('constraint',r.nspname,r.relname,c.conname,c.convalidated,pg_get_constraintdef(c.oid))
          from rels r join pg_constraint c on c.conrelid=r.oid
        ) select coalesce(jsonb_agg(v order by v::text),'[]'::jsonb)::text from facts;"""
        return json.loads(self.sql(q))
    def legacy_state(self,baseline):
        self.invariant(0)
        require(self.sql(f"""select to_regnamespace('{SC}') is null
          and to_regprocedure('{RPC}') is null and not exists(select 1 from pg_roles where rolname='{EXECUTOR}')
          and has_schema_privilege('service_role','archivito_inc','USAGE')
          and has_function_privilege('service_role','{STEP}','EXECUTE')
          and has_function_privilege('service_role','{INSPECT}','EXECUTE')
          and not has_function_privilege('anon','{STEP}','EXECUTE')
          and not has_function_privilege('authenticated','{INSPECT}','EXECUTE');""")=="t","legacy privilege state")
        require(self.snapshot()==baseline,"legacy catalog snapshot mismatch")
        passed("legacy catalog, ACL, policies and core functions exactly restored")
    def candidate_source(self):
        # Never copy the two already installed core scripts into promotion.
        return "\n".join((ROOT/"docs/sql"/n).read_text() for n in SOURCES[2:])
    def wait_rpc(self,actor,session,promoted):
        for _ in range(20):
            if promoted:
                status,_,d=self.rpc("sync_inc_cert_http",self.service,self.service,
                  {"p_actor":actor,"p_session":session,"p_action":"head","p_archive":ARCHIVE,"p_memory":MEMORY})
                if status==403 and isinstance(d,dict) and d.get("code")=="42501" and d.get("message")=="certification denied":return
            else:
                status,_,d=self.rpc("sync_inc_inspect",self.service,self.service,
                  {"p_actor":actor,"p_archive":ARCHIVE,"p_action":"head","p_memory":MEMORY})
                if status==400 and isinstance(d,dict) and d.get("code")=="P0001" and d.get("message")=="disabled":return
            time.sleep(1)
        raise Stop("PostgREST expected closed RPC not reached")
    def slot(self,slug,token):
        return self.request("/functions/v1/"+slug+"?action=manifest",self.anon,token,
           {"archiveId":ARCHIVE,"memoryId":MEMORY,"operationId":None},extra={"Origin":ORIGIN})
    def phase_probes(self,name,promoted):
        self.invariant(0)
        # Distinguish the two real handlers by their declared preflight headers.
        for slug,has_fence in ((LEGACY,False),(FUNCTION,True)):
            status,h,d=self.request("/functions/v1/"+slug,self.anon,None,method="OPTIONS",extra={"Origin":ORIGIN,
              "Access-Control-Request-Method":"POST"})
            require(status==204 and d is None and h.get_all("Access-Control-Allow-Origin")==[ORIGIN]
                    and h.get_all("Cache-Control")==["no-store"],"slot preflight")
            require(("x-archivito-fence" in h.get("Access-Control-Allow-Headers","").lower())==has_fence,"distinct slot contract")
        for label in "ABC":
            token,session=self.login(label)
            try:
                self.wait_rpc(self.users[label],session,promoted)
                args={"p_actor":self.users[label],"p_archive":ARCHIVE,"p_action":"head","p_memory":MEMORY}
                if promoted:
                    status,_,d=self.rpc("sync_inc_inspect",self.service,self.service,args)
                    self.negative(status,d,"legacy RPC disabled in promoted phase")
                else:
                    status,_,d=self.rpc("sync_inc_cert_http",self.service,self.service,
                      {"p_actor":self.users[label],"p_session":session,"p_action":"head","p_archive":ARCHIVE,"p_memory":MEMORY})
                    for _ in range(20):
                        if status==404 and isinstance(d,dict) and d.get("code")=="PGRST202":break
                        time.sleep(1)
                        status,_,d=self.rpc("sync_inc_cert_http",self.service,self.service,
                          {"p_actor":self.users[label],"p_session":session,"p_action":"head","p_archive":ARCHIVE,"p_memory":MEMORY})
                    else:raise Stop("candidate RPC absent after schema reload")
                # Both bundles must fail closed in every intermediate state.
                for slug in (LEGACY,FUNCTION):
                    self.check_edge(name+" "+slug+" "+label,*self.slot(slug,token),403)
                self.invariant(1)
            finally:
                status,_,_=self.request("/auth/v1/logout?scope=local",self.anon,token,{},method="POST")
                require(status in (200,204),"phase logout")
            self.invariant(0)
        passed(name+" A/B/C legacy and candidate HTTP slots fail closed; expected real RPC verified")
    def promote(self):
        a,b=(lit(self.users[k]) for k in "AB")
        self.sql("begin;\n"+self.candidate_source()+f"""
          insert into {SC}.windows values('73ac551b-2df8-4da7-91b8-4adf18d83990',{lit(ARCHIVE)},{a},{b},{lit(KEY)},
              statement_timestamp(),statement_timestamp()+interval '15 minutes',false,67108864,24);
          notify pgrst,'reload schema';
          commit;""")
        self.audit(0)
        # Confirm no legacy API role has effective column UPDATE access, not merely no schema USAGE.
        require(self.sql("""select not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='archivito_inc' and c.relkind='r' and has_any_column_privilege('service_role',c.oid,'UPDATE'));""")=="t","residual legacy column UPDATE ACL")
        passed("candidate SQL committed locally with closed window and ACL")
    def rollback(self):
        self.audit(0)
        # Only candidate role and candidate policies in this unique local DB.
        # Fail if any unknown policy or nonempty candidate operational state.
        expected=set()
        for schema,table in MANAGED:
            expected.add((schema,table,"inc_cert_exec_read"))
            if table!="objects":
                expected.add((schema,table,"inc_cert_exec_lock"))
                expected.add((schema,table,"inc_cert_exec_no_mutation"))
        for table in TABLES:
            expected.add(("archivito_inc",table,"inc_cert_exec_read"))
            if table in ("operations","manifests","heads","assets","blocks","refs"):
                expected.add(("archivito_inc",table,"inc_cert_exec_insert"))
            if table in ("operations","manifests","heads","assets","blocks"):
                expected.add(("archivito_inc",table,"inc_cert_exec_update"))
        expected|={("archivito_inc","gates","inc_cert_exec_lock"),("archivito_inc","gates","inc_cert_exec_no_mutation")}
        rows=json.loads(self.sql("""select coalesce(jsonb_agg(jsonb_build_array(schemaname,tablename,policyname)),'[]'::jsonb)
           from pg_policies where 'archivito_cert_executor'=any(roles) and schemaname<>'archivito_inc_cert_candidate';"""))
        require({tuple(x) for x in rows}==expected,"unexpected candidate policies; rollback refused")
        # Drop known candidate functions explicitly before tables/schema, no
        # CASCADE on public or managed schemas. Restrict detects external dependencies.
        functions=json.loads(self.sql(f"""select jsonb_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text)
          from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='{SC}';"""))
        require(len(functions)==9,"unexpected candidate function count")
        order=("dispatch","actor_guard","lock_actor_context","fenced_step","claim_begin","wire_identity","assert_fence","claim","guard_window")
        require(all(sum(x.startswith(SC+"."+name+"(") for x in functions)==1 for name in order),"unexpected candidate function names")
        drops="\n".join("drop policy "+policy+" on "+schema+"."+table+";" for schema,table,policy in sorted(expected))
        for name in order:
            drops+="\ndrop function "+next(x for x in functions if x.startswith(SC+"."+name+"("))+";"
        # Exact legacy grants derived from already certified source; no broad
        # ACL reset, no removal of data-bearing core/managed tables.
        grants="\n".join(line for n in SOURCES[:2] for line in (ROOT/"docs/sql"/n).read_text().splitlines()
                         if line.startswith("grant ") and line.endswith(" to service_role;"))
        require(len(grants.splitlines())==11,"legacy grant source count")
        self.sql("begin;\n"+f"drop function {RPC};\n"+drops+f"""
          drop table {SC}.fences;
          drop table {SC}.windows;
          drop schema {SC};
          drop owned by {EXECUTOR};
          drop role {EXECUTOR};
          {grants}
          notify pgrst,'reload schema';
          commit;""")
        passed("committed rollback SQL executed locally")
    def restricted_bridge_probe(self,baseline):
        # Disposable transaction only: emulate the relevant existing hosted
        # privileges, not hosted platform ownership or a deployable candidate.
        token,session=self.login("A")
        try:
            q=f"""begin;
              create role e5_probe_admin nologin nosuperuser noinherit bypassrls;
              create role e5_probe_executor nologin nosuperuser noinherit nobypassrls;
              grant usage on schema auth,storage to e5_probe_admin;
              grant select(id,user_id,not_after),update(id) on auth.sessions to e5_probe_admin;
              grant select(bucket_id,name,metadata) on storage.objects to e5_probe_admin;
              create schema e5_probe_private authorization e5_probe_admin;
              set local role e5_probe_admin;
              revoke all on schema e5_probe_private from public;
              grant usage on schema e5_probe_private to e5_probe_executor;
              create function e5_probe_private.lock_session(p_actor uuid,p_session uuid)
              returns void language plpgsql security definer set search_path='' as $e5_bridge$
              begin
                perform 1 from auth.sessions
                  where id=p_session and user_id=p_actor and (not_after is null or not_after>clock_timestamp())
                  for share;
                if not found then raise exception using errcode='42501',message='certification session denied';end if;
              end $e5_bridge$;
              create function e5_probe_private.object_matches(p_path text,p_size bigint)
              returns boolean language sql security definer set search_path='' as $e5_bridge$
                select exists(select 1 from storage.objects where bucket_id='archivito-inc-private'
                  and name=p_path and (metadata->>'size')::bigint=p_size);
              $e5_bridge$;
              revoke all on all functions in schema e5_probe_private from public,anon,authenticated,service_role;
              grant execute on function e5_probe_private.lock_session(uuid,uuid),e5_probe_private.object_matches(text,bigint) to e5_probe_executor;
              reset role;
              do $e5_bridge$
              begin
                if (select rolsuper or not rolbypassrls from pg_roles where rolname='e5_probe_admin')
                  or (select rolsuper or rolbypassrls or rolcanlogin from pg_roles where rolname='e5_probe_executor')
                  or has_schema_privilege('e5_probe_admin','auth','USAGE WITH GRANT OPTION')
                  or has_column_privilege('e5_probe_admin','auth.sessions','id','UPDATE WITH GRANT OPTION')
                  or has_column_privilege('e5_probe_executor','auth.sessions','id','SELECT')
                  or has_column_privilege('e5_probe_executor','auth.sessions','id','UPDATE')
                  or has_column_privilege('e5_probe_executor','storage.objects','metadata','SELECT')
                  or has_table_privilege('e5_probe_executor','storage.objects','INSERT,UPDATE,DELETE,TRUNCATE')
                  or exists(select 1 from unnest(array['anon','authenticated','service_role']) r(role_name)
                    where has_function_privilege(r.role_name,'e5_probe_private.lock_session(uuid,uuid)','EXECUTE')
                       or has_function_privilege(r.role_name,'e5_probe_private.object_matches(text,bigint)','EXECUTE')
                       or pg_has_role(r.role_name,'e5_probe_executor','MEMBER'))
                then raise exception 'bridge ACL mismatch';end if;
              end $e5_bridge$;
              set local role e5_probe_executor;
              select e5_probe_private.lock_session({lit(self.users['A'])},{lit(session)});
              do $e5_bridge$
              begin
                begin
                  perform e5_probe_private.lock_session({lit(self.users['B'])},{lit(session)});
                  raise exception 'cross-actor session accepted';
                exception when insufficient_privilege then
                  if sqlerrm<>'certification session denied' then raise;end if;
                end;
                if e5_probe_private.object_matches('synthetic-absent',32)
                then raise exception 'nonexistent object matched';end if;
              end $e5_bridge$;
              rollback;"""
            self.sql(q)
            passed("restricted non-superuser private bridges: exact session lock, cross-actor denial, absent object, API ACL; transaction reverted")
        finally:
            status,_,_=self.request("/auth/v1/logout?scope=local",self.anon,token,{},method="POST")
            require(status in (200,204),"bridge probe logout")
        require(self.sql("""select to_regnamespace('e5_probe_private') is null
          and not exists(select 1 from pg_roles where rolname in ('e5_probe_admin','e5_probe_executor'));""")=="t","bridge probe objects remain")
        self.legacy_state(baseline)
    def probe(self):
        self.cors_isolation()
        baseline=self.snapshot()
        self.legacy_state(baseline)
        self.phase_probes("BASELINE",False)
        self.restricted_bridge_probe(baseline)
        # Force a transaction failure after candidate SQL but before commit.
        r=self.sql("begin;\n"+self.candidate_source()+"\nselect 1/0;\ncommit;",allow_fail=True)
        require(r.returncode!=0 and "division by zero" in r.stderr,"injected promotion failure not reached")
        self.legacy_state(baseline)
        passed("injected SQL failure rolled back all candidate DDL and ACL")
        self.promote()
        self.phase_probes("PROMOTED",True)
        self.rollback()
        self.legacy_state(baseline)
        self.phase_probes("ROLLED BACK",False)
        # Reapply unchanged candidate after successful rollback to prove re-runnability.
        self.promote()
        self.phase_probes("REPROMOTED",True)
        self.rollback()
        self.legacy_state(baseline)
        self.phase_probes("FINAL ROLLBACK",False)
        status,_,d=self.request("/storage/v1/object/list/"+BUCKET,self.service,self.service,{"prefix":"","limit":100,"offset":0})
        require(status==200 and d==[],"final Storage list")
        passed("E5 committed promotion/rollback twice, exact catalog restored, zero incremental objects")

def main():
    require(os.environ.get("GITHUB_ACTIONS")=="true" and os.environ.get("ARCHIVITO_DISPOSABLE_LAB")=="supabase-e5","CI disposable E5 only")
    with tempfile.TemporaryDirectory(prefix="archivito-e5-") as d:
        lab=PromotionLab(Path(d))
        try:
            lab.configure()
            lab.start()
            lab.provision(candidate=False)
            lab.probe()
        finally:
            lab.stop()
    passed("E5 local SQL rollback rehearsal; dual Edge slots only, hosted promotion not certified")

if __name__=="__main__":
    try:main()
    except Stop as e:raise SystemExit("STOP: "+str(e)) from None
    except Exception as e:raise SystemExit("STOP: "+type(e).__name__) from None
