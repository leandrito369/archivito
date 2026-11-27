"""Local-only password login for reserved synthetic accounts; no token copy.
Never run with personal accounts, in CI, or on an open gate.
"""
import getpass
import json
import re
import sys
import warnings
from probe_incremental_authenticated_closed import request, ORIGIN, MEMORY

ARCHIVE = "73ac551b-2df8-4da7-91b8-4adf18d83900"
EMAILS = {x: f"archivito-cert-{x.lower()}@example.com" for x in ("A", "B", "C")}

def emit(label, case, code, ok):
    print(json.dumps({"actor": label, "case": case, "status": code, "pass": bool(ok)}))

def probe(label, key, password):
    if label not in EMAILS or not re.fullmatch(r"sb_publishable_[A-Za-z0-9_-]+", key) or not password:
        raise SystemExit("Invalid fixture input")
    headers = {"apikey": key, "Content-Type": "application/json"}
    code, _, session = request("/auth/v1/token?grant_type=password", headers,
                              {"email": EMAILS[label], "password": password})
    token = session.get("access_token") if isinstance(session, dict) else None
    ok = code == 200 and isinstance(token, str) and bool(token) and session.get("token_type", "").lower() == "bearer"
    emit(label, "fixture_login", code, ok)
    if not ok:
        raise SystemExit("STOP: genuine fixture session unavailable")
    # No refresh, no persistence, no tokens in output or exception text.
    del session
    headers["Authorization"] = "Bearer " + token
    try:
        code, _, user = request("/auth/v1/user", headers)
        ok = code == 200 and isinstance(user, dict) and user.get("email", "").lower() == EMAILS[label]
        emit(label, "auth_user", code, ok)
        if not ok:
            raise SystemExit("STOP: fixture identity not confirmed")
        del user
        code, response_headers, payload = request(
            "/functions/v1/archivito-sync-incremental?action=manifest",
            {**headers, "Origin": ORIGIN},
            {"archiveId": ARCHIVE, "memoryId": MEMORY, "operationId": None})
        ok = (code == 403 and payload == {"error": "rejected"}
              and "no-store" in response_headers.get("Cache-Control", "").lower()
              and response_headers.get("Access-Control-Allow-Origin") == ORIGIN)
        emit(label, "closed_manifest", code, ok)
        if not ok:
            raise SystemExit("STOP: unexpected response; re-audit gate")
    finally:
        code, _, _ = request("/auth/v1/logout?scope=local", headers, {})
        ok = code in (200, 204)
        emit(label, "local_logout", code, ok)
        if not ok:
            raise SystemExit("STOP: logout not confirmed; operator review required")

def main():
    if not sys.stdin.isatty():
        raise SystemExit("Interactive local terminal required")
    if input("Confirm dedicated fixture verifier PASS and hard-closed gate (CLOSED-FIXTURE): ").strip() != "CLOSED-FIXTURE":
        raise SystemExit("Stopped")
    label = input("Fixture A/B/C: ").strip().upper()
    if label not in EMAILS:
        raise SystemExit("Invalid fixture")
    warnings.simplefilter("error", getpass.GetPassWarning)
    key = getpass.getpass("Project publishable key: ").strip()
    password = getpass.getpass("Synthetic fixture password: ")
    probe(label, key, password)

if __name__ == "__main__":
    main()
