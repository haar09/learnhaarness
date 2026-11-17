#!/usr/bin/env python3
"""Narrow root helper: only changes one Basic Auth password; never logs secrets."""
import argparse
import grp
import json
import os
from pathlib import Path
import re
import socket
import socketserver
import subprocess
import tempfile
import time
import secrets
import bcrypt

class PasswordChanger:
    def __init__(self, credentials, username='learning', run=subprocess.run, revision_file='/var/lib/learnharness-password/session-version'):
        self.path = Path(credentials)
        self.username = username
        self.run = run
        self.attempts = []
        self.login_attempts = []
        self.revision_path = Path(revision_file)

    def revision(self, rotate=False):
        if rotate or not self.revision_path.exists():
            self.revision_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            fd, temp = tempfile.mkstemp(prefix='.revision-', dir=self.revision_path.parent)
            try:
                os.fchmod(fd, 0o600)
                with os.fdopen(fd, 'w') as out:
                    out.write(secrets.token_hex(32))
                    out.flush()
                    os.fsync(out.fileno())
                os.replace(temp, self.revision_path)
            finally:
                if os.path.exists(temp): os.unlink(temp)
        return self.revision_path.read_text()

    def credential(self):
        original = self.path.read_bytes()
        pattern = re.compile(rb'(?m)^([ \t]*' + re.escape(self.username.encode()) + rb'[ \t]+)(\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53})([ \t]*)$')
        matches = list(pattern.finditer(original))
        if len(matches) != 1: raise ValueError('unavailable')
        return original, matches[0]

    def verify(self, data):
        now = time.monotonic()
        self.login_attempts = [t for t in self.login_attempts if now - t < 900]
        if len(self.login_attempts) >= 5: return 429
        username, password = data.get('username'), data.get('password')
        if not isinstance(username, str) or not isinstance(password, str) or not password or len(password.encode()) > 72 or '\0' in password: return 400
        _, match = self.credential()
        correct = bcrypt.checkpw(password.encode(), match[2])
        if not correct or username != self.username:
            self.login_attempts.append(now)
            return 403
        self.login_attempts = []
        return 200

    def control(self, data):
        if not isinstance(data, dict): return {'status': 400}
        op = data.get('op', 'change')
        if op == 'version': return {'status': 200, 'revision': self.revision()}
        status = self.verify(data) if op == 'verify' else self.change(data) if op == 'change' else 400
        result = {'status': status}
        if status == 200: result['revision'] = self.revision()
        return result

    def change(self, data):
        now = time.monotonic()
        self.attempts = [t for t in self.attempts if now - t < 900]
        if len(self.attempts) >= 5:
            return 429
        self.attempts.append(now)
        if not isinstance(data, dict):
            return 400
        old, new, confirm = (data.get(k) for k in ('currentPassword', 'newPassword', 'confirmPassword'))
        if any(not isinstance(v, str) for v in (old, new, confirm)):
            return 400
        if not old or len(old.encode()) > 72 or len(new) < 12 or len(new.encode()) > 72 or new != confirm or '\0' in old + new:
            return 400
        try:
            original, match = self.credential()
        except Exception:
            return 503
        if not bcrypt.checkpw(old.encode(), match[2]):
            return 403
        updated = original[:match.start(2)] + bcrypt.hashpw(new.encode(), bcrypt.gensalt(rounds=14)) + original[match.end(2):]
        self.write(updated)
        try:
            self.run(['/usr/bin/caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
            self.run(['/usr/bin/systemctl', 'reload', 'caddy'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
        except Exception:
            self.write(original)
            try:
                self.run(['/usr/bin/systemctl', 'reload', 'caddy'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
            except Exception:
                pass
            return 503
        try:
            self.revision(rotate=True)
        except Exception:
            self.write(original)
            try:
                self.run(['/usr/bin/systemctl', 'reload', 'caddy'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
            except Exception:
                pass
            return 503
        return 200

    def write(self, value):
        stat = self.path.stat()
        fd, temp = tempfile.mkstemp(prefix='.users-', dir=self.path.parent)
        try:
            os.fchmod(fd, stat.st_mode & 0o777)
            os.fchown(fd, stat.st_uid, stat.st_gid)
            with os.fdopen(fd, 'wb') as out:
                out.write(value)
                out.flush()
                os.fsync(out.fileno())
            os.replace(temp, self.path)
        finally:
            if os.path.exists(temp):
                os.unlink(temp)

class Server(socketserver.UnixStreamServer):
    # Serialized requests bound bcrypt work and prevent update races.
    request_queue_size = 128

class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(5)
        try:
            raw = self.rfile.readline(4097)
            if len(raw) > 4096 or not raw.endswith(b'\n'):
                status = 400
            else:
                result = self.server.changer.control(json.loads(raw))
                self.wfile.write(json.dumps(result).encode() + b'\n')
                return
        except Exception:
            status = 503
        self.wfile.write(json.dumps({'status': status}).encode() + b'\n')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--credentials-file', default='/etc/caddy/learnharness-users.caddy')
    parser.add_argument('--socket', default='/run/learnharness-password/helper.sock')
    args = parser.parse_args()
    if os.path.exists(args.socket):
        os.unlink(args.socket)
    with Server(args.socket, Handler) as server:
        os.chown(args.socket, 0, grp.getgrnam('learnharness').gr_gid)
        os.chmod(args.socket, 0o660)
        server.changer = PasswordChanger(args.credentials_file)
        server.serve_forever()
