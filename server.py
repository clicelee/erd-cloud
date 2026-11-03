#!/usr/bin/env python3
"""개발용 정적 서버 — 캐시 없이 항상 최신 파일을 제공한다."""
import http.server


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()


if __name__ == '__main__':
    addr = ('127.0.0.1', 5199)
    print(f'ERD CLOUD dev server: http://{addr[0]}:{addr[1]}')
    http.server.ThreadingHTTPServer(addr, NoCacheHandler).serve_forever()
