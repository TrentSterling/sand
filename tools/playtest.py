"""Exercise the shipped page with real browser input and capture a local performance receipt."""
import argparse
import io
import json
from pathlib import Path
from PIL import Image, ImageChops, ImageStat
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--url", default=(ROOT / "index.html").as_uri())
parser.add_argument("--out", default=str(ROOT / ".work" / "playtest"))
args = parser.parse_args()
out = Path(args.out).resolve()
out.mkdir(parents=True, exist_ok=True)
state = "() => window.sandLab.state()"
CAPACITY = round(0.55 * 64000)
ACTIONS = ("dig", "lift", "swing", "dump")


def finish_order(tab, minimum_cycles, *, keyboard=False, record=None, loaded_image=None):
    """Operate completed physical cycles until the job's delivery counter trips."""
    cycles = []
    for cycle in range(1, minimum_cycles + 6):
        results = {}
        for number, action in enumerate(ACTIONS, 1):
            if keyboard:
                tab.keyboard.press(str(number))
            else:
                tab.locator(f'[data-action="{action}"]').click()
            tab.wait_for_function("name=>window.sandLab.state().action === name", arg=action)
            tab.wait_for_function("window.sandLab.state().action === ''", timeout=45000)
            s = tab.evaluate(state)
            assert s["massError"] == 0 and 0 <= s["load"] <= CAPACITY, (action,s)
            results[action] = s["load"]
            if record is not None:
                record.append({"command":action, "cycle":cycle, **s})
            if cycle == 1 and action == "lift" and loaded_image:
                tab.screenshot(path=loaded_image)
        assert results["dig"] > 0 and results["lift"] > 0, results
        tab.wait_for_function("!window.sandLab.state().air && !window.sandLab.state().load", timeout=12000)
        settled = tab.evaluate(state)
        # hud() checks delivery at 4 Hz after the last parcel has landed.
        tab.wait_for_function("frame=>{const s=window.sandLab.state();return s.done || s.frame>=frame+20}",
                              arg=settled["frame"])
        s = tab.evaluate(state)
        assert s["massError"] == 0
        cycles.append({"cycle":cycle, "bay":s["bay"], "markMass":s["markMass"], "loads":results})
        print("order",s["job"],"cycle",cycle,"bay",s["bay"],"marked",s["markMass"],flush=True)
        if s["done"]:
            assert cycle >= minimum_cycles, (cycle,minimum_cycles,s)
            return cycles
    raise AssertionError(f"Order still open after {len(cycles)} cycles: {s}")


def exercise_cut_view(tab, *, touch=False):
    """Use browser pointer input to move the teeth, then orbit a paused world."""
    click = lambda selector: tab.locator(selector).tap() if touch else tab.locator(selector).click()
    session = tab.context.new_cdp_session(tab) if touch else None
    def pointer(event,x,y):
        if session:
            points=[] if event=="end" else [{"x":x,"y":y,"id":1}]
            session.send("Input.dispatchTouchEvent",{"type":{"start":"touchStart","move":"touchMove","end":"touchEnd"}[event],"touchPoints":points})
        elif event=="start":
            tab.mouse.move(x,y)
            tab.mouse.down()
        elif event=="move":
            tab.mouse.move(x,y,steps=12)
        else:
            tab.mouse.up()

    def wait_ticks(count):
        target=tab.evaluate(state)["frame"]+count
        tab.wait_for_function("f=>window.sandLab.state().frame>=f",arg=target)

    w,h=tab.viewport_size["width"],tab.viewport_size["height"]
    click("#cutView")
    assert tab.locator("#cutView").get_attribute("aria-pressed")=="true"
    assert tab.evaluate(state)["manual"] and tab.evaluate(state)["cutView"]
    pointer("start",w*.76,h*.43)
    try:
        wait_ticks(38)
        from_tip=tab.evaluate(state)["tip"]
        pointer("move",w*.61,h*.57)
        tab.wait_for_function("""old=>{const tip=window.sandLab.state().tip;
            return Math.hypot(...tip.map((v,k)=>v-old[k]))>.30}""",arg=from_tip,timeout=5000)
        wait_ticks(18)
        to_tip=tab.evaluate(state)["tip"]
    finally:
        pointer("end",w*.61,h*.57)
    def curl(key, button):
        if session:
            b=tab.locator('[data-hold="'+button+'"]').bounding_box()
            x,y=b["x"]+b["width"]/2,b["y"]+b["height"]/2
            pointer("start",x,y)
            try: wait_ticks(18)
            finally: pointer("end",x,y)
        else:
            tab.keyboard.down(key)
            try: wait_ticks(18)
            finally: tab.keyboard.up(key)
        return tab.evaluate(state)["pose"]["curl"]
    opened=curl("f","curlOut")
    closed=curl("r","curlIn")
    assert closed>opened+.03,(opened,closed)
    click("#cutView")
    assert tab.locator("#cutView").get_attribute("aria-pressed")=="false"
    assert not tab.evaluate(state)["cutView"]
    click("#labToggle")
    click("#pause")
    frozen=tab.evaluate(state)["frame"]
    click("#labToggle")
    def thumb():
        with Image.open(io.BytesIO(tab.locator("#view").screenshot())) as im:
            return im.convert("RGB").resize((144,90))
    before=thumb()
    pointer("start",w*.64,h*.48)
    pointer("move",w*.45,h*.50)
    pointer("end",w*.45,h*.50)
    tab.wait_for_timeout(200)
    change=sum(ImageStat.Stat(ImageChops.difference(before,thumb())).mean)/3
    assert change>2 and tab.evaluate(state)["frame"]==frozen,(change,frozen)
    click("#cutView")
    click("#helpToggle")
    click("#reset")
    reset=tab.evaluate(state)
    assert not reset["cutView"] and not reset["manual"] and not reset["paused"]
    assert reset["load"]==reset["bay"]==reset["massError"]==0 and reset["job"]==0
    if session:
        session.detach()
    if tab.locator("#help").is_visible():
        click("#helpToggle")
    return {"dragStartTip":from_tip,"dragEndTip":to_tip,"openedCurl":opened,"closedCurl":closed,
            "pausedOrbitPixelChange":round(change,3),"resetFromPausedCutView":True}

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
    page.on("console", lambda msg: errors.append(f"{msg.text} ({msg.location['url']})") if msg.type == "error" else None)
    page.on("request", lambda req: requests.append(req.url))
    page.goto(args.url, wait_until="load")
    page.wait_for_function("window.sandLab && window.sandLab.state().frame>20",timeout=45000)
    graphics=page.evaluate("""() => {const gl=document.querySelector('canvas').getContext('webgl2');
      const d=gl.getExtension('WEBGL_debug_renderer_info'); return d?gl.getParameter(d.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);}""")
    page.screenshot(path=out/"quarry.png")
    states=[]
    bay_cycles=finish_order(page,2,record=states,loaded_image=out/"loaded.png")
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
    stockpile_cycles=finish_order(page,3,record=states)
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
    desktop_cut=exercise_cut_view(page)
    mobile=browser.new_page(viewport={"width":393,"height":852},device_scale_factor=1,is_mobile=True,has_touch=True)
    mobile.on("pageerror", lambda e:errors.append("mobile: "+str(e)))
    mobile.goto(args.url)
    mobile.wait_for_function("window.sandLab && window.sandLab.state().frame>10")
    assert mobile.locator('[data-action="dig"]').is_visible()
    assert mobile.evaluate("document.documentElement.scrollWidth === innerWidth")
    mobile.screenshot(path=out/"mobile.png")
    mobile_cut=exercise_cut_view(mobile,touch=True)
    mobile.close()
    offline_page=browser.new_page()
    offline_calls=[]
    offline_page.on("request",lambda req: offline_calls.append(req.url) if req.url.startswith(("http:","https:")) else None)
    offline_page.route("http**/*",lambda route:route.abort())
    offline_page.goto(offline.as_uri())
    offline_page.wait_for_function("window.sandLab && window.sandLab.state().frame>10")
    offline_bay_cycles=finish_order(offline_page,2,keyboard=True)
    offline_page.locator("#nextJob").click()
    offline_stockpile_cycles=finish_order(offline_page,3,keyboard=True)
    assert offline_page.evaluate(state)["massError"]==0
    assert not offline_calls
    report={"url":args.url,"graphics":graphics,"browser":browser.version,"viewport":[1440,900],
            "states":states,"benchmark":bench,"avalanche":stress,"framePacing":pacing,"errors":errors,"offlineNetworkRequests":offline_calls,
            "pageRequests":requests[:10],"bothJobsComplete":True,"offlineOrderComplete":True,"offlineDownloadBytes":offline.stat().st_size,
            "orderCycles":{"bay":bay_cycles,"stockpile":stockpile_cycles,"offlineBay":offline_bay_cycles,
                          "offlineStockpile":offline_stockpile_cycles},"cutView":{"desktop":desktop_cut,"touch":mobile_cut}}
    (out/"playtest.json").write_text(json.dumps(report,indent=2),encoding="utf-8")
    print(json.dumps({k:report[k] for k in ["graphics","benchmark","avalanche","framePacing","errors","bothJobsComplete","offlineDownloadBytes"]}))
    assert not errors, errors
    browser.close()
