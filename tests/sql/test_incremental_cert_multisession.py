"""Real independent PostgreSQL sessions in the disposable CI container only."""
import json
import os
from pathlib import Path
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
CONTAINER = os.environ["PG_CONTAINER"]
DB = "archivito_cert_lab"
SC = "archivito_inc_cert_candidate"
MEMORY = "73ac551b-2df8-4da7-91b8-4adf18d83901"
HASH = "b" * 64
KEY = "a" * 64


def uid():
    return str(uuid.uuid4())


def lit(value):
    if isinstance(value, (dict, list)):
        value = json.dumps(value, separators=(",", ":"))
    return "'" + str(value).replace("'", "''") + "'"


def cmd(name="cert-control"):
    return ["docker", "exec", "-i", "-e", "PGAPPNAME=" + name, CONTAINER,
            "psql", "-X", "-qAt", "-U", "postgres", "-d", DB, "-v", "ON_ERROR_STOP=1"]


def run(sql, error=None):
    r = subprocess.run(cmd(), input=sql, text=True, capture_output=True, timeout=25)
    if error is not None:
        assert r.returncode and error in r.stderr, (r.returncode, r.stderr, r.stdout)
    else:
        assert r.returncode == 0, r.stderr
    return r.stdout.strip()


def json_run(sql):
    return json.loads(run(sql))


def hold(sql):
    p = subprocess.Popen(cmd("cert-holder"), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, text=True, bufsize=1)
    p.stdin.write("begin;\n" + sql + "\nselect 'READY';\n")
    p.stdin.flush()
    while True:
        line = p.stdout.readline()
        if line.strip() == "READY":
            return p
        if not line:
            raise AssertionError("holder failed before barrier")


def waiter(sql):
    p = subprocess.Popen(cmd("cert-waiter") + ["-c", sql], stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, text=True)
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        if p.poll() is not None:
            raise AssertionError(("waiter finished before lock barrier", p.communicate()))
        if run("select count(*) from pg_stat_activity where application_name='cert-waiter' and wait_event_type='Lock';") == "1":
            return p
        time.sleep(0.05)
    p.kill()
    raise AssertionError("no real PostgreSQL lock wait observed")


def release(p):
    out, _ = p.communicate("commit;\n\\q\n", timeout=15)
    assert p.returncode == 0, out


def finish(p, error=None):
    out, err = p.communicate(timeout=20)
    if error is not None:
        assert p.returncode and error in err, (out, err)
    else:
        assert p.returncode == 0, err
    return out.strip()


def setup():
    # Stand-ins only for Supabase-owned relations. The actual repository
    # sync_inc_step and schema are loaded unchanged from their SQL sources.
    run("""
      create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls;
      create table public.archives(id uuid primary key,key_fingerprint text);
      create table public.archive_members(archive_id uuid,user_id uuid,role text);
      create schema storage;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));
    """)
    for name in ("cloud_03_5c3b2a_closed_rpc.sql", "cloud_03_5c3b2b_storage_catalog.sql",
                 "cloud_03_5c3b3d_cert_fence_candidate.sql", "cloud_03_5c3b3d_fenced_rpc_candidate.sql"):
        run((ROOT / "docs/sql" / name).read_text())
    # Test-only DDL in disposable container, never a deployable migration.
    run("alter table archivito_inc.gates drop constraint inc_gate_hard_closed;")
    assert run(f"select has_schema_privilege('authenticated','{SC}','USAGE') or has_schema_privilege('service_role','{SC}','USAGE');") == "f"


def fixture():
    x = dict(win=uid(), archive=uid(), a=uid(), b=uid(), asset=uid())
    w, a, b, archive = (lit(x[k]) for k in ("win", "a", "b", "archive"))
    run(f"""
      insert into public.archives values({archive},{lit(KEY)});
      insert into public.archive_members values({archive},{a},'owner'),({archive},{b},'editor');
      insert into archivito_inc.gates(archive_id,enabled) values({archive},true);
      insert into {SC}.windows values({w},{archive},{a},{b},{lit(KEY)},
        clock_timestamp()-interval '1 minute',clock_timestamp()+interval '10 minutes',true,67108864,24);
    """)
    return x


def wire(x, revision=1, base=None):
    op = uid()
    ref = dict(id=x["asset"], born=1, size=32, nonce="A"*16, cipherSha256=HASH)
    path = f'{x["archive"]}/{MEMORY}/{x["asset"]}/0'
    return dict(format="archivito-incremental-wire-v1",
                header=dict(archiveId=x["archive"],memoryId=MEMORY,operationId=op,keyId=KEY,
                            revision=revision,refs=[ref],metadata="synthetic"),
                base=base,uploads=[dict(id=x["asset"],chunks=[dict(index=0,path=path,size=32,sha256=HASH)])] if revision==1 else [])


def claim_sql(x, actor, w):
    return f"select {SC}.claim_begin({lit(x['win'])},{lit(actor)},{lit(w)}::jsonb);"


def step(x, actor, f, action, w, extra=""):
    return f"select {SC}.fenced_step({lit(x['win'])},{lit(actor)},{f['generation']},{lit(f['token'])},{lit(action)},{lit(w)}::jsonb{extra});"


def prepare(x):
    w = wire(x)
    f = json_run(claim_sql(x,x["a"],w))
    assert f["result"]["state"] == "staging"
    # Only mock Storage metadata: no claim that actual ciphertext was uploaded.
    path = w["uploads"][0]["chunks"][0]["path"]
    run(f"insert into storage.objects values('archivito-inc-private',{lit(path)},'{{\"size\":32}}');")
    r = json_run(step(x,x["a"],f,"attest",w,","+lit(x["asset"])+","+lit(HASH)))
    assert r["state"] == "verified"
    return w, f


def counts(x):
    a = lit(x["archive"])
    return run(f"select count(*) from archivito_inc.operations where archive_id={a} and state='committed';")


def close(x):
    return f"update {SC}.windows set enabled=false where id={lit(x['win'])};"


def main():
    setup()
    # Actual simultaneous commit vs close: close gets lock first.
    x=fixture();w,f=prepare(x)
    h=hold(close(x));p=waiter(step(x,x["a"],f,"commit",w));release(h)
    finish(p,"certification denied");assert counts(x)=="0"
    print("PASS close wins: waiting commit rejected")

    # Reverse ordering: already authorized transaction linearizes first.
    x=fixture();w,f=prepare(x)
    h=hold(step(x,x["a"],f,"commit",w));p=waiter(close(x));release(h)
    finish(p);assert counts(x)=="1"
    run(step(x,x["a"],f,"commit",w),error="certification denied")
    print("PASS commit wins: closure serialized and subsequent replay denied")

    # Window expires while core RPC is blocked on its existing archive gate.
    x=fixture();w,f=prepare(x)
    run(f"update {SC}.windows set expires_at=clock_timestamp()+interval '4 seconds' where id={lit(x['win'])};")
    h=hold(f"select archive_id from archivito_inc.gates where archive_id={lit(x['archive'])} for update;")
    p=waiter(step(x,x["a"],f,"commit",w));time.sleep(4.2);release(h)
    finish(p,"certification denied");assert counts(x)=="0"
    print("PASS expiry during core RPC rolls back commit")

    # A real competing transaction waits while a replacement claims the lease.
    x=fixture();w,f=prepare(x)
    op=lit(w["header"]["operationId"])
    run(f"update {SC}.fences set lease_until=clock_timestamp()-interval '1 second' where operation_id={op};")
    h=hold(claim_sql(x,x["a"],w))
    p=waiter(step(x,x["a"],f,"commit",w));release(h)
    finish(p,"certification fence denied");assert counts(x)=="0"
    f2=json_run(f"select jsonb_build_object('generation',generation,'token',token) from {SC}.fences where operation_id={op};")
    assert f2["generation"]==2 and f2["token"]!=f["token"]
    assert json_run(step(x,x["a"],f2,"commit",w))["state"]=="synced"
    assert json_run(step(x,x["a"],f2,"commit",w))["replayed"] is True
    assert counts(x)=="1"
    print("PASS takeover rejects stale fence; exact replay commits once")

    # Two independent authorized actors, same predecessor: actual CAS.
    x=fixture();w,f=prepare(x)
    assert json_run(step(x,x["a"],f,"commit",w))["state"]=="synced"
    base=dict(revision=1,operationId=w["header"]["operationId"])
    wa,wb=wire(x,2,base),wire(x,2,base)
    fa=json_run(claim_sql(x,x["a"],wa));fb=json_run(claim_sql(x,x["b"],wb))
    h=hold(step(x,x["a"],fa,"commit",wa));p=waiter(step(x,x["b"],fb,"commit",wb));release(h)
    conflict=json.loads(finish(p));assert conflict["state"]=="conflict" and conflict["actualOperationId"]==wa["header"]["operationId"]
    assert counts(x)=="2"
    assert run(f"select count(*) from archivito_inc.assets where archive_id={lit(x['archive'])};")=="1"
    # Revocation is checked by the actual RPC, not the window allowlist alone.
    run(f"delete from public.archive_members where archive_id={lit(x['archive'])} and user_id={lit(x['a'])};")
    run(step(x,x["a"],fa,"commit",wa),error="not member")
    print("PASS concurrent revisions CAS; current membership revocation checked")

    # A failure in the real core RPC must roll back the new fence/reservation.
    x=fixture();w=wire(x)
    run(f"delete from public.archive_members where archive_id={lit(x['archive'])} and user_id={lit(x['a'])};")
    run(claim_sql(x,x["a"],w),error="not member")
    assert run(f"select count(*) from {SC}.fences where window_id={lit(x['win'])};")=="0"
    print("PASS failed begin rolls back fence and reservation")
    print("PASS multisesion integration candidate; synthetic Storage metadata only")


if __name__ == "__main__":
    main()
