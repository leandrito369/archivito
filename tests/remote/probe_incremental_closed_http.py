"""Read-only HTTP negative probes. No valid credentials, no real archive IDs.
Run only against the explicitly configured Archivito certification endpoint.
No retry, no redirects, no writes with a valid token, no secret logging."""
import os
import urllib.request
import urllib.error
import json

URL = os.environ.get("ARCHIVITO_CERT_URL", "")
EXPECTED = "https://pjzathwsanxenmjmeizg.supabase.co/functions/v1/archivito-sync-incremental"
ORIGIN = "http://localhost:8000"
if URL != EXPECTED:
    raise SystemExit("Certification endpoint not explicitly configured")

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

opener = urllib.request.build_opener(NoRedirect())
cases = [
    ("preflight", "OPTIONS", {"Origin": ORIGIN, "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,content-type"}, None, 204),
    ("no_token", "POST", {"Origin": ORIGIN, "Content-Type": "application/json"}, b"{}", 401),
    ("invalid_token", "POST", {"Origin": ORIGIN, "Content-Type": "application/json",
      "Authorization": "Bearer invalid-certification-token"}, b"{}", 403),
    ("wrong_origin", "POST", {"Origin": "https://invalid.example", "Content-Type": "application/json"}, b"{}", 403),
    ("wrong_method", "GET", {"Origin": ORIGIN}, None, 405),
]
failures = 0
for name, method, headers, body, expected in cases:
    req = urllib.request.Request(URL + "?action=manifest", data=body, headers=headers, method=method)
    try:
        try:
            res = opener.open(req, timeout=10)
        except urllib.error.HTTPError as e:
            res = e
        with res:
            code = res.code
            cache = res.headers.get("Cache-Control", "")
            cors = res.headers.get("Access-Control-Allow-Origin", "")
            payload = res.read(2048)
            ok = code == expected and "no-store" in cache.lower() and cors == ORIGIN
            if expected == 204:
                ok = ok and not payload
            else:
                try:
                    ok = ok and json.loads(payload) == {"error": "rejected"}
                except (ValueError, UnicodeError):
                    ok = False
            print(json.dumps({"case": name, "status": code, "expected": expected, "pass": bool(ok)}), flush=True)
            failures += not ok
    except (OSError, urllib.error.URLError) as e:
        print(json.dumps({"case": name, "status": "transport_unavailable", "error_type": type(e).__name__, "pass": False}), flush=True)
        failures += 1
if failures:
    raise SystemExit(1)
