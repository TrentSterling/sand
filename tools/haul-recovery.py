"""Push into the Mule with the track keys, recover, and finish the same paid load."""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--url", default=(root / "index.html").as_uri() + "?yard=haul")
parser.add_argument("--out", type=Path, default=root / ".work/haul-contact")
parser.add_argument("--browser", choices=["firefox","chromium"], default="chromium")
args = parser.parse_args()
args.out.mkdir(parents=True, exist_ok=True)
with sync_playwright() as pw:
    browser = (pw.firefox.launch(firefox_user_prefs={"webgl.force-enabled": True})
               if args.browser == "firefox" else pw.chromium.launch(channel="chromium", args=["--enable-gpu","--use-angle=d3d11"]))
    page = browser.new_page(viewport={"width":1280,"height":800})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(args.url)
    page.wait_for_function("window.sandLab?.state().yard === 'haul'")

    def state():
        return page.evaluate("sandLab.state()")

    def act(name):
        page.locator(f'[data-action="{name}"]').click()
        page.wait_for_function("a=>sandLab.state().action===a", arg=name)
        page.wait_for_function("sandLab.state().action===''", timeout=45000)

    for action in ("dig","lift","swing","dump","dig","lift"):
        act(action)
    original = state()
    assert original["truckLoads"][0] > 15000 and original["load"] > 15000
    page.locator("#manual").click()
    page.keyboard.down("ArrowDown")
    try:
        page.wait_for_function("sandLab.state().base.x < -.7")
        page.wait_for_function("Number.isFinite(sandLab.state().truckClearance) && sandLab.state().truckClearance < .035")
        page.wait_for_function("f=>sandLab.state().frame>f",arg=state()["frame"]+100)
    finally:
        page.keyboard.up("ArrowDown")
    impact = state()
    assert impact["truckClearance"] > -.04 and impact["base"]["y"] < .45, impact
    page.screenshot(path=args.out / "track-contact.png")
    page.locator("#helpToggle").click()
    before = state()
    page.locator("#recover").click()
    recovered = state()
    assert abs(recovered["base"]["x"])+abs(recovered["base"]["z"]) < .075, recovered
    assert recovered["truckLoads"] == before["truckLoads"] and recovered["load"] == before["load"] and recovered["massError"] == 0
    page.locator("#manual").click()
    for action in ("swing","dump"):
        act(action)
    page.wait_for_function("sandLab.state().done",timeout=12000)
    page.locator("#labToggle").click()
    page.locator("#truckSprings").wait_for(state="visible")
    page.locator("#bench").click()
    page.wait_for_function("sandLab.lastBenchmark !== null", timeout=60000)
    replay = page.evaluate("sandLab.lastBenchmark")
    assert replay["match"] and replay["liveMatch"] is not False and replay["massError"] == 0 and not errors
    result={"browser":args.browser,"contactClearanceM":impact["truckClearance"],"contactPosition":impact["base"],
            "retainedBucketM3":recovered["load"]/64000,"retainedTruckM3":recovered["truckLoads"][0]/64000,
            "finished":state()["done"],"replay":replay}
    (args.out/"recovery.json").write_text(json.dumps(result,indent=2)+"\n",encoding="utf8")
    print(json.dumps(result))
    browser.close()
