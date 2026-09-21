#!/usr/bin/env python3
"""Local test server for the frontend. It tells the browser never to keep old copies of the files,
so after you replace the folder with a newer version you always see the newest one.

Run in this folder:   python dev-server.py        (then open http://localhost:8000/teacher/)
Another port:         python dev-server.py 8123
"""
import http.server
import os
import socketserver
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    with Server(("", port), NoCacheHandler) as httpd:
        print(f"Open http://localhost:{port}/teacher/  (Ctrl+C to stop)")
        httpd.serve_forever()
