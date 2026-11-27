"""D.4E.3: isolated Supabase CLI/Docker stack; no hosted credentials or linking.

CI disposable runner only. Gateway probes use loopback; direct Edge probes use only the verified private Docker network;
database access only by docker exec into a uniquely named newly created container.
"""
import base64
import json
from email.parser import Parser
import ipaddress
import yaml
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit
import uuid

ROOT=Path(__file__).resolve().parents[2]
CLI="2.122.0"
# Published Docker Hub multi-platform index, curlimages/curl:8.21.0.
PROBE_IMAGE="docker.io/curlimages/curl@sha256:7c12af72ceb38b7432ab85e1a265cff6ae58e06f95539d539b654f2cfa64bb13"
API="http://127.0.0.1:54321"
FUNCTION="archivito-sync-incremental"
ORIGIN="http://localhost:8000"
ARCHIVE="73ac551b-2df8-4da7-91b8-4adf18d83900"
MEMORY="73ac551b-2df8-4da7-91b8-4adf18d83901"
KEY="a"*64
BUCKET="archivito-inc-private"
SC="archivito_inc_cert_candidate"
SOURCES=("cloud_03_5c3b2a_closed_rpc.sql","cloud_03_5c3b2b_storage_catalog.sql",
         "cloud_03_5c3b3d_cert_fence_candidate.sql","cloud_03_5c3b3d_fenced_rpc_candidate.sql",
         "cloud_03_5c3b3d3_http_acl_candidate.sql")
MODULES=("server/sync-incremental-fenced-service.mjs","server/sync-incremental-service.mjs",
         "app/sync-incremental-wire.mjs","app/shared-crypto.mjs","app/sync-incremental.mjs",
         "app/sync-v3-contract.mjs")
class Stop(Exception): pass
def require(ok,case):
    if not ok: raise Stop(case)
def passed(case): print("PASS "+case,flush=True)
def lit(x): return "'"+str(x).replace("'","''")+"'"
def uid(x):
    return str(uuid.UUID(x))
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*a,**kw): return None
OPENER=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
class Lab:
    def __init__(self,work):
        self.work=work
        self.project="archivito-e3-"+secrets.token_hex(6)
        self.db="supabase_db_"+self.project
        self.env={k:os.environ[k] for k in ("PATH","LANG","LC_ALL","TMPDIR") if k in os.environ}
        self.env.update(HOME=str(work/"home"),CI="true",SUPABASE_TELEMETRY_DISABLED="true")
        (work/"home").mkdir()
        self.started=False
        self.probe_container=self.project+"-cors-probe"
        self.probe_image_ready=False
    def cmd(self,args,stdin=None,timeout=90,allow_fail=False):
        # Never print subprocess output (CLI status/start may contain keys).
        r=subprocess.run(args,cwd=self.work,env=self.env,input=stdin,text=True,
                         capture_output=True,timeout=timeout)
        if not allow_fail and r.returncode:
            # SQL error text is generated exclusively from synthetic local SQL.
            if args[:2]==["docker","exec"]:
                detail=next((x for x in r.stderr.splitlines() if x.startswith("ERROR:")),None)
                if detail: print("LOCAL SQL "+detail[:240],flush=True)
            raise Stop("command failed: "+args[0]+" "+args[1])
        return r
    def docker(self,*args,**kw):return self.cmd(["docker",*args],**kw)
    def sql(self,q,allow_fail=False):
        # No network SQL URL, no remote db password.
        r=self.docker("exec","-i",self.db,"psql","-X","-qAt","-U","supabase_admin","-d","postgres",
                      "-v","ON_ERROR_STOP=1",stdin=q,allow_fail=allow_fail)
        return r if allow_fail else r.stdout.strip()
    def configure(self):
        require(self.cmd(["supabase","--version"]).stdout.strip()==CLI,"unexpected CLI version")
        for args in (["init","--help"],["start","--help"],["status","--help"],["stop","--help"],["functions","serve","--help"]):
            self.cmd(["supabase",*args])
        require(not self.docker("ps","-a","--filter","name="+self.project,"--format","{{.Names}}").stdout.strip(),"existing container")
        for port in (54321,54322,54323,54324,54327,54329):
            with socket.socket() as s:
                try:s.bind(("127.0.0.1",port))
                except OSError:raise Stop("local port occupied") from None
        self.cmd(["supabase","init"])
        conf=self.work/"supabase/config.toml"
        require(conf.is_file(),"unexpected CLI config format")
        src=conf.read_text()
        src,n=re.subn(r'(?m)^project_id\s*=.*$',f'project_id = "{self.project}"',src,count=1)
        require(n==1,"project id not found")
        src,n=re.subn(r'(?m)^major_version\s*=.*$',"major_version = 17",src,count=1)
        require(n==1,"db version not found")
        # No migration files or project secrets copied. Explicitly keep handler's
        # own getUser authentication, matching the candidate gateway contract.
        src+="\n[functions."+FUNCTION+"]\nverify_jwt = false\n"
        conf.write_text(src)
        shared=self.work/"supabase/functions/_shared/archivito"
        for path in MODULES:
            target=shared/path;target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(ROOT/path,target)
        entry=self.work/"supabase/functions"/FUNCTION/"index.ts"
        entry.parent.mkdir(parents=True,exist_ok=True)
        code=(ROOT/"supabase/functions"/FUNCTION/"index.ts").read_text()
        old="../../../server/sync-incremental-fenced-service.mjs"
        require(code.count(old)==1,"unexpected entrypoint import")
        entry.write_text(code.replace(old,"../_shared/archivito/server/sync-incremental-fenced-service.mjs"))
        passed("fresh project configuration and isolated Edge package")
    def start_diagnostics(self,stdout,stderr,reason):
        # Allowlisted classifications only: never emit raw CLI output, URLs,
        # credentials, container environment, or health-check output.
        patterns={
            "image_pull":r"pull access denied|failed to pull|manifest unknown|toomanyrequests|image pull",
            "healthcheck":r"unhealthy|health.check|health check",
            "network":r"connection refused|dns error|network error|i/o timeout|failed to connect",
            "resources":r"no space left|out of memory|cannot allocate memory|oom",
            "port_conflict":r"address already in use|port is already allocated",
            "edge":r"edge.runtime|worker boot|failed to resolve|module not found",
            "database":r"database system|postgres|migration failed",
            "permission":r"permission denied|access denied",
            "timeout":r"timed out|timeout|deadline exceeded"}
        def classify(value):
            if isinstance(value,bytes): value=value.decode("utf-8",errors="replace")
            return {k:bool(re.search(v,value or "",re.I)) for k,v in patterns.items()}
        print("START_DIAG "+json.dumps({"reason":reason,"stdout":classify(stdout),
              "stderr":classify(stderr)}),flush=True)
        try:
            listing=self.docker("ps","-a","--filter","name="+self.project,
                                "--format","{{.Names}}",allow_fail=True)
            if listing.returncode:
                print("START_HEALTH unavailable",flush=True)
                return
            components=("db","auth","rest","storage","edge_runtime","kong","realtime",
                        "studio","meta","analytics","vector","pooler","inbucket","imgproxy","mailpit")
            for name in listing.stdout.splitlines():
                component=next((c for c in components if name=="supabase_"+c+"_"+self.project),None)
                if component is None: continue
                info=self.docker("inspect","--format",
                    "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.State.ExitCode}}|{{.State.OOMKilled}}",
                    name,allow_fail=True)
                fields=info.stdout.strip().split("|")
                if info.returncode or len(fields)!=4:
                    print("START_HEALTH "+json.dumps({"component":component,"available":False}),flush=True)
                    continue
                state,health,code,oom=fields
                print("START_HEALTH "+json.dumps({"component":component,
                    "state":state if state in ("created","running","paused","restarting","removing","exited","dead") else "unknown",
                    "health":health if health in ("starting","healthy","unhealthy","none") else "unknown",
                    "exit_code":int(code) if re.fullmatch(r"[0-9]{1,3}",code) else None,
                    "oom":oom=="true"}),flush=True)
        except (OSError,subprocess.SubprocessError,Stop):
            print("START_HEALTH unavailable",flush=True)
    def start(self):
        self.started=True
        print("PHASE starting pinned local Docker services",flush=True)
        try:
            result=self.cmd(["supabase","start"],timeout=1200,allow_fail=True)
        except subprocess.TimeoutExpired as exc:
            self.start_diagnostics(exc.stdout,exc.stderr,"timeout")
            raise Stop("supabase start timeout") from None
        if result.returncode:
            self.start_diagnostics(result.stdout,result.stderr,"nonzero")
            raise Stop("command failed: supabase start")
        require(self.docker("inspect","--format","{{.Name}}",self.db).stdout.strip()=="/"+self.db,"wrong DB container")
        names=self.docker("ps","--filter","name="+self.project,"--format","{{.Names}} {{.Image}}").stdout.splitlines()
        for component in ("supabase_db_","supabase_auth_","supabase_rest_","supabase_storage_","supabase_edge_runtime_"):
            require(any(x.startswith(component+self.project+" ") for x in names),"missing local service "+component)
        # Only container names and image tags (no docker inspect Env).
        for line in names: print("IMAGE "+line,flush=True)
        status=json.loads(self.cmd(["supabase","status","-o","json"]).stdout)
        require(status.get("API_URL") in (API,"http://localhost:54321"),"nonlocal API URL")
        self.anon=status.get("ANON_KEY")
        self.service=status.get("SERVICE_ROLE_KEY")
        require(isinstance(self.anon,str) and isinstance(self.service,str) and self.anon!=self.service,"missing local keys")
        require(self.sql("select rolsuper from pg_roles where rolname=current_user;")=="t","local admin not superuser")
        print("POSTGRES "+self.sql("show server_version;"),flush=True)
        passed("real Supabase services running")
    def request(self,path,key,token=None,body=None,method=None,extra=None):
        require(path.startswith("/") and not path.startswith("//"),"invalid path")
        h={"apikey":key,"Content-Type":"application/json"}
        if token is not None:h["Authorization"]="Bearer "+token
        h.update(extra or {})
        data=None if body is None else (body if isinstance(body,bytes) else json.dumps(body).encode())
        req=urllib.request.Request(API+path,data=data,headers=h,method=method)
        try:r=OPENER.open(req,timeout=30)
        except urllib.error.HTTPError as e:r=e
        with r:
            raw=r.read(1048577)
            require(len(raw)<=1048576,"oversized response")
            try:d=json.loads(raw)
            except (ValueError,UnicodeError):d=None
            return r.status,r.headers,d
    def edge(self,token,action="manifest",body=None,extra=None,method=None):
        return self.request("/functions/v1/"+FUNCTION+"?action="+action,self.anon,token,
           body,method,{"Origin":ORIGIN,**(extra or {})})
    def functions_route(self,config):
        matches=[]
        for service in config["services"]:
            for route in service.get("routes",[]) or []:
                if any(p in ("/functions/v1/","/functions/v1") for p in (route.get("paths") or [])):
                    matches.append((service,route))
        require(len(matches)==1,"ambiguous functions route")
        service,route=matches[0]
        require(len(service.get("routes") or [])==1,"shared functions service; refuse mutation")
        return service,route
    def internal_edge(self,config):
        # Derive the upstream from the generated config, never guess a port.
        service,route=self.functions_route(config)
        if service.get("url"):
            target=urlsplit(service["url"])
            require(target.scheme=="http" and not target.username and not target.password
                    and not target.query and not target.fragment,"unexpected functions upstream URL")
            host,port,path=target.hostname,target.port or 80,target.path
        else:
            require(service.get("protocol","http")=="http","unexpected functions protocol")
            host,port,path=service.get("host"),service.get("port",80),service.get("path") or ""
        require(isinstance(host,str) and re.fullmatch(r"[a-zA-Z0-9_.-]+",host) is not None,
                "invalid upstream host")
        require(type(port) is int and 1<=port<=65535,"invalid upstream port")
        require(path in ("","/") and route.get("strip_path",True) is True,
                "unexpected functions upstream path mapping")
        kong="supabase_kong_"+self.project
        edge="supabase_edge_runtime_"+self.project
        nets=[]
        for name in (kong,edge):
            r=self.docker("inspect","--format","{{json .NetworkSettings.Networks}}",name)
            nets.append(json.loads(r.stdout))
        common=set(nets[0]) & set(nets[1])
        require(len(common)==1,"ambiguous isolated Docker network")
        network=next(iter(common))
        require(network.endswith(self.project),"unexpected Docker network")
        endpoint=nets[1][network]
        addr=ipaddress.ip_address(endpoint["IPAddress"])
        require(addr.version==4 and any(addr in ipaddress.ip_network(n) for n in ("10.0.0.0/8","172.16.0.0/12","192.168.0.0/16")),"nonprivate Edge address")
        aliases=set(endpoint.get("Aliases") or []) | set(endpoint.get("DNSNames") or []) | {edge,str(addr)}
        # Match the real upstream to this precise container, not an arbitrary DNS target.
        require(host.lower() in {a.lower() for a in aliases},"Kong upstream is not isolated Edge")
        # Only inspect socket metadata; no environment, credentials or process arguments.
        listeners=[]
        for table in ("/proc/net/tcp","/proc/net/tcp6"):
            r=self.docker("exec",edge,"cat",table,allow_fail=True)
            if r.returncode:continue
            for line in r.stdout.splitlines()[1:]:
                fields=line.split()
                if len(fields)<4 or fields[3]!="0A":continue
                local,sep,hexport=fields[1].partition(":")
                if not sep or not re.fullmatch(r"[0-9A-Fa-f]{4}",hexport):continue
                if not re.fullmatch(r"[0-9A-Fa-f]{8}|[0-9A-Fa-f]{32}",local):continue
                binding="all" if set(local)=={"0"} else ("loopback" if local in ("0100007F","00000000000000000000000001000000") else "specific")
                listeners.append({"port":int(hexport,16),"binding":binding,"family":4 if table.endswith("tcp") else 6})
        print("EDGE_UPSTREAM "+json.dumps({"port":port,"host_matches_alias":True,
              "host_is_ip":host==str(addr),"alias_count":len(aliases),
              "strip_path":True,"listeners":listeners,
              "port_matches_listener":any(x["port"]==port for x in listeners),
              "previous_probe_port":9000,"port_changed":port!=9000}),flush=True)
        self.probe_network=network
        self.edge_internal="http://"+host+":"+str(port)
        self.edge_resolve=host+":"+str(port)+":"+str(addr) if host!=str(addr) else None
    def direct_edge(self,method="GET",origin=ORIGIN,extra=None):
        # Isolated helper: no host namespace, mounts, credentials or ports.
        require(method in ("GET","OPTIONS"),"unexpected direct probe method")
        require(origin in (ORIGIN,"https://unauthorized.example"),"unexpected direct probe origin")
        headers={"Origin":origin,**(extra or {})}
        require(set(headers)<= {"Origin","Access-Control-Request-Method","Access-Control-Request-Headers"},"unexpected direct headers")
        if not self.probe_image_ready:
            r=self.docker("pull",PROBE_IMAGE,timeout=180,allow_fail=True)
            require(r.returncode==0,"pinned diagnostic image pull failed")
            info=self.docker("image","inspect","--format","{{json .RepoDigests}}",PROBE_IMAGE)
            require(any(x.endswith("@"+PROBE_IMAGE.split("@")[1]) for x in json.loads(info.stdout)),
                    "diagnostic image digest mismatch")
            self.probe_image_ready=True
            passed("diagnostic image pinned by immutable digest")
        require(not self.docker("ps","-a","--filter","name="+self.probe_container,"--format","{{.Names}}").stdout.strip(),"diagnostic container already exists")
        args=["run","--rm","--pull=never","--name",self.probe_container,
              "--network",self.probe_network,"--cap-drop=ALL","--security-opt=no-new-privileges",
              "--read-only","--user","65534:65534","--pids-limit","32","--memory","64m",
              "--entrypoint","curl",PROBE_IMAGE,"--disable","--silent","--show-error",
              "--include","--http1.1","--noproxy","*","--connect-timeout","10","--max-time","30",
              "--max-filesize","1048576","--request",method]
        for key,value in headers.items():args+=["--header",key+": "+value]
        if self.edge_resolve:args+=["--resolve",self.edge_resolve]
        args+=["--url",self.edge_internal+"/"+FUNCTION+"?action=manifest"]
        try:
            r=self.docker(*args,timeout=45,allow_fail=True)
        finally:
            self.remove_probe()
        print("EDGE_TRANSPORT "+json.dumps({"transport":"isolated-docker-helper","method":method,
            "curl_exit":r.returncode,"connected":r.returncode==0}),flush=True)
        require(r.returncode==0,"direct runtime transport failed")
        require(len(r.stdout)<=1048576,"oversized direct response")
        head,sep,body=r.stdout.partition("\n\n")
        require(bool(sep),"missing direct HTTP headers")
        status_line,_,raw_headers=head.partition("\n")
        match=re.fullmatch(r"HTTP/1\.[01] ([1-5][0-9]{2})(?: .*)?",status_line)
        require(match is not None,"invalid direct HTTP status")
        h=Parser().parsestr(raw_headers+"\n\n")
        try:d=json.loads(body)
        except ValueError:d=None
        return int(match.group(1)),h,d
    def kong_config(self):
        # Declarative config can contain local secrets; capture in memory, never log.
        r=self.docker("exec","supabase_kong_"+self.project,"sh","-c",
                      'test -n "$KONG_DECLARATIVE_CONFIG" && cat "$KONG_DECLARATIVE_CONFIG"')
        config=yaml.safe_load(r.stdout)
        require(isinstance(config,dict) and isinstance(config.get("services"),list),"unexpected Kong config")
        return config
    def cors_route(self,config):
        service,route=self.functions_route(config)
        require(not any(p.get("name")=="cors" for p in config.get("plugins",[]) or []),
                "top-level CORS plugin requires separate investigation")
        scopes=[(scope,scope.get("plugins") or []) for scope in (service,route)]
        found=[(scope,p) for scope,plugins in scopes for p in plugins if p.get("name")=="cors"]
        return found
    def cors_isolation(self):
        config=self.kong_config()
        self.internal_edge(config)
        gateway=self.edge(self.anon,method="GET")
        direct=self.direct_edge()
        for layer,(status,h,d) in (("runtime",direct),("kong",gateway)):
            print("CORS_LAYER "+json.dumps({"layer":layer,"status":status,
                  "generic":d=={"error":"rejected"},"origins_exact":h.get_all("Access-Control-Allow-Origin")==[ORIGIN],
                  "wildcard":("*" in (h.get_all("Access-Control-Allow-Origin") or [])),
                  "cache_exact":h.get_all("Cache-Control")==["no-store"]}),flush=True)
        self.check_edge("direct Edge method rejection",*direct,405)
        found=self.cors_route(config)
        for _,p in found:
            origins=(p.get("config") or {}).get("origins") or []
            print("KONG_CORS_CONFIG "+json.dumps({"enabled":p.get("enabled",True),
                  "default_or_wildcard":not origins or origins==["*"],
                  "origin_count":len(origins),
                  "preflight_continue":(p.get("config") or {}).get("preflight_continue",False)}),flush=True)
        if gateway[1].get_all("Access-Control-Allow-Origin")==["*"]:
            require(gateway[0]==405 and gateway[2]=={"error":"rejected"} and gateway[1].get_all("Cache-Control")==["no-store"],
                    "unexpected gateway response; no CORS mutation")
            require(len(found)==1,"cannot attribute wildcard to single plugin")
            scope,plugin=found[0]
            origins=(plugin.get("config") or {}).get("origins") or []
            require(plugin.get("enabled",True) and (not origins or origins==["*"]),"unexpected effective CORS policy")
            # Delegate CORS to the actual function only. No other route, auth
            # plugin, secret, setting or SQL change. Local runner only.
            scope["plugins"].remove(plugin)
            kong="supabase_kong_"+self.project
            self.docker("exec","-u","0","-i",kong,"sh","-c",
                'test -n "$KONG_DECLARATIVE_CONFIG" && cat > "$KONG_DECLARATIVE_CONFIG"',
                stdin=json.dumps(config))
            require(self.kong_config()==config,"Kong config write mismatch")
            self.docker("restart",kong,timeout=120)
            for _ in range(30):
                try:
                    result=self.edge(self.anon,method="GET")
                    if result[0]==405:break
                except (OSError,urllib.error.URLError):pass
                time.sleep(1)
            else:raise Stop("Kong restart did not restore function route")
            require(self.kong_config()==config,"Kong config changed after restart")
            require(not self.cors_route(config),"CORS plugin remains on functions route")
            self.check_edge("Kong after delegation",*result,405)
            passed("CORS root cause isolated: Kong wildcard plugin removed from local functions route")
        else:
            self.check_edge("Kong original method rejection",*gateway,405)
            require(not found,"unexpected active CORS plugin on functions route")
        self.cors_regression()
    def cors_regression(self):
        headers={"Access-Control-Request-Method":"POST",
                 "Access-Control-Request-Headers":"authorization,apikey,content-type,x-archivito-generation,x-archivito-fence"}
        allowed=set(headers["Access-Control-Request-Headers"].split(","))
        for layer,request in (("runtime",self.direct_edge),
                              ("kong",lambda method,origin,extra=None:self.edge(self.anon,method=method,extra={"Origin":origin,**(extra or {})}))):
            status,h,d=request("OPTIONS",ORIGIN,headers)
            require(status==204 and d is None and h.get_all("Access-Control-Allow-Origin")==[ORIGIN]
                    and h.get_all("Cache-Control")==["no-store"],"valid preflight "+layer)
            require(set(x.strip().lower() for x in h.get("Access-Control-Allow-Headers","").split(","))>=allowed
                    and "POST" in h.get("Access-Control-Allow-Methods","").split(","),"preflight headers "+layer)
            for method,extra in (("OPTIONS",headers),("GET",None)):
                status,h,d=request(method,"https://unauthorized.example",extra)
                # Fixed allowlisted origin is not a grant to the requesting origin.
                require(status==403 and d=={"error":"rejected"}
                        and h.get_all("Access-Control-Allow-Origin") in (None,[ORIGIN])
                        and h.get_all("Cache-Control")==["no-store"],"unauthorized origin "+layer+" "+method)
            passed("CORS allowed preflight and unauthorized origin rejection "+layer)
    def edge_diagnostics(self,case,status,h,d):
        # Report only response classifications, never raw headers/bodies or
        # container environment. The runner owns these synthetic containers.
        safe_codes={"BOOT_ERROR","WORKER_ERROR","WORKER_RESOURCE_LIMIT","NOT_FOUND",
                    "UNAUTHORIZED","FUNCTION_NOT_FOUND","FUNCTION_ERROR","JWT_ERROR","INVALID_JWT"}
        code=h.get("sb-error-code","")
        if code not in safe_codes: code="other" if code else "absent"
        origins=h.get_all("Access-Control-Allow-Origin") or []
        cache=h.get_all("Cache-Control") or []
        print("EDGE_DIAG "+json.dumps({"case":case,"status":status,
              "error_code":code,"generic_rejection":d=={"error":"rejected"},
              "body_kind":"json-object" if isinstance(d,dict) else "other",
              "cors_count":len(origins),"cors_exact":origins==[ORIGIN],
              "cors_wildcard":"*" in origins,"cache_count":len(cache),
              "cache_exact":cache==["no-store"]}),flush=True)
        r=self.docker("logs","--tail","120","supabase_edge_runtime_"+self.project,allow_fail=True)
        log=r.stdout+"\n"+r.stderr
        # Known failure classes only; do not forward arbitrary log lines.
        patterns={"boot":r"boot.error|failed to boot|worker boot",
                  "import_resolution":r"module not found|cannot find module|failed to resolve|failed to load|module resolution|import map",
                  "npm":r"npm:|npm package|npm registry",
                  "network":r"connection refused|dns error|network error|failed to fetch",
                  "jwt":r"invalid jwt|jwt verification|jwt expired",
                  "runtime_exception":r"uncaught|typeerror|referenceerror|syntaxerror",
                  "worker_timeout":r"worker did not respond|timed out|timeout",
                  "permission":r"permission denied|not permitted"}
        print("EDGE_RUNTIME_DIAG "+json.dumps({k:bool(re.search(v,log,re.I)) for k,v in patterns.items()}),flush=True)
    def check_edge(self,case,status,h,d,expected):
        ok=status==expected and d=={"error":"rejected"} and h.get_all("Cache-Control")==["no-store"] and h.get_all("Access-Control-Allow-Origin")==[ORIGIN]
        if not ok:self.edge_diagnostics(case,status,h,d)
        require(ok,case)
    def rpc(self,name,key,token,args):
        return self.request("/rest/v1/rpc/"+name,key,token,args)
    def provision(self, *, candidate=True):
        require(self.sql("select to_regnamespace('archivito_inc') is null and to_regclass('public.archives') is null and (select count(*) from auth.users)=0;")=="t","nonempty local database")
        self.sql("""
          begin;
          create table public.archives(
           id uuid primary key,created_at timestamptz not null default now(),
           schema_version integer not null default 1 check(schema_version=1),
           key_fingerprint text check(key_fingerprint ~ '^[0-9a-f]{64}$'));
          create table public.archive_members(
           archive_id uuid not null references public.archives(id) on delete restrict,
           user_id uuid not null references auth.users(id) on delete cascade,
           role text not null check(role in ('owner','editor')),
           created_at timestamptz not null default now(),
           primary key(archive_id,user_id),unique(archive_id,role));
          alter table public.archives enable row level security;
          alter table public.archive_members enable row level security;
          revoke all on public.archives,public.archive_members from public,anon,authenticated,service_role;
          grant select on public.archives,public.archive_members to authenticated;
          create policy archive_members_read_self on public.archive_members for select to authenticated using(user_id=(select auth.uid()));
          create policy archives_read_member on public.archives for select to authenticated using(exists(select 1 from public.archive_members m where m.archive_id=id and m.user_id=(select auth.uid())));
          commit;
        """)
        self.users={}
        self.passwords={}
        for label in "ABC":
            email=f"archivito-e3-{label.lower()}@example.com"
            password="Aa1!"+secrets.token_urlsafe(32)
            status,_,d=self.request("/auth/v1/admin/users",self.service,self.service,
                       {"email":email,"password":password,"email_confirm":True})
            require(status in (200,201) and isinstance(d,dict) and d.get("email")==email,"local Auth admin user "+label)
            self.users[label]=uid(d["id"]);self.passwords[label]=password
        a,b=(lit(self.users[k]) for k in "AB")
        ar=lit(ARCHIVE);k=lit(KEY)
        # All five candidate SQL sources applied unchanged, atomically, to
        # newly created local managed relations. Never DROP the hard constraint.
        scripts="\n".join((ROOT/"docs/sql"/n).read_text() for n in (SOURCES if candidate else SOURCES[:2]))
        window=f"""insert into {SC}.windows values({lit(str(uuid.uuid4()))},{ar},{a},{b},{k},statement_timestamp(),statement_timestamp()+interval '15 minutes',false,67108864,24);""" if candidate else ""
        self.sql("begin;\n"+scripts+f"""
          insert into public.archives(id,key_fingerprint) values({ar},{k});
          insert into public.archive_members(archive_id,user_id,role) values({ar},{a},'owner'),({ar},{b},'editor');
          insert into archivito_inc.gates(archive_id,enabled,quota_bytes) values({ar},false,67108864);
          {window}
          notify pgrst,'reload schema';
          commit;
        """)
        if not candidate:
            passed("legacy SQL and synthetic managed fixtures installed locally")
            return
        passed("actual managed Auth/Storage tables and candidate DDL installed locally")
        # Regression against the actual inserted fixture and its validated CHECK.
        require(self.sql(f"select count(*)=1 and coalesce(bool_and(expires_at-opened_at=interval '15 minutes' and not enabled),false) from {SC}.windows where archive_id={ar};")=="t","deterministic closed fixture window duration")
        passed("fixture window regression: exactly 15 minutes and closed")
    def audit(self,expected_sessions):
        ar=lit(ARCHIVE)
        q=f"""select
          (select count(*) from auth.users)=3
          and (select count(*) from auth.sessions)={expected_sessions}
          and (select count(*) from public.archives)=1
          and (select count(*) from public.archive_members)=2
          and (select count(*) from archivito_inc.gates where archive_id={ar} and not enabled)=1
          and (select count(*) from {SC}.windows where archive_id={ar} and not enabled)=1
          and exists(select 1 from pg_constraint where conrelid='archivito_inc.gates'::regclass and conname='inc_gate_hard_closed' and convalidated and pg_get_constraintdef(oid)='CHECK ((NOT enabled))')
          and not exists(select 1 from {SC}.fences)
          and not exists(select 1 from archivito_inc.operations)
          and not exists(select 1 from archivito_inc.heads)
          and not exists(select 1 from storage.objects where bucket_id='{BUCKET}')
          and exists(select 1 from storage.buckets where id='{BUCKET}' and not public and file_size_limit=4194304 and allowed_mime_types=array['application/octet-stream'])
          and (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
               where c.relrowsecurity and ((n.nspname='archivito_inc' and c.relkind='r') or
               (n.nspname,c.relname) in (('auth','sessions'),('public','archives'),('public','archive_members'),('storage','objects'))))=12
          and not has_column_privilege('archivito_cert_executor','auth.sessions','not_after','UPDATE')
          and not has_column_privilege('archivito_cert_executor','public.archives','key_fingerprint','UPDATE')
          and not has_column_privilege('archivito_cert_executor','public.archive_members','role','UPDATE')
          and not has_table_privilege('archivito_cert_executor','storage.objects','INSERT,UPDATE,DELETE,TRUNCATE')
          and not has_schema_privilege('service_role','archivito_inc','USAGE')
          and not has_function_privilege('service_role','public.sync_inc_step(uuid,text,jsonb,uuid,text)','EXECUTE')
          and not has_function_privilege('service_role','public.sync_inc_inspect(uuid,uuid,text,uuid,uuid,uuid)','EXECUTE')
          and not has_function_privilege('authenticated','public.sync_inc_cert_http(uuid,uuid,text,uuid,jsonb,uuid,uuid,uuid,text,bigint,uuid)','EXECUTE')
          and not has_function_privilege('anon','public.sync_inc_cert_http(uuid,uuid,text,uuid,jsonb,uuid,uuid,uuid,text,bigint,uuid)','EXECUTE')
          and not pg_has_role('service_role','archivito_cert_executor','MEMBER')
          and not pg_has_role('authenticated','archivito_cert_executor','MEMBER')
          and not pg_has_role('anon','archivito_cert_executor','MEMBER')
          and (select not rolcanlogin and not rolbypassrls and not rolsuper from pg_roles where rolname='archivito_cert_executor')
          and not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace,
             lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
             where (n.nspname='{SC}' or (n.nspname='public' and p.proname='sync_inc_cert_http')) and a.grantee=0 and a.privilege_type='EXECUTE');"""
        require(self.sql(q)=="t","closed stack audit")
        passed("audit closed gate, sessions="+str(expected_sessions)+", zero incremental objects/operations and effective ACL")
    def login(self,label):
        status,_,d=self.request("/auth/v1/token?grant_type=password",self.anon,None,
           {"email":f"archivito-e3-{label.lower()}@example.com","password":self.passwords[label]})
        require(status==200 and isinstance(d,dict) and d.get("access_token"),"Auth login "+label)
        token=d["access_token"]
        b=token.split(".")[1]
        claims=json.loads(base64.urlsafe_b64decode(b+"="*(-len(b)%4)))
        require(claims["sub"]==self.users[label] and claims["role"]=="authenticated","JWT claims "+label)
        session=uid(claims["session_id"])
        status,_,u=self.request("/auth/v1/user",self.anon,token)
        require(status==200 and u.get("id")==self.users[label],"Auth getUser "+label)
        require(self.sql(f"select exists(select 1 from auth.sessions where id={lit(session)} and user_id={lit(self.users[label])});")=="t","managed session "+label)
        return token,session
    def managed_context(self,label,session,revoked=False):
        # Exercise the actual managed rows separately; the closed window in
        # dispatch otherwise short-circuits these locks. No data returned.
        role="owner" if label=="A" else "editor"
        q=f"""begin;
          set local role archivito_cert_executor;
          select 1 from {SC}.windows where archive_id={lit(ARCHIVE)} for update;
          select {SC}.lock_actor_context({lit(self.users[label])},{lit(session)},{lit(ARCHIVE)},{lit(role)},{lit(KEY)});
          rollback;"""
        r=self.sql(q,allow_fail=True)
        if revoked:require(r.returncode!=0 and "certification session denied" in r.stderr,"revoked managed session "+label)
        elif label=="C":require(r.returncode!=0 and "certification membership denied" in r.stderr,"managed outsider denial")
        else:require(r.returncode==0,"managed actor context "+label)
        passed(("revoked " if revoked else "")+"managed context "+label)
    def negative(self,status,d,case):
        require(status in (401,403,404) and isinstance(d,dict) and d.get("code") in ("42501","PGRST202"),case)
        passed(case+" HTTP "+str(status))
    def probe(self):
        self.audit(0)
        self.cors_isolation()
        q={"archiveId":ARCHIVE,"memoryId":MEMORY,"operationId":None}
        for label in "ABC":
            token,session=self.login(label)
            self.audit(1)
            try:
                self.managed_context(label,session)
                args={"p_actor":self.users[label],"p_session":session,"p_action":"head","p_archive":ARCHIVE,"p_memory":MEMORY}
                # Confirm real PostgREST resolved the correct signature and
                # executed the SQL guard, not a missing function or gateway error.
                for _ in range(15):
                    status,_,d=self.rpc("sync_inc_cert_http",self.service,self.service,args)
                    if isinstance(d,dict) and d.get("code")=="PGRST202":time.sleep(1);continue
                    break
                require(status==403 and d.get("code")=="42501" and d.get("message")=="certification denied","real guarded RPC "+label)
                passed("real PostgREST guard "+label)
                status,_,d=self.rpc("sync_inc_cert_http",self.anon,token,args)
                self.negative(status,d,"authenticated RPC denied "+label)
                status,_,d=self.rpc("sync_inc_cert_http",self.anon,self.anon,args)
                self.negative(status,d,"anon RPC denied "+label)
                status,_,d=self.rpc("sync_inc_inspect",self.service,self.service,
                    {"p_actor":self.users[label],"p_archive":ARCHIVE,"p_action":"head","p_memory":MEMORY})
                self.negative(status,d,"legacy inspect denied "+label)
                status,h,d=self.edge(token,body=q)
                self.check_edge("real Edge manifest "+label,status,h,d,403)
                passed("actual Edge Runtime closed manifest "+label)
                status,_,d=self.request("/storage/v1/object/"+BUCKET+"/synthetic-denied-"+label,self.anon,token,b"synthetic",
                    method="POST",extra={"Content-Type":"application/octet-stream","x-upsert":"false"})
                require(status in (400,401,403) and isinstance(d,dict) and any(x in json.dumps(d).lower() for x in ("row-level security","unauthorized","forbidden","access denied")),"Storage direct upload denied "+label)
                passed("real Storage denies direct upload "+label)
            finally:
                status,_,_=self.request("/auth/v1/logout?scope=local",self.anon,token,{},method="POST")
                require(status in (200,204),"local logout "+label)
            self.audit(0)
            self.managed_context(label,session,revoked=True)
        status,_,d=self.request("/storage/v1/object/list/"+BUCKET,self.service,self.service,
                                 {"prefix":"","limit":100,"offset":0})
        require(status==200 and d==[],"real Storage list not empty")
        passed("real private Storage list empty")
        self.audit(0)
    def remove_probe(self):
        # Exact name only, unique to this run. Remove even after timeout.
        existing=self.docker("ps","-a","--filter","name="+self.probe_container,"--format","{{.Names}}").stdout.splitlines()
        require(all(n==self.probe_container for n in existing),"unexpected diagnostic container name")
        if existing:self.docker("rm","-f",self.probe_container)
        require(not self.docker("ps","-a","--filter","name="+self.probe_container,"--format","{{.Names}}").stdout.strip(),"diagnostic container cleanup failed")
    def stop(self):
        if self.started:
            try:
                self.remove_probe()
            finally:
                self.stop_stack()
    def stop_stack(self):
        # Only the unique directory/project created by this process.
        r=self.cmd(["supabase","stop","--no-backup"],timeout=180,allow_fail=True)
        require(r.returncode==0,"disposable local stack cleanup failed")
        require(not self.docker("ps","-a","--filter","name="+self.project,"--format","{{.Names}}").stdout.strip(),"local containers remain")
        passed("disposable stack removed")
def main():
    require(os.environ.get("GITHUB_ACTIONS")=="true" and os.environ.get("ARCHIVITO_DISPOSABLE_LAB")=="supabase-e3","CI disposable runner only")
    with tempfile.TemporaryDirectory(prefix="archivito-e3-") as d:
        lab=Lab(Path(d))
        try:
            lab.configure()
            lab.start()
            lab.provision()
            lab.probe()
        finally:
            lab.stop()
    print("PASS real local Supabase stack closed; E.4 replay/expiry and E.5 promotion still pending",flush=True)
if __name__=="__main__":
    try:main()
    except Stop as e:raise SystemExit("STOP: "+str(e)) from None
    except Exception as e:raise SystemExit("STOP: "+type(e).__name__) from None
