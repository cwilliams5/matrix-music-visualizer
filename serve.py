#!/usr/bin/env python3
"""
matrix-music-viz static server.

A tiny static file server that — unlike `python -m http.server` — honors HTTP
**Range** requests (206 Partial Content). The browser's <audio> element needs
Range to SEEK a served file; without it, dragging the seek bar restarts the
track from the beginning. Also **threaded**, so streaming a track's bytes never
blocks concurrent shader / asset fetches.

Any Range-capable static server works (e.g. `npx serve`); this script is the
zero-dependency, foolproof option that ships with the prototype.

Usage:  python serve.py [port]      # default port 8099
        open http://localhost:8099
"""

import os
import sys
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class RangeHandler(SimpleHTTPRequestHandler):
    """SimpleHTTPRequestHandler + single-range (206) support for media seeking."""

    def send_head(self):
        # Only intercept GETs carrying a Range header; everything else (HEAD,
        # directory listings, ranged HEADs) falls back to the stock handler.
        range_header = self.headers.get("Range")
        if range_header is None or self.command != "GET":
            return super().send_head()

        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()
        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return None

        try:
            stat = os.fstat(f.fileno())
            file_len = stat.st_size
            start, end = self._parse_range(range_header, file_len)
            if start is None:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", "bytes */%d" % file_len)
                self.end_headers()
                f.close()
                return None

            length = end - start + 1
            self.send_response(HTTPStatus.PARTIAL_CONTENT)
            self.send_header("Content-Type", self.guess_type(path))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, file_len))
            self.send_header("Content-Length", str(length))
            self.send_header("Last-Modified", self.date_time_string(stat.st_mtime))
            self.end_headers()
            f.seek(start)
            self._range_remaining = length
            return f
        except Exception:
            f.close()
            raise

    def copyfile(self, source, outputfile):
        # When a range was served, copy only the requested slice.
        remaining = getattr(self, "_range_remaining", None)
        if remaining is None:
            return super().copyfile(source, outputfile)
        self._range_remaining = None
        while remaining > 0:
            chunk = source.read(min(64 * 1024, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)

    @staticmethod
    def _parse_range(header, file_len):
        # Parse the first "bytes=start-end" range (the only form browsers send for <audio>).
        if not header.startswith("bytes="):
            return None, None
        spec = header[len("bytes="):].split(",")[0].strip()
        if "-" not in spec:
            return None, None
        start_s, end_s = spec.split("-", 1)
        try:
            if start_s == "":
                # suffix range: the last N bytes
                n = int(end_s)
                if n == 0:
                    return None, None
                start = max(0, file_len - n)
                end = file_len - 1
            else:
                start = int(start_s)
                end = int(end_s) if end_s else file_len - 1
        except ValueError:
            return None, None
        if start >= file_len or start > end:
            return None, None
        return start, min(end, file_len - 1)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8099
    directory = os.path.dirname(os.path.abspath(__file__))
    handler = partial(RangeHandler, directory=directory)
    with ThreadingHTTPServer(("", port), handler) as httpd:
        print("matrix-music-viz: serving %s" % directory)
        print("           http://localhost:%d/   (Range-enabled, threaded)" % port)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nbye")


if __name__ == "__main__":
    main()
