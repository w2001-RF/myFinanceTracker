"""Tiny Robot Framework library: serves a folder over HTTP on a free port, inside the Robot process.

Running it in-process (instead of starting `python -m http.server`) means a free port is always used
(no clash with other dev servers) and no stray server process can be left behind after a run.
"""
import functools
import http.server
import threading


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):  # keep the test output clean
        pass


class _QuietServer(http.server.ThreadingHTTPServer):
    def handle_error(self, request, client_address):  # browsers abort connections when they navigate away
        pass


class StaticServer:
    ROBOT_LIBRARY_SCOPE = 'GLOBAL'

    def __init__(self):
        self._httpd = None
        self._thread = None

    def start_static_server(self, directory):
        """Starts serving `directory` on 127.0.0.1 and returns the port that was chosen."""
        if self._httpd is not None:
            raise RuntimeError('The static server is already running')
        handler = functools.partial(_QuietHandler, directory=str(directory))
        self._httpd = _QuietServer(('127.0.0.1', 0), handler)
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()
        return self._httpd.server_address[1]

    def stop_static_server(self):
        if self._httpd is None:
            return
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=5)
        self._httpd = None
        self._thread = None
