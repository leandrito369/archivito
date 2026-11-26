"""Manual, local-only authenticated NEGATIVE probe for a dedicated synthetic archive.
No persistence, no tokens in argv/env/output, no write endpoints, no redirects.
Requires operator confirmation of the independent hard-closed SQL audit.
This does not distinguish gate denial from other authorization denial by itself.
"""
import base64
import getpass
import json
import re
import sys
import urllib.error
import urllib.request
import uuid

BASE = "https://pjzathwsanxenmjmeizg.supabase.co"
ORIGIN = "http://localhost:8000"
MEMORY = "73ac551b-2df8-4da7-91b8-4adf18d83901"
ROLE_LABELS = {"A", "B", "C"}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

def request(path, headers, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, headers=headers)
    try:
        try:
            res = opener.open(req, timeout=15)
        except urllib.error.HTTPError as e:
            res = e
        with res:
            raw = res.read(65537)
            if len(raw) > 65536:
                raise ValueError("response limit")
            try:
                payload = json.loads(raw)
            except (ValueError, UnicodeError):
                payload = None
            return res.code, res.headers, payload
    except (OSError, ValueError):
        raise SystemExit("FAIL: transport or response unavailable (no sensitive output)") from None

def main():
    if not sys.stdin.isatty():
        raise SystemExit("Interactive local terminal required; never run in CI.")
    if input("Confirm dedicated synthetic archive and independent hard-closed gate audit (CLOSED): ").strip() != "CLOSED":
        raise SystemExit("Stopped: no authorization for probe.")
    label = input("Fixture role A/B/C: ").strip().upper()
    if label not in ROLE_LABELS:
        raise SystemExit("Invalid fixture role")
    try:
        archive = str(uuid.UUID(input("Dedicated synthetic archive UUID (never personal archive): ").strip()))
    except ValueError:
        raise SystemExit("Invalid UUID") from None
    key = getpass.getpass("Project publishable key (sb_publishable_...): ").strip()
    if not re.fullmatch(r"sb_publishable_[A-Za-z0-9_-]+", key):
        raise SystemExit("Only publishable keys accepted")
    token = getpass.getpass("Short-lived fixture access JWT (not refresh token): ").strip()
    try:
        parts = token.split(".")
        if len(parts) != 3:
            raise ValueError()
        claims = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
        if claims.get("role") != "authenticated" or not claims.get("session_id"):
            raise ValueError()
    except (ValueError, UnicodeError, TypeError):
        raise SystemExit("Expected authenticated user access JWT") from None
    headers = {"Authorization": "Bearer " + token, "apikey": key}
    code, _, user = request("/auth/v1/user", headers)
    valid = code == 200 and isinstance(user, dict) and user.get("id") == claims.get("sub")
    print(json.dumps({"actor": label, "case": "auth_user", "status": code, "pass": valid}))
    if not valid:
        raise SystemExit("No Edge probe: session not verified")
    del user, claims
    headers.update({"Origin": ORIGIN, "Content-Type": "application/json"})
    # Only read-only request to fixed synthetic memory. No begin/commit/upload.
    code, response_headers, payload = request("/functions/v1/archivito-sync-incremental?action=manifest", headers,
        {"archiveId": archive, "memoryId": MEMORY, "operationId": None})
    ok = (code == 403 and payload == {"error": "rejected"}
          and "no-store" in response_headers.get("Cache-Control", "").lower()
          and response_headers.get("Access-Control-Allow-Origin") == ORIGIN)
    print(json.dumps({"actor": label, "case": "closed_manifest", "status": code, "expected": 403, "pass": ok}))
    if not ok:
        raise SystemExit("STOP: unexpected response; re-audit gate; do not retry.")

if __name__ == "__main__":
    main()
