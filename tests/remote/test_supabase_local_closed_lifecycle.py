"""D.4E.4: real closed-stack lifecycle and concurrency, never a positive transfer."""
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import threading
import time
from urllib.parse import urlencode

from test_supabase_local_closed_stack import (
    Lab, ARCHIVE, MEMORY, KEY, SC, BUCKET, Stop, require, passed, lit, uid
)

TTL=120
EXPIRY_GRACE=65
OP="73ac551b-2df8-4da7-91b8-4adf18d83910"
ASSET="73ac551b-2df8-4da7-91b8-4adf18d83911"
FENCE="73ac551b-2df8-4da7-91b8-4adf18d83912"
BLOCK=bytes(range(32))
DIGEST=hashlib.sha256(BLOCK).hexdigest()
OBJECT_PATH=f"{ARCHIVE}/{MEMORY}/{ASSET}/0"
QUERY={"archiveId":ARCHIVE,"memoryId":MEMORY,"operationId":None}

def b64(b):
    return base64.urlsafe_b64encode(b).decode().rstrip("=")

def claims(token):
    p=token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(p+"="*(-len(p)%4)))

def wire():
    # Structurally valid deterministic synthetic ciphertext-shaped bytes;
    # no encryption/decryption or positive transfer is claimed.
    return {"format":"archivito-incremental-wire-v1","base":None,
        "header":{"format":"archivito-sync-incremental-v1","archiveId":ARCHIVE,
            "memoryId":MEMORY,"operationId":OP,"revision":1,"keyId":KEY,
            "metadata":{"version":1,"archiveId":ARCHIVE,"objectId":MEMORY,
                "kind":"metadata","revision":1,"keyId":KEY,
                "nonce":b64(bytes(12)),"ciphertext":b64(bytes(16))},
            "refs":[{"id":ASSET,"born":1,"size":32,"nonce":b64(bytes(12)),
                "cipherSha256":DIGEST}]},
        "uploads":[{"id":ASSET,"chunks":[{"index":0,"path":OBJECT_PATH,
            "size":32,"sha256":DIGEST}]}]}

class LifecycleLab(Lab):
    def configure(self):
        super().configure()
        conf=self.work/"supabase/config.toml"
        src,n=re.subn(r"(?m)^jwt_expiry\s*=\s*\d+\s*(?:#.*)?$",f"jwt_expiry = {TTL}",conf.read_text())
        require(n==1,"local Auth JWT expiry setting not unique")
        conf.write_text(src)
        passed("disposable Auth JWT lifetime configured")
    def sign_in(self,label):
        status,_,d=self.request("/auth/v1/token?grant_type=password",self.anon,None,
           {"email":f"archivito-e3-{label.lower()}@example.com","password":self.passwords[label]})
        require(status==200 and isinstance(d,dict),"E4 login "+label)
        token,refresh=d["access_token"],d["refresh_token"]
        c=claims(token)
        require(c["sub"]==self.users[label] and c["role"]=="authenticated"
                and c["exp"]-c["iat"]==TTL,"E4 authentic JWT claims "+label)
        session=uid(c["session_id"])
        status,_,u=self.request("/auth/v1/user",self.anon,token)
        require(status==200 and u.get("id")==self.users[label],"E4 getUser "+label)
        require(self.sql(f"select exists(select 1 from auth.sessions where id={lit(session)} and user_id={lit(self.users[label])});")=="t","E4 actual session "+label)
        return token,refresh,session,c["exp"]
    def rpc_denied(self,label,session,action,**kw):
        args={"p_actor":self.users[label],"p_session":session,"p_action":action,"p_archive":ARCHIVE,**kw}
        status,_,d=self.rpc("sync_inc_cert_http",self.service,self.service,args)
        require(status==403 and isinstance(d,dict) and d.get("code")=="42501"
                and d.get("message")=="certification denied","E4 guarded RPC "+action+" "+label)
    def denied(self,label,token,action,body,extra=None,expected=403):
        status,h,d=self.edge(token,action=action,body=body,extra=extra)
        self.check_edge("E4 "+label+" "+action,status,h,d,expected)
    def attempt_set(self,label,token,session):
        w=wire()
        stale={"x-archivito-generation":"1","x-archivito-fence":FENCE}
        advanced={"x-archivito-generation":"2","x-archivito-fence":FENCE}
        q={"archiveId":ARCHIVE,"operationId":OP,"assetId":ASSET}
        catalog={**q,"memoryId":MEMORY}
        action="block&"+urlencode({"archiveId":ARCHIVE,"operationId":OP,"path":OBJECT_PATH})
        # Exact replay, missing/malformed fences, fabricated old/new generations.
        for _ in range(2):
            self.denied(label,token,"claim",w)
            self.rpc_denied(label,session,"claim",p_wire=w)
        self.denied(label,token,"commit",w)
        self.denied(label,token,"commit",w,{"x-archivito-generation":"0","x-archivito-fence":FENCE})
        for generation,headers in ((1,stale),(2,advanced)):
            self.denied(label,token,"commit",w,headers)
            self.denied(label,token,"attest",q,headers)
            self.denied(label,token,action,BLOCK,{**headers,"Content-Type":"application/octet-stream"})
            self.rpc_denied(label,session,"commit",p_wire=w,p_generation=generation,p_token=FENCE)
            self.rpc_denied(label,session,"intent",p_operation=OP,p_generation=generation,p_token=FENCE)
        self.denied(label,token,"manifest",QUERY)
        self.denied(label,token,"manifest",{**QUERY,"operationId":OP})
        self.denied(label,token,"catalog",catalog)
        self.denied(label,token,"download",{**catalog,"index":0})
        passed("E4 exact replay and fabricated fence generations denied "+label)
    def parallel_replay(self,actors):
        # Six requests genuinely launched together: A/B/C each sends two
        # identical claims against one operation; no per-actor serialization.
        barrier=threading.Barrier(6,timeout=15)
        def worker(label):
            token,_,session,_=actors[label]
            barrier.wait()
            self.denied(label,token,"claim",wire())
            self.rpc_denied(label,session,"claim",p_wire=wire())
        with ThreadPoolExecutor(max_workers=6) as pool:
            futures=[pool.submit(worker,k) for k in "AABBCC"]
            for f in futures:f.result(timeout=60)
        self.audit(3)
        passed("E4 six simultaneous Edge claims and guarded RPC replays denied; zero mutations")
    def expire_window(self,actors):
        # Shorten ONLY an already disabled local window; never enable it.
        ar=lit(ARCHIVE)
        self.sql(f"update {SC}.windows set expires_at=clock_timestamp()+interval '2 seconds' where archive_id={ar} and not enabled;")
        time.sleep(2.3)
        require(self.sql(f"select count(*)=1 and coalesce(bool_and(not enabled and expires_at<=clock_timestamp()),false) from {SC}.windows where archive_id={ar};")=="t","E4 closed window expiry")
        for label,(token,_,session,_) in actors.items():
            self.denied(label,token,"claim",wire())
            self.rpc_denied(label,session,"claim",p_wire=wire())
        self.audit(3)
        passed("E4 closed window natural expiry and post-expiry replay")
    def probe(self):
        super().probe()
        actors={}
        try:
            for label in "ABC":actors[label]=self.sign_in(label)
            self.audit(3)
            for label,(token,_,session,_) in actors.items():
                self.managed_context(label,session)
                self.attempt_set(label,token,session)
            self.parallel_replay(actors)
            self.expire_window(actors)
            # Do not edit token or server clocks: wait until actual exp + grace.
            delay=max(0,max(x[3] for x in actors.values())-time.time()+EXPIRY_GRACE)
            require(delay<=TTL+EXPIRY_GRACE+5,"E4 clock skew / expiry bound")
            print("E4_WAIT natural JWT expiry seconds="+str(round(delay,1)),flush=True)
            time.sleep(delay)
            for label,(token,refresh,session,exp) in list(actors.items()):
                require(time.time()>exp,"E4 token not naturally expired")
                status,_,_=self.request("/auth/v1/user",self.anon,token)
                require(status in (401,403),"E4 expired Auth token "+label)
                self.denied(label,token,"manifest",QUERY,expected=401)
                status,_,d=self.request("/auth/v1/token?grant_type=refresh_token",self.anon,None,{"refresh_token":refresh})
                require(status==200 and isinstance(d,dict),"E4 refresh live session "+label)
                new,rt=d["access_token"],d["refresh_token"]
                c=claims(new)
                require(c["sub"]==self.users[label] and c["session_id"]==session and c["exp"]>exp
                        and c["role"]=="authenticated","E4 refreshed identity "+label)
                actors[label]=(new,rt,session,c["exp"])
                status,_,u=self.request("/auth/v1/user",self.anon,new)
                require(status==200 and u.get("id")==self.users[label],"E4 refreshed getUser "+label)
                self.denied(label,new,"claim",wire())
                self.rpc_denied(label,session,"claim",p_wire=wire())
                passed("E4 natural JWT expiry and same-session refresh "+label)
            self.audit(3)
            for label,(token,refresh,session,exp) in list(actors.items()):
                status,_,_=self.request("/auth/v1/logout?scope=local",self.anon,token,{},method="POST")
                require(status in (200,204),"E4 logout "+label)
                self.managed_context(label,session,revoked=True)
                # GoTrue can retain a signed access token until expiry. Record
                # Auth response separately; Edge must reject regardless.
                status,_,_=self.request("/auth/v1/user",self.anon,token)
                require(status in (200,401,403),"E4 revoked Auth probe "+label)
                expected=403 if status==200 else 401
                self.denied(label,token,"manifest",QUERY,expected=expected)
                self.rpc_denied(label,session,"head",p_memory=MEMORY)
                status,_,d=self.request("/auth/v1/token?grant_type=refresh_token",self.anon,None,{"refresh_token":refresh})
                require(status in (400,401,403) and isinstance(d,dict)
                        and (d.get("error_code") in ("refresh_token_not_found","refresh_token_already_used","session_not_found","bad_jwt","invalid_grant")
                             or d.get("error")=="invalid_grant"),"E4 revoked refresh "+label)
                del actors[label]
                self.audit(len(actors))
                passed("E4 revoked access and refresh rejected by closed service "+label)
        finally:
            for token,_,_,_ in actors.values():
                self.request("/auth/v1/logout?scope=local",self.anon,token,{},method="POST")
        self.audit(0)
        status,_,d=self.request("/storage/v1/object/list/"+BUCKET,self.service,self.service,{"prefix":"","limit":100,"offset":0})
        require(status==200 and d==[],"E4 final Storage empty")
        passed("E4 closed lifecycle final audit: no operations, fences, heads, objects or sessions")

def main():
    require(os.environ.get("GITHUB_ACTIONS")=="true" and os.environ.get("ARCHIVITO_DISPOSABLE_LAB")=="supabase-e4","CI disposable E4 only")
    with tempfile.TemporaryDirectory(prefix="archivito-e4-") as d:
        lab=LifecycleLab(Path(d))
        try:
            lab.configure()
            lab.start()
            lab.provision()
            lab.probe()
        finally:
            lab.stop()
    passed("D.4E.4 real closed lifecycle; no positive lease/generation transition certified")

if __name__=="__main__":
    try:main()
    except Stop as e:raise SystemExit("STOP: "+str(e)) from None
    except Exception as e:raise SystemExit("STOP: "+type(e).__name__) from None
