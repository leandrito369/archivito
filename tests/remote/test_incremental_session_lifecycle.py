"""Offline unit tests; fake Auth responses, no network or secrets."""
import base64
import contextlib
import io
import json
import unittest
from email.utils import formatdate
from unittest.mock import patch
import probe_incremental_session_lifecycle as m

UID="00000000-0000-4000-8000-000000000001"
SID="00000000-0000-4000-8000-000000000002"
NOW=1800000000
KEY="sb_publishable_synthetic"
def jwt(exp):
    p=base64.urlsafe_b64encode(json.dumps(dict(sub=UID,session_id=SID,role="authenticated",exp=exp)).encode()).decode().rstrip("=")
    return "e30."+p+".synthetic"
TOKEN=jwt(NOW+90)
NEW=jwt(NOW+900)
USER={"id":UID,"email":m.EMAILS["A"]}
EDGE={"Cache-Control":"no-store","Access-Control-Allow-Origin":m.ORIGIN}
def reply(code,body=None,headers=None):
    return code,headers or {},body
def run(mode,responses,wait=None):
    out=io.StringIO()
    with patch.object(m,"request",side_effect=responses) as req, patch.object(m.time,"time",return_value=NOW), contextlib.redirect_stdout(out):
        if wait:
            m.probe("A",mode,KEY,"synthetic",wait=lambda s:wait(s,m.time.time))
        else:
            m.probe("A",mode,KEY,"synthetic")
    return req.call_args_list,out.getvalue()

class SessionLifecycle(unittest.TestCase):
    def baseline(self):
        return [reply(200,{"access_token":TOKEN,"refresh_token":"synthetic-refresh"}),
                reply(200,USER,{"Date":formatdate(NOW,usegmt=True)}),
                reply(403,{"error":"rejected"},EDGE)]
    def test_logout_refresh_denied_and_access_observed(self):
        for status in (200,401,403):
            calls,out=run("REVOKE",self.baseline()+[reply(204),reply(status,USER if status==200 else None),
                reply(403,{"error":"rejected"},EDGE),reply(400,{"error_code":"refresh_token_not_found"})])
            self.assertEqual(len(calls),7)
            self.assertIn("OBSERVED",out)
            self.assertIn("revoked_refresh_reuse",out)
            self.assertNotIn(TOKEN,out)
            self.assertNotIn("synthetic-refresh",out)
            self.assertTrue(all("scope=global" not in c.args[0] for c in calls))
    def test_unexpected_refresh_success_cleans_up(self):
        replies=self.baseline()+[reply(204),reply(401),reply(403,{"error":"rejected"},EDGE),
            reply(200,{"access_token":NEW,"refresh_token":"new"}),reply(204)]
        with patch.object(m,"request",side_effect=replies) as req, patch.object(m.time,"time",return_value=NOW), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit):m.probe("A","REVOKE",KEY,"synthetic")
            self.assertEqual(req.call_args.args[0],"/auth/v1/logout?scope=local")
            self.assertEqual(req.call_args.args[1]["Authorization"],"Bearer "+NEW)
    def test_natural_expiry_then_refresh_and_logout(self):
        def advance(seconds,clock):
            self.assertEqual(seconds,150)
            clock.return_value=NOW+150
        calls,out=run("EXPIRE",self.baseline()+[reply(401),reply(403,{"error":"rejected"},EDGE),
            reply(200,{"access_token":NEW,"refresh_token":"new"}),reply(200,USER),reply(204)],advance)
        self.assertEqual(len(calls),8)
        self.assertEqual(calls[3].args[1]["Authorization"],"Bearer "+TOKEN)
        self.assertEqual(calls[5].args[0],"/auth/v1/token?grant_type=refresh_token")
        self.assertEqual(calls[7].args[1]["Authorization"],"Bearer "+NEW)
        self.assertNotIn(NEW,out)
    def test_unknown_refresh_error_fails(self):
        with patch.object(m,"request",side_effect=self.baseline()+[reply(204),reply(401),reply(403,{"error":"rejected"},EDGE),reply(400,{"error_code":"other"})]),patch.object(m.time,"time",return_value=NOW),contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit):m.probe("A","REVOKE",KEY,"synthetic")
    def test_expiry_clock_mismatch_fails_and_logs_out(self):
        b=self.baseline()
        b[1]=reply(200,USER,{"Date":formatdate(NOW-120,usegmt=True)})
        with patch.object(m,"request",side_effect=b+[reply(204)]) as req,patch.object(m.time,"time",return_value=NOW),contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit):m.probe("A","EXPIRE",KEY,"synthetic",wait=lambda _:self.fail("wait"))
            self.assertEqual(req.call_args.args[0],"/auth/v1/logout?scope=local")

if __name__=="__main__":
    unittest.main()
