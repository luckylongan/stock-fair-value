#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本機預覽用的小型靜態伺服器。

網站會用 fetch() 讀取 data/*.json，直接用 file:// 開啟 index.html 會被瀏覽器
擋下，所以本機測試請透過這支程式（或任何靜態伺服器）瀏覽：

    python3 scripts/serve.py          # http://localhost:8899
    python3 scripts/serve.py 9000     # 自訂連接埠
"""

import functools
import http.server
import os
import socketserver
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # 本機開發時不要快取，改了檔案重整就看得到
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
    os.chdir(ROOT)
    socketserver.TCPServer.allow_reuse_address = True
    handler = functools.partial(Handler, directory=ROOT)
    with socketserver.TCPServer(("127.0.0.1", port), handler) as httpd:
        print("網站已啟動： http://localhost:%d" % port)
        print("根目錄： %s" % ROOT)
        print("按 Ctrl+C 結束")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
