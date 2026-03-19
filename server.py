#!/usr/bin/env python3
"""
Synapse dev server — static file server + CORS proxy for external APIs.

Usage:  python3 server.py [port]
        Default port: 8000

Proxies requests under /api/brave/* to https://api.search.brave.com/*
so the browser can call Brave Search without CORS issues.
"""

import http.server
import urllib.request
import urllib.error
import sys
import os
import json

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
BRAVE_API_BASE = "https://api.search.brave.com"


class ProxyHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/api/brave/"):
            self._proxy_brave()
        else:
            super().do_GET()

    def do_OPTIONS(self):
        if self.path.startswith("/api/brave/"):
            self.send_response(204)
            self._cors_headers()
            self.end_headers()
        else:
            super().do_OPTIONS()

    def _proxy_brave(self):
        # Strip /api/brave prefix and forward to Brave API
        remote_path = self.path[len("/api/brave"):]
        url = f"{BRAVE_API_BASE}{remote_path}"

        # Forward relevant headers (skip Accept-Encoding so we get plain text)
        headers = {}
        for key in ("X-Subscription-Token", "Accept"):
            val = self.headers.get(key)
            if val:
                headers[key] = val

        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=10) as resp:
                body = resp.read()
                self.send_response(resp.status)
                self._cors_headers()
                self.send_header("Content-Type", resp.headers.get("Content-Type", "application/json"))
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as e:
            body = e.read()
            self.send_response(e.code)
            self._cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self.send_response(502)
            self._cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "X-Subscription-Token, Accept")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")

    def log_message(self, format, *args):
        # Colorize proxy requests
        msg = format % args
        if "/api/brave/" in msg:
            print(f"\033[36m[proxy] {msg}\033[0m")
        else:
            super().log_message(format, *args)


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    with http.server.HTTPServer(("", PORT), ProxyHandler) as httpd:
        print(f"Synapse server running at http://localhost:{PORT}")
        print(f"Brave API proxy at http://localhost:{PORT}/api/brave/")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down.")
