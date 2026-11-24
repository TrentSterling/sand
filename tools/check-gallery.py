"""Check all matched images and seek the synchronized review movie in Chrome."""
import argparse
import functools
import http.server
import json
import threading
from pathlib import Path
import re
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        # Chrome needs byte ranges to seek an MP4 over HTTP. GitHub Pages
        # serves ranges, Python's SimpleHTTPRequestHandler serves whole files.
        if self.path != '/review/cycle.mp4':
            return super().do_GET()
        payload=(ROOT/'review'/'cycle.mp4').read_bytes()
        header=self.headers.get('Range')
        bounds=re.fullmatch(r'bytes=(\d+)-(\d*)',header or '')
        start=int(bounds[1]) if bounds else 0
        end=min(int(bounds[2]),len(payload)-1) if bounds and bounds[2] else len(payload)-1
        if start>end or (header and not bounds):
            self.send_error(416)
            return
        self.send_response(206 if bounds else 200)
        self.send_header('Accept-Ranges','bytes')
        self.send_header('Content-Type','video/mp4')
        if bounds:
            self.send_header('Content-Range',f'bytes {start}-{end}/{len(payload)}')
        self.send_header('Content-Length',str(end-start+1))
        self.end_headers()
        self.wfile.write(payload[start:end+1])


def inspect(url):
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel='chrome')
        page = browser.new_page(viewport={'width': 1200, 'height': 800})
        errors = []
        page.on('pageerror', lambda err: errors.append(str(err)))
        page.goto(url)
        page.wait_for_function("document.querySelector('#view').length >= 26")
        options = page.locator('optgroup option').evaluate_all('els => els.map(e=>e.value)')
        for id_ in options:
            page.select_option('#view', id_)
            page.wait_for_function("""id=>location.hash === '#'+id &&
              [...document.querySelectorAll('#stills img')].filter(i=>
              i.src.endsWith('/'+id+'.webp') && i.naturalWidth === 1600 && i.naturalHeight === 960).length === 2""",
              arg=id_)
        page.select_option('#view', 'cycle')
        page.locator('video').wait_for(state='visible')
        page.locator('video').evaluate('v=>v.play()')
        page.wait_for_function("document.querySelector('video').currentTime>.08")
        page.locator('video').evaluate("v=>{v.pause();v.currentTime=13}")
        page.wait_for_function("()=>{const v=document.querySelector('video');return v.readyState>=2 && !v.seeking && v.currentTime>=12.9}")
        movie = page.locator('video').evaluate('v => [v.duration,v.videoWidth,v.videoHeight,v.currentTime]')
        assert movie[:3] == [14.4, 1600, 480] and 12.9 <= movie[3] < 13.2, movie
        assert not errors, errors
        page.set_viewport_size({'width':393,'height':852})
        page.locator('#next').click()
        page.locator('#stills').wait_for(state='visible')
        assert page.evaluate('document.documentElement.scrollWidth===innerWidth')
        browser.close()
        return dict(pairs=len(options), movie=movie, errors=errors)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url')
    args = parser.parse_args()
    if args.url:
        print(json.dumps(inspect(args.url)))
    else:
        with http.server.ThreadingHTTPServer(('127.0.0.1',0), functools.partial(QuietHandler,directory=str(ROOT))) as server:
            thread=threading.Thread(target=server.serve_forever,daemon=True)
            thread.start()
            try:
                print(json.dumps(inspect(f'http://127.0.0.1:{server.server_port}/review/')))
            finally:
                server.shutdown()
