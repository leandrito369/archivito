"""Manual synthetic session lifecycle probes. Never run in CI or on an open gate.
No token persistence, no global logout, no mutation of archive data.
"""
import base64
import getpass
import json
import re
import sys
import time
import uuid
import warnings
from email.utils import parsedate_to_datetime
from probe_incremental_authenticated_closed import request, ORIGIN, MEMORY
from probe_incremental_fixture_login import ARCHIVE, EMAILS

MAX_WAIT = 7200
SKEW = 60
DENIED = (401, 403)
REFRESH_CODES = {"refresh_token_not_found", "refresh_token_already_used",
                 "refresh_token_revoked", "session_not_found", "session_expired"}

def emit(label, case, status, verdict, **safe):
    print(json.dumps({"actor": label, "case": case, "status": status,
                      "verdict": verdict, **safe}), flush=True)

def require(label, case, status, ok, **safe):
    emit(label, case, status, "PASS" if ok else "FAIL", **safe)
    if not ok:
        raise SystemExit("STOP: unexpected result; operator audit required")

def claims(token):
    # Decode ONLY tokens obtained directly from Auth over TLS.
    # Not a signature verifier. Auth /user is the independent validity check.
    try:
        part = token.split(".")[1]
        p = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
        uuid.UUID(p["sub"])
        uuid.UUID(p["session_id"])
        if p["role"] != "authenticated" or type(p["exp"]) is not int:
            raise ValueError()
        return p
    except (ValueError, KeyError, IndexError, TypeError, AttributeError):
        raise SystemExit("STOP: unexpected token claims") from None

def auth_headers(key, token=None):
    h = {"apikey": key, "Content-Type": "application/json"}
    if token:
        h["Authorization"] = "Bearer " + token
    return h

def user_probe(key, token):
    return request("/auth/v1/user", auth_headers(key, token))

def manifest(label, key, token, case):
    code, h, body = request("/functions/v1/archivito-sync-incremental?action=manifest",
        {**auth_headers(key, token), "Origin": ORIGIN},
        {"archiveId": ARCHIVE, "memoryId": MEMORY, "operationId": None})
    require(label, case, code, code == 403 and body == {"error": "rejected"}
            and "no-store" in h.get("Cache-Control", "").lower()
            and h.get("Access-Control-Allow-Origin") == ORIGIN)

def logout(label, key, token, case="local_logout"):
    code, _, _ = request("/auth/v1/logout?scope=local", auth_headers(key, token), {})
    require(label, case, code, code in (200, 204))

def refresh(key, token):
    return request("/auth/v1/token?grant_type=refresh_token", auth_headers(key),
                   {"refresh_token": token})

def session_tokens(body):
    if not isinstance(body, dict):
        return None, None
    a, r = body.get("access_token"), body.get("refresh_token")
    return (a if isinstance(a, str) and a else None,
            r if isinstance(r, str) and r else None)

def validated_user(label, key, token, p, case):
    code, h, user = user_probe(key, token)
    require(label, case, code, code == 200 and isinstance(user, dict)
            and user.get("id") == p["sub"] and user.get("email", "").lower() == EMAILS[label])
    return h

def expiry_seconds(p, h):
    # Cross-check local wall clock against the server response Date; no global config changes.
    try:
        server = parsedate_to_datetime(h["Date"]).timestamp()
        if abs(time.time() - server) > 30:
            raise ValueError()
        remaining = p["exp"] - server
        if not 0 < remaining <= MAX_WAIT - SKEW:
            raise ValueError()
        return remaining + SKEW
    except (ValueError, KeyError, TypeError, OverflowError):
        raise SystemExit("STOP: clock mismatch or expiry outside bounded local test") from None

def wait_expiry(seconds):
    target = time.monotonic() + seconds
    while time.monotonic() < target:
        time.sleep(min(30, max(0, target - time.monotonic())))

def probe(label, mode, key, password, wait=wait_expiry):
    if label not in EMAILS or mode not in ("REVOKE", "EXPIRE") or not re.fullmatch(r"sb_publishable_[A-Za-z0-9_-]+", key) or not password:
        raise SystemExit("Invalid fixture input")
    code, _, session = request("/auth/v1/token?grant_type=password", auth_headers(key),
                              {"email": EMAILS[label], "password": password})
    access, refresh_token = session_tokens(session)
    require(label, "fixture_login", code, code == 200 and bool(access and refresh_token))
    del session
    active = access
    try:
        p = claims(access)
        h = validated_user(label, key, access, p, "auth_user")
        manifest(label, key, access, "closed_manifest_before")
        if mode == "REVOKE":
            logout(label, key, access)
            active = None
            code, _, body = user_probe(key, access)
            if code == 200:
                require(label, "reused_access_identity", code, isinstance(body, dict)
                        and body.get("id") == p["sub"] and body.get("email", "").lower() == EMAILS[label])
            # /user may check the server session, or still accept the unexpired access JWT.
            # Neither outcome establishes JWT signature-level revocation.
            emit(label, "access_reuse_after_logout", code, "OBSERVED",
                 auth_api_accepts=code == 200, unexpired=time.time() < p["exp"])
            if code not in (200, *DENIED):
                raise SystemExit("STOP: unexpected Auth API replay response")
            manifest(label, key, access, "closed_manifest_after_logout")
            code, _, body = refresh(key, refresh_token)
            new_access, _ = session_tokens(body)
            if new_access:
                # Unexpected issued token: clean up only if it is the same fixture identity.
                if claims(new_access)["sub"] == p["sub"]:
                    active = new_access
                else:
                    raise SystemExit("STOP: refresh returned unexpected identity")
            error = body.get("error_code", body.get("code")) if isinstance(body, dict) else None
            require(label, "revoked_refresh_reuse", code,
                    code in (400, *DENIED) and not new_access and error in REFRESH_CODES,
                    recognized_revocation=error in REFRESH_CODES)
        else:
            seconds = expiry_seconds(p, h)
            emit(label, "natural_expiry_wait", 200, "OBSERVED", wait_seconds=int(seconds + 1))
            # Keep the original live session, no refresh and no logout before expiry.
            wait(seconds)
            if time.time() < p["exp"]:
                raise SystemExit("STOP: local clock has not reached token expiry")
            code, _, _ = user_probe(key, access)
            require(label, "expired_access_user", code, code in DENIED)
            manifest(label, key, access, "closed_manifest_after_expiry")
            # Refresh ONLY after the expiry observations, to distinguish expired JWT
            # from revoked session and obtain a valid access token for local cleanup.
            code, _, body = refresh(key, refresh_token)
            new_access, new_refresh = session_tokens(body)
            if new_access:
                np = claims(new_access)
                if np["sub"] != p["sub"]:
                    raise SystemExit("STOP: refresh returned unexpected identity")
                active = new_access
            require(label, "refresh_live_session_after_expiry", code,
                    code == 200 and bool(new_access and new_refresh)
                    and np["session_id"] == p["session_id"] and np["exp"] > p["exp"])
            validated_user(label, key, active, np, "refreshed_identity")
    finally:
        if active:
            # Do not claim cleanup on failure. If the original JWT expired and
            # refresh failed, report the need for operator session review.
            logout(label, key, active, "cleanup_logout")

def main():
    if not sys.stdin.isatty():
        raise SystemExit("Interactive local terminal required")
    if input("Confirm independent fixture/gate audit (CLOSED-FIXTURE): ").strip() != "CLOSED-FIXTURE":
        raise SystemExit("Stopped")
    label = input("Fixture A/B/C: ").strip().upper()
    mode = input("REVOKE or EXPIRE: ").strip().upper()
    if label not in EMAILS or mode not in ("REVOKE", "EXPIRE"):
        raise SystemExit("Invalid selection")
    if mode == "EXPIRE" and input("Natural expiry can take up to two hours; keep terminal open (WAIT): ").strip() != "WAIT":
        raise SystemExit("Stopped")
    warnings.simplefilter("error", getpass.GetPassWarning)
    key = getpass.getpass("Project publishable key: ").strip()
    password = getpass.getpass("Synthetic fixture password: ")
    probe(label, mode, key, password)

if __name__ == "__main__":
    main()
