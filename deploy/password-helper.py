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
import bcrypt

class PasswordChanger:
    def __init__(self, credentials, username='learning', run=subprocess.run):
        self.path = Path(credentials)
        self.username = username
        self.run = run
        self.attempts = []

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
        original = self.path.read_bytes()
        pattern = re.compile(rb'(?m)^([ \t]*' + re.escape(self.username.encode()) + rb'[ \t]+)(\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53})([ \t]*)$')
        matches = list(pattern.finditer(original))
        if len(matches) != 1:
            return 503
        match = matches[0]
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
    request_queue_size = 4

class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(5)
        try:
            raw = self.rfile.readline(4097)
            if len(raw) > 4096 or not raw.endswith(b'\n'):
                status = 400
            else:
                status = self.server.changer.change(json.loads(raw))
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
