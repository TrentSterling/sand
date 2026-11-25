"""Play the truck contracts and dune stress level through the shipped controls."""

import argparse
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
cli = argparse.ArgumentParser()
cli.add_argument("--url", default=(ROOT / "index.html").as_uri())
cli.add_argument("--out", type=Path, default=ROOT / ".work/yard-play")
cli.add_argument("--browser", choices=["chromium", "firefox"], default="chromium")
args = cli.parse_args()
args.out.mkdir(parents=True, exist_ok=True)

with sync_playwright() as pw:
    if args.browser == "firefox":
        browser = pw.firefox.launch(firefox_user_prefs={"webgl.force-enabled": True})
    else:
        browser = pw.chromium.launch(channel="chromium", args=["--enable-gpu", "--use-angle=d3d11"])
    page = browser.new_page(viewport={"width": 1280, "height": 800})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    if args.url.startswith("file:"):
        page.route("http**/*", lambda route: route.abort())
    page.goto(args.url)
    page.wait_for_function("window.sandLab?.state().frame > 12")

    def press(selector):
        page.locator(selector).click()

    def state():
        return page.evaluate("sandLab.state()")

    def action(name):
        press(f'[data-action="{name}"]')
        page.wait_for_function("name => sandLab.state().action === name", arg=name)
        page.wait_for_function("sandLab.state().action === ''", timeout=45000)

    press("#helpToggle")
    press("#truckJob")
    assert state()["yard"] == "haul" and state()["truckLoads"] == [0, 0]
    page.screenshot(path=args.out / "dispatch.png")
    cycles = []
    for truck, required_units in enumerate([54400, 80000]):
        for cycle in range(1, 7):
            for movement in ("dig", "lift", "swing", "dump"):
                action(movement)
            page.wait_for_function("!sandLab.state().air")
            page.wait_for_function("f => sandLab.state().frame >= f", arg=state()["frame"] + 18)
            status = state()
            assert status["massError"] == 0
            print("truck", truck, "cycle", cycle, "loads", status["truckLoads"], flush=True)
            if status["done"]:
                break
        assert status["done"] and status["truckLoads"][truck] >= required_units, status
        cycles.append(cycle)
        page.wait_for_function("i => Math.abs(sandLab.state().truckTravel[i]) > 1.2", arg=truck)
        if truck == 0:
            page.screenshot(path=args.out / "loaded.png")
            press("#nextJob")
            assert state()["job"] == 1 and not state()["done"]

    final_loads = state()["truckLoads"]
    press("#labToggle")
    press("#bench")
    page.wait_for_function("sandLab.lastBenchmark !== null", timeout=60000)
    replay = page.evaluate("sandLab.lastBenchmark")
    assert replay["match"] and replay["massError"] == 0 and replay["liveMatch"] is not False, replay

    press("#labToggle")
    press("#nextJob")
    status = state()
    assert status["yard"] == "dunes" and status["initialM3"] > 2000, status
    page.screenshot(path=args.out / "dunes.png")
    page.evaluate("""() => {
        window.duneFrames = [];
        let last = 0;
        function track(time) {
            if (last) duneFrames.push(time - last);
            last = time;
            if (duneFrames.length < 240) requestAnimationFrame(track);
        }
        requestAnimationFrame(track);
    }""")
    action("dig")
    page.wait_for_function("duneFrames.length >= 240")
    frames = page.evaluate("duneFrames.slice().sort((a, b) => a - b)")
    assert state()["maxLoad"] > 1000 and state()["massError"] == 0
    press("#labToggle")
    assert page.locator("#scenario").input_value() == "dunes"
    press("#bench")
    page.wait_for_function("sandLab.lastBenchmark?.source === 'Dune field stress test'", timeout=60000)
    stress = page.evaluate("sandLab.lastBenchmark")
    assert stress["ticks"] == 900 and stress["match"] and stress["massError"] == 0
    assert not errors, errors

    receipt = {
        "browser": args.browser,
        "version": browser.version,
        "url": args.url,
        "truckCycles": cycles,
        "deliveredM3": [v / 64000 for v in final_loads],
        "truckReplay": replay,
        "duneStress": stress,
        "frames": len(frames),
        "medianFrameMs": frames[119],
        "p95FrameMs": frames[227],
    }
    (args.out / "yard.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf8")
    print(json.dumps(receipt))
    browser.close()
