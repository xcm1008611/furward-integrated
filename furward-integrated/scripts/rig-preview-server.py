#!/usr/bin/env python3
"""Local-only visual QA server; accepts PNG captures only in animated/previews."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import unquote
import re
import subprocess

ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,directory=str(ROOT),**kwargs)
    def do_GET(self):
        if self.path == '/rig-foot-contact.js':
            # Preview exactly the production constraint, not a second JS copy.
            script = "import{stripTypeScriptTypes}from'node:module';import{readFileSync}from'node:fs';process.stdout.write(stripTypeScriptTypes(readFileSync(process.argv[1],'utf8')));"
            result = subprocess.run(['node','--input-type=module','-e',script,str(ROOT/'web/lib/foot-contact.ts')],capture_output=True,check=True)
            self.send_response(200);self.send_header('Content-Type','text/javascript');self.end_headers();self.wfile.write(result.stdout)
            return
        super().do_GET()
    def do_POST(self):
        name=unquote(self.path.removeprefix('/save-preview/'))
        length=int(self.headers.get('Content-Length','0'))
        if not self.path.startswith('/save-preview/') or not re.fullmatch(r'[a-z_]+-\d+\.\d+-(mesh|bones)\.png',name) or not 0<length<12_000_000:
            self.send_error(400);return
        data=self.rfile.read(length)
        if not data.startswith(b'\x89PNG\r\n\x1a\n'):
            self.send_error(400);return
        out=ROOT/'web/public/city/animated/previews'
        out.mkdir(parents=True,exist_ok=True)
        (out/name).write_bytes(data)
        self.send_response(201);self.end_headers();self.wfile.write(b'saved')

if __name__=='__main__':
    print('Rig QA: http://127.0.0.1:8876/scripts/rig-preview.html',flush=True)
    ThreadingHTTPServer(('127.0.0.1',8876),Handler).serve_forever()
