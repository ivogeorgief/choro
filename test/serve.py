#!/usr/bin/env python3
"""Test server for the Choro torture pages.

Serves this directory on two ports (the second is a different origin, for
cross-origin iframes) plus a few endpoints static files can't provide:

  /slow?ms=3000          a page that takes that long to arrive
  /redirect?n=3          a chain of n redirects ending at /landed
  /landed                where the redirect chain ends
  POST /echo             a page listing the posted form fields
  /download              a file sent as an attachment
  /alert-on-load         a page that calls alert() while loading
  /api/echo              JSON echo of the method, query and body (GET or POST)
  /api/fail?code=500     an error response with that status
  /ws                    a WebSocket that echoes text messages

Usage: python3 test/serve.py   (then open http://127.0.0.1:8701/torture.html)
"""

import base64
import hashlib
import html
import http.server
import json
import struct
import os
import threading
import time
import urllib.parse

ROOT = os.path.dirname(os.path.abspath(__file__))
PORTS = (8701, 8702)


def page(title, body):
    return (
        f'<!doctype html><html><head><meta charset="utf-8"><title>{html.escape(title)}</title></head>'
        f'<body style="font:15px sans-serif"><h1>{html.escape(title)}</h1>{body}</body></html>'
    ).encode()


class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # browsers refuse WebSocket upgrades over HTTP/1.0
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, *args):
        pass

    def send_page(self, body, status=200, headers=()):
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def websocket_echo(self):
        key = self.headers["Sec-WebSocket-Key"]
        accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        sock = self.connection
        rfile = self.rfile

        def send(opcode, payload):
            n = len(payload)
            head = bytes([0x80 | opcode]) + (bytes([n]) if n < 126 else bytes([126]) + struct.pack(">H", n) if n < 65536 else bytes([127]) + struct.pack(">Q", n))
            sock.sendall(head + payload)

        while True:
            hdr = rfile.read(2)
            if len(hdr) < 2:
                return
            opcode, n = hdr[0] & 0x0F, hdr[1] & 0x7F
            if n == 126:
                n = struct.unpack(">H", rfile.read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", rfile.read(8))[0]
            mask = rfile.read(4) if hdr[1] & 0x80 else b"\0\0\0\0"
            data = bytes(b ^ mask[i % 4] for i, b in enumerate(rfile.read(n)))
            if opcode == 0x8:  # close
                send(0x8, data[:2])
                return
            if opcode == 0x9:  # ping
                send(0xA, data)
            elif opcode == 0x1:
                send(0x1, b"echo: " + data)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(url.query)
        if url.path == "/ws" and self.headers.get("Upgrade", "").lower() == "websocket":
            return self.websocket_echo()
        if url.path == "/api/echo":
            return self.send_json({"method": "GET", "query": {k: v[0] for k, v in q.items()}})
        if url.path == "/api/fail":
            code = int(q.get("code", ["500"])[0])
            return self.send_json({"error": f"failed on purpose with {code}"}, code)
        if url.path == "/slow":
            ms = int(q.get("ms", ["3000"])[0])
            time.sleep(ms / 1000)
            return self.send_page(page("Slow page loaded", f"<p>Arrived after {ms} ms.</p>"))
        if url.path == "/redirect":
            n = int(q.get("n", ["3"])[0])
            target = f"/redirect?n={n - 1}" if n > 1 else "/landed"
            self.send_response(302)
            self.send_header("Location", target)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if url.path == "/landed":
            return self.send_page(page("Redirect landed", "<p>The redirect chain ended here.</p>"))
        if url.path == "/download":
            body = b"choro download test\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Disposition", 'attachment; filename="choro-test.txt"')
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if url.path == "/alert-on-load":
            return self.send_page(
                page("Alert on load", '<p id="after">Page continued after the alert.</p>'
                     "<script>alert('Hello while loading');</script>")
            )
        return super().do_GET()

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        if url.path == "/api/login":
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            return self.send_json({"ok": True, "token": "not-a-real-token"})
        if url.path == "/api/echo":
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length).decode(errors="replace")
            return self.send_json({"method": "POST", "contentType": self.headers.get("Content-Type"), "body": raw})
        if url.path != "/echo":
            return self.send_page(page("Not found", ""), 404)
        length = int(self.headers.get("Content-Length", 0))
        fields = urllib.parse.parse_qs(self.rfile.read(length).decode())
        rows = "".join(
            f'<li><span class="k">{html.escape(k)}</span> = <span class="v">{html.escape(", ".join(v))}</span></li>'
            for k, v in fields.items()
        )
        return self.send_page(page("Form received", f"<ul id='posted'>{rows}</ul>"))


def serve(port):
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    for p in PORTS[1:]:
        threading.Thread(target=serve, args=(p,), daemon=True).start()
    print(f"Serving {ROOT} on " + ", ".join(f"http://127.0.0.1:{p}" for p in PORTS))
    serve(PORTS[0])
