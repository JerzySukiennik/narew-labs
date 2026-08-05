"""Static server for local checking.

Plain http.server lets the browser cache ES modules across an edit, which reads
as "my fix did nothing" and costs a debugging round every time. Nothing here is
content-hashed, so no-store is the correct answer locally.
"""

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCache(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8141
    root = sys.argv[2] if len(sys.argv) > 2 else "."
    ThreadingHTTPServer(("127.0.0.1", port), partial(NoCache, directory=root)).serve_forever()
