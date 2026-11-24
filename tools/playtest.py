"""Exercise the shipped page with real browser input and capture a local performance receipt."""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--url", default=(ROOT / "index.html").as_uri())
parser.add_argument("--out", default=str(ROOT / ".work" / "playtest"))
args = parser.parse_args()
out = Path(args.out).resolve()
out.mkdir(parents=True, exist_ok=True)
state = "() => window.sandLab.state()"

with sync_playwright() as pw:
    browser = pw.chromium.launch(channel="chrome", headless=True, args=[
        "--enable-gpu", "--use-angle=d3d11", "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    ])
    page = browser.new_page(viewport={"width":1440,"height":900},device_scale_factor=1)
    page.add_init_script("""window.frameSamples=[];
        {let last=0;function sample(now){
          if(last && window.sandLab && document.querySelector('[data-action][aria-pressed="true"]')){
            window.frameSamples.push(now-last);
          }
          last=now;requestAnimationFrame(sample);
        }requestAnimationFrame(sample);}""")
    errors, requests = [], []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
    page.on("request", lambda req: requests.append(req.url))
    page.goto(args.url, wait_until="load")
    page.wait_for_function("window.sandLab && window.sandLab.state().frame>20",timeout=45000)
    graphics=page.evaluate("""() => {const gl=document.querySelector('canvas').getContext('webgl2');
      const d=gl.getExtension('WEBGL_debug_renderer_info'); return d?gl.getParameter(d.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);}""")
    page.screenshot(path=out/"quarry.png")
    states=[]
    def operate(action):
        page.locator('[data-action="'+action+'"]').click()
        page.wait_for_function("window.sandLab.state().action === ''", timeout=45000)
        result=page.evaluate(state)
        states.append({"action":action,**result})
        print(action,result["frame"],result["load"],result["bay"],result["fps"],flush=True)
        assert result["massError"]==0
        return result
    assert operate("dig")["load"] > 35000
    assert operate("lift")["load"] > 35000
    page.screenshot(path=out/"loaded.png")
    operate("swing")
    operate("dump")
    page.wait_for_function("window.sandLab.state().done",timeout=18000)
    assert page.evaluate(state)["bay"]>=48000
    page.locator("#labToggle").click()
    page.locator("#bench").click()
    page.wait_for_function("window.sandLab.lastBenchmark !== null",timeout=30000)
    bench=page.evaluate("window.sandLab.lastBenchmark")
    assert bench["match"] and bench["massError"]==0 and bench["pairs"][0]<bench["pairs"][1]
    page.locator("#scenario").select_option("avalanche")
    page.locator("#bench").click()
    page.wait_for_function("window.sandLab.lastBenchmark?.source==='Quarry-wide avalanche'")
    stress=page.evaluate("window.sandLab.lastBenchmark")
    assert stress["match"] and stress["massError"]==0
    page.locator("#tiles").click()
    assert page.locator("#tiles").get_attribute("aria-pressed")=="true"
    page.locator("#tiles").click()
    page.locator("#pause").click()
    frozen=page.evaluate(state)["frame"]
    page.locator("#step").click()
    assert page.evaluate(state)["frame"]==frozen+1
    page.locator("#pause").click()
    page.locator("#labToggle").click()
    page.locator("#nextJob").click()
    for _ in range(3):
        for action in ["dig","lift","swing","dump"]: operate(action)
        page.wait_for_function("window.sandLab.state().air===0 && window.sandLab.state().load===0")
        page.wait_for_timeout(300)
        if page.evaluate(state)["done"]:break
    assert page.evaluate(state)["done"],page.evaluate(state)
    page.locator("#nextJob").click()
    assert page.evaluate(state)["job"]==2
    page.keyboard.down("ArrowDown")
    page.wait_for_timeout(500)
    page.keyboard.up("ArrowDown")
    moved=page.evaluate(state)
    assert moved["manual"] and moved["base"]["x"]<-.15
    angle=moved["pose"]["boom"]
    page.keyboard.down("w");page.wait_for_timeout(250);page.keyboard.up("w")
    assert abs(page.evaluate(state)["pose"]["boom"]-angle)>.02
    page.locator("#helpToggle").click()
    durations=sorted(page.evaluate("window.frameSamples"))
    pacing={"frameSamples":len(durations),"medianFrameMs":durations[len(durations)//2],
            "p95FrameMs":durations[int(len(durations)*.95)]}
    with page.expect_download() as transfer: page.locator("#offline").click()
    offline=out/"SandLab.html"
    transfer.value.save_as(offline)
    page.locator("#reset").click()
    assert page.evaluate(state)["bay"]==0
    page.locator("#helpToggle").click()
    page.set_viewport_size({"width":393,"height":852})
    page.reload()
    page.wait_for_function("window.sandLab && window.sandLab.state().frame>10")
    assert page.locator('[data-action="dig"]').is_visible()
    page.screenshot(path=out/"mobile.png")
    offline_page=browser.new_page()
    offline_calls=[]
    offline_page.on("request",lambda req: offline_calls.append(req.url) if req.url.startswith(("http:","https:")) else None)
    offline_page.route("http**/*",lambda route:route.abort())
    offline_page.goto(offline.as_uri())
    offline_page.wait_for_function("window.sandLab && window.sandLab.state().frame>10")
    for key in ("1","2","3","4"):
        offline_page.keyboard.press(key)
        offline_page.wait_for_function("window.sandLab.state().action === ''",timeout=45000)
    offline_page.wait_for_function("window.sandLab.state().done",timeout=18000)
    assert offline_page.evaluate(state)["massError"]==0
    assert not offline_calls
    report={"url":args.url,"graphics":graphics,"browser":browser.version,"viewport":[1440,900],
            "states":states,"benchmark":bench,"avalanche":stress,"framePacing":pacing,"errors":errors,"offlineNetworkRequests":offline_calls,
            "pageRequests":requests[:10],"bothJobsComplete":True,"offlineOrderComplete":True,"offlineDownloadBytes":offline.stat().st_size}
    (out/"playtest.json").write_text(json.dumps(report,indent=2),encoding="utf-8")
    print(json.dumps({k:report[k] for k in ["graphics","benchmark","avalanche","framePacing","errors","bothJobsComplete","offlineDownloadBytes"]}))
    assert not errors, errors
    browser.close()
