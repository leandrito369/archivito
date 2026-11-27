"""CI-only closed-gate integration: actual Edge entrypoint + SDK + PG RPC.
Auth/REST gateway are localhost doubles; Storage must not be reached.
No Supabase hosted URL, credentials or gate-opening DDL.
"""
import base64
import json
import os
from pathlib import Path
import subprocess
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from test_incremental_cert_multisession import ROOT, SC, KEY, MEMORY, lit, run, cmd

ARCHIVE="73ac551b-2df8-4da7-91b8-4adf18d83900"
ACTORS={k:f"00000000-0000-4000-8000-00000000000{i}" for i,k in enumerate("ABC",1)}
SESSIONS={k:f"00000000-0000-4000-9000-00000000000{i}" for i,k in enumerate("ABC",1)}
OP="00000000-0000-4000-a000-000000000001"
ORIGIN="http://localhost:8000"
def token(k):
    p=base64.urlsafe_b64encode(json.dumps({"sub":ACTORS[k],"session_id":SESSIONS[k],"role":"authenticated"}).encode()).decode().rstrip("=")
    return "e30."+p+".synthetic"
TOKENS={token(k):k for k in ACTORS}
ENTRY=ROOT/"supabase/functions/archivito-sync-incremental/index.ts"
RPC_ARGS={"p_actor","p_session","p_action","p_archive","p_wire","p_memory","p_operation","p_asset","p_hash","p_generation","p_token"}
calls=[]
violations=[]
def setup():
    if os.environ.get("GITHUB_ACTIONS")!="true" or os.environ.get("ARCHIVITO_DISPOSABLE_LAB")!="closed-runtime":
        raise SystemExit("CI disposable runtime only")
    run("""
      create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls;
      create table public.archives(id uuid primary key,key_fingerprint text);
      create table public.archive_members(archive_id uuid,user_id uuid,role text);
      create schema auth;
      create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
      create schema storage;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));
      alter table auth.sessions enable row level security;
      alter table public.archives enable row level security;
      alter table public.archive_members enable row level security;
      alter table storage.objects enable row level security;
    """)
    for name in ("cloud_03_5c3b2a_closed_rpc.sql","cloud_03_5c3b2b_storage_catalog.sql",
                 "cloud_03_5c3b3d_cert_fence_candidate.sql","cloud_03_5c3b3d_fenced_rpc_candidate.sql",
                 "cloud_03_5c3b3d3_http_acl_candidate.sql"):
        run((ROOT/"docs/sql"/name).read_text())
    run(f"""
      insert into public.archives values({lit(ARCHIVE)},{lit(KEY)});
      insert into public.archive_members values({lit(ARCHIVE)},{lit(ACTORS['A'])},'owner'),({lit(ARCHIVE)},{lit(ACTORS['B'])},'editor');
      insert into archivito_inc.gates(archive_id,enabled) values({lit(ARCHIVE)},false);
      insert into {SC}.windows values({lit(OP)},{lit(ARCHIVE)},{lit(ACTORS['A'])},{lit(ACTORS['B'])},{lit(KEY)},clock_timestamp(),clock_timestamp()+interval '10 minutes',false,67108864,24);
    """)
    for k in ACTORS:
        run(f"insert into auth.sessions values({lit(SESSIONS[k])},{lit(ACTORS[k])},null);")
    assert run(f"""select not has_function_privilege('service_role','public.sync_inc_step(uuid,text,jsonb,uuid,text)','EXECUTE')
      and not has_function_privilege('service_role','public.sync_inc_inspect(uuid,uuid,text,uuid,uuid,uuid)','EXECUTE')
      and not has_schema_privilege('service_role','archivito_inc','USAGE')
      and not pg_has_role('service_role','archivito_cert_executor','MEMBER')
      and not has_function_privilege('authenticated','public.sync_inc_cert_http(uuid,uuid,text,uuid,jsonb,uuid,uuid,uuid,text,bigint,uuid)','EXECUTE')
      and not has_function_privilege('anon','public.sync_inc_cert_http(uuid,uuid,text,uuid,jsonb,uuid,uuid,uuid,text,bigint,uuid)','EXECUTE')
      and (select not rolcanlogin and not rolbypassrls from pg_roles where rolname='archivito_cert_executor');""")=="t"
    run(f"update archivito_inc.gates set enabled=true where archive_id={lit(ARCHIVE)};",error="inc_gate_hard_closed")
    assert closed()
def closed():
    return run(f"""select exists(select 1 from pg_constraint where conrelid='archivito_inc.gates'::regclass and conname='inc_gate_hard_closed' and convalidated and pg_get_constraintdef(oid)='CHECK ((NOT enabled))')
       and not exists(select 1 from archivito_inc.gates where enabled)
       and not exists(select 1 from {SC}.windows where enabled)
       and not exists(select 1 from {SC}.fences)
       and not exists(select 1 from archivito_inc.operations)
       and not exists(select 1 from archivito_inc.heads)
       and not exists(select 1 from storage.objects);""")=="t"
class Gateway(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def reply(self,status,body):
        b=json.dumps(body).encode()
        self.send_response(status);self.send_header("Content-Type","application/json");self.send_header("Content-Length",str(len(b)));self.end_headers();self.wfile.write(b)
    def do_GET(self):
        if self.path=="/auth/v1/user":
            k=TOKENS.get(self.headers.get("Authorization","").removeprefix("Bearer "))
            if k: return self.reply(200,{"id":ACTORS[k],"aud":"authenticated","role":"authenticated","email":f"synthetic-{k.lower()}@example.com","app_metadata":{},"user_metadata":{},"created_at":"2026-01-01T00:00:00Z"})
            return self.reply(403,{"code":"bad_jwt","msg":"synthetic rejection"})
        violations.append("unexpected GET");self.reply(500,{"error":"unexpected"})
    def do_POST(self):
        if self.path!="/rest/v1/rpc/sync_inc_cert_http":
            violations.append("unexpected POST");return self.reply(500,{"error":"unexpected"})
        try:
            d=json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if not (set(d)<=RPC_ARGS and d["p_archive"]==ARCHIVE):
                raise ValueError("unexpected rpc scope")
            k=next(k for k in ACTORS if ACTORS[k]==d["p_actor"])
            if d["p_session"]!=SESSIONS[k] or d["p_action"] not in ("head","intent"):
                raise ValueError("unexpected rpc session or action")
            # Typed parameters rendered from local synthetic test request only.
            # psql uses fixed function name and allowlisted argument identifiers.
            args=[]
            for name,value in d.items():
                if value is None: val="null"
                elif name=="p_generation" and type(value) is int: val=str(value)
                elif name=="p_wire": val=lit(value)+"::jsonb"
                else: val=lit(value)
                args.append(name+"=>"+val)
            sql="set role service_role; select public.sync_inc_cert_http("+",".join(args)+");"
            r=subprocess.run(cmd(),input=sql,text=True,capture_output=True,timeout=20)
            calls.append((k,d["p_action"],r.returncode!=0 and "certification denied" in r.stderr))
            if r.returncode:
                if "certification denied" not in r.stderr: violations.append("unexpected SQL error: "+r.stderr[:500])
                return self.reply(403,{"code":"42501","message":"certification denied","details":None,"hint":None})
            violations.append("RPC unexpectedly succeeded")
            return self.reply(200,json.loads(r.stdout))
        except Exception as e:
            violations.append(type(e).__name__);self.reply(500,{"error":"unexpected"})
def http(action,token_value=None,method="POST",origin=ORIGIN,body=None,extra=None):
    h={"Origin":origin,"Content-Type":"application/json"}
    if token_value:h["Authorization"]="Bearer "+token_value
    h.update(extra or {})
    data=None if method in ("GET","OPTIONS") else (body if isinstance(body,bytes) else json.dumps(body or {}).encode())
    req=urllib.request.Request("http://127.0.0.1:8000/?action="+action,data=data,headers=h,method=method)
    try:r=urllib.request.urlopen(req,timeout=20)
    except urllib.error.HTTPError as e:r=e
    with r:return r.status,r.headers,r.read()
def check(name,expected,*args,**kw):
    status,h,body=http(*args,**kw)
    assert status==expected,(name,status,expected)
    assert h.get("Cache-Control")=="no-store" and h.get("Access-Control-Allow-Origin")==ORIGIN
    assert body==b"" if expected==204 else json.loads(body)=={"error":"rejected"}
    print("PASS",name,status,flush=True)
def main():
    setup()
    gateway=ThreadingHTTPServer(("127.0.0.1",0),Gateway)
    thread=threading.Thread(target=gateway.serve_forever,daemon=True);thread.start()
    # Pass no inherited tokens, no project URLs or credentials.
    env={k:os.environ[k] for k in ("PATH","HOME","DENO_DIR") if k in os.environ}
    env.update(SUPABASE_URL=f"http://127.0.0.1:{gateway.server_port}",SUPABASE_SERVICE_ROLE_KEY="synthetic-local-only")
    proc=subprocess.Popen(["deno","run","--node-modules-dir=none","--cached-only","--allow-env","--allow-net=0.0.0.0:8000,127.0.0.1:"+str(gateway.server_port),str(ENTRY)],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
    try:
        for _ in range(80):
            if proc.poll() is not None: raise AssertionError(proc.stdout.read())
            try:
                http("manifest",method="OPTIONS");break
            except OSError:time.sleep(.25)
        else:raise AssertionError("Edge startup timeout")
        q={"archiveId":ARCHIVE,"memoryId":MEMORY,"operationId":None}
        check("preflight",204,"manifest",method="OPTIONS")
        check("wrong origin",403,"manifest",origin="https://invalid.example")
        check("wrong method",405,"manifest",method="GET")
        check("no token",401,"manifest",body=q)
        check("invalid token",401,"manifest","invalid",body=q)
        check("legacy action",403,"begin",token("A"),body=q)
        check("missing fence",403,"commit",token("A"),body=q)
        check("invalid fence",403,"commit",token("A"),body=q,extra={"x-archivito-generation":"0","x-archivito-fence":OP})
        check("invalid body content type",415,"manifest",token("A"),body=q,extra={"Content-Type":"text/plain"})
        for k in ACTORS:check("closed manifest "+k,403,"manifest",token(k),body=q)
        # A fenced block reaches real intent RPC, which must deny before any Storage IO.
        from urllib.parse import urlencode
        a="block&"+urlencode({"archiveId":ARCHIVE,"operationId":OP,"path":"synthetic"})
        check("closed fenced block",403,a,token("A"),body=b"x",extra={"Content-Type":"application/octet-stream","x-archivito-generation":"1","x-archivito-fence":OP})
        assert calls==[("A","head",True),("B","head",True),("C","head",True),("A","intent",True)],calls
        assert not violations,violations
        assert closed()
        print("PASS real Deno HTTP -> SDK -> localhost adapter -> actual closed PostgreSQL RPC; no Storage calls, no mutations")
        print("LIMIT Auth and REST gateway doubles; no Supabase Edge Runtime / real Storage / authentic JWT certification")
    finally:
        proc.terminate()
        try:proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:proc.kill();proc.communicate()
        gateway.shutdown();gateway.server_close()
if __name__=="__main__":main()
