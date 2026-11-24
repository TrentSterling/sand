"""Drive the shipped page with real keys, then check terrain replay and the video gallery."""
import argparse
import json
from pathlib import Path
from urllib.parse import urljoin
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--url', default=(root/'index.html').as_uri())
parser.add_argument('--browser', choices=['chrome','firefox'], default='chrome')
parser.add_argument('--out', default=str(root/'.work'/'driving-browser.json'))
args = parser.parse_args()
with sync_playwright() as pw:
    if args.browser == 'firefox':
        browser = pw.firefox.launch(firefox_user_prefs={'webgl.force-enabled':True,'webgl.disabled':False})
    else:
        browser = pw.chromium.launch(channel='chrome',args=['--enable-gpu','--use-angle=d3d11'])
    page = browser.new_page(viewport={'width':1280,'height':800})
    errors = []
    page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto(args.url)
    page.wait_for_function('window.sandLab?.state().chassis.massKg>20000',timeout=45000)
    state = lambda: page.evaluate('sandLab.state()')
    def ticks(count):
        page.wait_for_function('f=>sandLab.state().frame>=f',arg=state()['frame']+count,timeout=45000)
    def hold(key, count):
        page.keyboard.down(key)
        try: ticks(count)
        finally: page.keyboard.up(key)
    def drive_until(key, condition):
        page.keyboard.down(key)
        try: page.wait_for_function(condition,timeout=60000)
        finally: page.keyboard.up(key)
    hold('w',36)
    drive_until('ArrowUp','sandLab.state().base.x>=5.18')
    brake=state()
    ticks(86)
    hold('q',86)
    ticks(55)
    parked=state()
    assert abs(parked['base']['x']-brake['base']['x'])<.45
    hold('ArrowUp',147)
    descent=state()
    assert descent['base']['x']>parked['base']['x']+1
    drive_until('ArrowDown','sandLab.state().base.x<=5.65 && sandLab.state().chassis.speed<-.2')
    ticks(90)
    end=state()
    assert abs(end['chassis']['roll'])<.4 and abs(end['chassis']['pitch'])<.75 and end['massError']==0
    page.locator('#labToggle').click()
    page.locator('#forces').click()
    assert page.locator('#forces').get_attribute('aria-pressed')=='true'
    page.locator('#bench').click()
    page.wait_for_function('sandLab.lastBenchmark!==null')
    replay=page.evaluate('sandLab.lastBenchmark')
    assert replay['match'] and replay['liveMatch'] and replay['massError']==0,replay
    page.goto(urljoin(args.url,'review/drive/index.html'))
    for value in ['brake','opposite','approach','slew','descent','reverse']:
        page.locator('#stage').select_option(value)
        page.wait_for_function('s=>["before","after"].every(id=>{const im=document.getElementById(id);return im.currentSrc.includes(s+".webp") && im.complete && im.naturalWidth>0;})',arg=value)
    page.locator('#brake').click()
    page.wait_for_function('[...document.querySelectorAll("video")].every(v=>v.currentTime>3 && !v.paused && v.videoWidth>0)')
    page.locator('#pause').click()
    assert not errors,errors
    result=dict(browser=args.browser,version=browser.version,parkedDeltaX=parked['base']['x']-brake['base']['x'],
        descendingX=descent['base']['x'],returnedX=end['base']['x'],massError=end['massError'],
        supportPatches=end['chassis']['supportCount'],replay=replay,errors=errors)
    out=Path(args.out);out.parent.mkdir(parents=True,exist_ok=True)
    out.write_text(json.dumps(result,indent=2)+'\n',encoding='utf8')
    print(json.dumps(result))
    browser.close()
