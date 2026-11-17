#!/usr/bin/env python3
"""Temporary, authenticated-proxy-only OAuth loopback relay. No credential logging."""
import os
import hmac
import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ORIGIN = os.environ["LH_PUBLIC_ORIGIN"].rstrip("/")
_origin = urllib.parse.urlsplit(ORIGIN)
if (_origin.scheme != "https" or not _origin.hostname or _origin.username
        or _origin.password or _origin.path or _origin.query or _origin.fragment
        or _origin.netloc != _origin.hostname):
    raise ValueError("LH_PUBLIC_ORIGIN must be an HTTPS origin without a port or path")
HOST = _origin.hostname
PREFIX = "/connect-chatgpt"
LIMIT = 16384
lock = threading.Lock()
active = None
starting = False

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

def request(url, body=None, app=False):
    headers = {}
    if app:
        headers = {"Host": HOST, "X-Forwarded-Proto": "https", "Origin": ORIGIN,
                   "Sec-Fetch-Site": "same-origin", "x-learnharness-subscriptions": "1"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers,
                                 method="POST" if body is not None else "GET")
    try:
        response = opener.open(req, timeout=20)
    except urllib.error.HTTPError as response:
        return response.code, response.headers, response.read(65536)
    with response:
        return response.status, response.headers, response.read(65536)

def app(path, body=None):
    return request("http://127.0.0.1:3000" + path,
                   json.dumps(body).encode() if body is not None else None, True)

def callback_parts(value):
    p = urllib.parse.urlsplit(value)
    if (p.scheme != "http" or p.hostname != "127.0.0.1" or p.username is not None
            or p.password is not None or p.fragment or p.path != "/auth/callback"
            or p.port is None or not 1024 <= p.port <= 65535
            or p.netloc != f"127.0.0.1:{p.port}"):
        raise ValueError("invalid callback")
    return p

def authorize_parts(value):
    p = urllib.parse.urlsplit(value)
    if (p.scheme != "https" or p.netloc != "auth.openai.com" or p.username is not None
            or p.password is not None or p.fragment):
        raise ValueError("invalid authorization")
    q = urllib.parse.parse_qs(p.query, strict_parsing=True)
    if len(q.get("redirect_uri", [])) != 1 or len(q.get("state", [])) != 1 or not q["state"][0]:
        raise ValueError("invalid authorization")
    callback = callback_parts(q["redirect_uri"][0])
    if callback.query:
        raise ValueError("invalid callback")
    return callback, q["state"][0]

class Handler(BaseHTTPRequestHandler):
    server_version = "OAuthHelper"
    sys_version = ""

    def log_message(self, *args):
        pass

    def send(self, status, content=b"", location=None):
        self.send_response(status)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://auth.openai.com; frame-ancestors 'none'; base-uri 'none'")
        if location:
            self.send_header("Location", location)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def host_ok(self):
        if self.headers.get("Host") != HOST:
            self.send(403)
            return False
        return True

    def do_GET(self):
        if not self.host_ok(): return
        if self.path not in (PREFIX, PREFIX + "/"):
            self.send(404)
            return
        connected = False
        pending = False
        try:
            status, _, body = app("/api/subscriptions")
            if status == 200:
                data = json.loads(body)["chatgpt"]
                connected = any(a.get("id") == data.get("activeId") and a.get("connected") for a in data.get("accounts", []))
                pending = data.get("pending") is True
        except Exception:
            pass
        content = f'''<!doctype html><html lang="tr"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ChatGPT bağlantısı</title>
<style>body{{font:18px system-ui;max-width:760px;margin:60px auto;padding:24px;line-height:1.6}}textarea{{width:100%;min-height:130px}}button{{font:inherit;padding:10px}}a{{color:inherit}}</style>
<h1>ChatGPT bağlantısı</h1><p>Bağlantı: {"Bağlandı" if connected else "Henüz bağlanmadı"}. {"Giriş bekleniyor." if pending else ""}</p>
<ol><li>Aşağıdaki düğmeyle yeni sekmede OpenAI girişini açın. Bu sayfayı açık tutun.</li>
<li>Girişi tamamlayın. Sonunda 127.0.0.1 adresi açılamayabilir; bu beklenir.</li>
<li>O sekmenin adres çubuğundaki adresin tamamını kopyalayıp aşağıya yapıştırın. Adresi kimseyle paylaşmayın. İşlemi üç dakika içinde tamamlayın.</li></ol>
<form method="post" action="{PREFIX}/start" target="_blank"><button type="submit">ChatGPT ile bağlan</button></form>
<form method="post" action="{PREFIX}/cancel"><p><button type="submit">Bekleyen girişi sıfırla</button></p></form>
<form method="post" action="{PREFIX}/complete"><p><label for="callback">Son yönlendirme adresi</label></p><textarea id="callback" name="callback_url" required autocomplete="off" spellcheck="false"></textarea><p><button>Bağlantıyı tamamla</button></p></form>
<p><a href="{PREFIX}">Durumu yenile</a> · <a href="/">LearnHarness'a dön</a></p></html>'''
        self.send(200, content.encode())

    def do_POST(self):
        global active, starting
        if not self.host_ok(): return
        if self.path not in (PREFIX + "/start", PREFIX + "/complete", PREFIX + "/cancel"):
            self.send(404); return
        if self.headers.get("Origin") != ORIGIN or self.headers.get("Transfer-Encoding"):
            self.send(403, "İstek doğrulanamadı. Bağlantı sayfasını yenileyip yeniden deneyin.".encode()); return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 <= length <= LIMIT: raise ValueError()
            if self.headers.get("Content-Type", "").split(";")[0] != "application/x-www-form-urlencoded": raise ValueError()
            body = self.rfile.read(length)
            if len(body) != length: raise ValueError()
            fields = urllib.parse.parse_qs(body.decode("utf-8"), strict_parsing=True)
        except Exception:
            self.send(400, b"Invalid request."); return
        if self.path.endswith("/cancel"):
            with lock:
                if starting:
                    self.send(409, "Giriş başlatılıyor. Birkaç saniye sonra yeniden deneyin.".encode()); return
                code, _, _ = app("/api/subscriptions", {"providerId": "chatgpt", "op": "cancel"})
                if code != 200:
                    self.send(400, "Giriş sıfırlanamadı. Yeniden deneyin.".encode()); return
                active = None
            self.send(303, location=PREFIX)
            return
        if self.path.endswith("/start"):
            with lock:
                if starting or (active and active["expires"] > time.monotonic()):
                    self.send(409, "Bir giriş zaten bekleniyor. Önce mevcut işlemi tamamlayın veya üç dakika bekleyin.".encode()); return
                starting = True
            try:
                code, _, payload = app("/api/subscriptions", {"providerId": "chatgpt", "op": "login"})
                data = json.loads(payload)
                action = data.get("browserAction", "")
                parsed = urllib.parse.urlsplit(action)
                ids = urllib.parse.parse_qs(parsed.query)
                if code != 200 or parsed.scheme or parsed.netloc or parsed.path != "/api/subscriptions/browser" or list(ids) != ["id"] or len(ids["id"]) != 1:
                    raise ValueError()
                code, headers, _ = app(action, {})
                auth_url = headers.get("Location", "")
                if code != 303: raise ValueError()
                callback, state = authorize_parts(auth_url)
                with lock:
                    active = {"callback": callback, "state": state, "expires": time.monotonic() + 180, "completing": False}
                self.send(303, location=auth_url)
            except Exception:
                self.send(400, "Giriş başlatılamadı. LearnHarness üzerinden durumu kontrol edip yeniden deneyin.".encode())
            finally:
                with lock: starting = False
            return
        transaction = None
        try:
            if set(fields) != {"callback_url"} or len(fields["callback_url"]) != 1: raise ValueError()
            supplied = callback_parts(fields["callback_url"][0].strip())
            query = urllib.parse.parse_qs(supplied.query, strict_parsing=True, keep_blank_values=True)
            if any(len(v) != 1 for v in query.values()) or not query.get("state", [""])[0] or not (query.get("code", [""])[0] or query.get("error", [""])[0]): raise ValueError()
            with lock:
                if not active or active["expires"] <= time.monotonic() or active["completing"]: raise ValueError()
                expected = active["callback"]
                if supplied.netloc != expected.netloc or not hmac.compare_digest(query["state"][0], active["state"]): raise ValueError()
                active["completing"] = True
                transaction = active
            # Reconstruct from trusted destination and narrowly accepted parameters.
            accepted = {k: query[k][0] for k in ("state", "code", "client_id", "error") if k in query}
            target = urllib.parse.urlunsplit(("http", expected.netloc, "/auth/callback", urllib.parse.urlencode(accepted), ""))
            code, _, _ = request(target)
            if code != 200: raise ValueError()
            with lock:
                if active is transaction: active = None
            self.send(303, location=PREFIX)
        except Exception:
            with lock:
                if transaction is not None and active is transaction: active["completing"] = False
            self.send(400, "Bağlantı tamamlanamadı. Adresi ve giriş süresini kontrol edin; gerekirse yeniden başlayın.".encode())

    def do_HEAD(self): self.send(405)
    def do_PUT(self): self.send(405)
    def do_DELETE(self): self.send(405)
    def do_OPTIONS(self): self.send(405)
    def do_PATCH(self): self.send(405)

if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 3001), Handler).serve_forever()
