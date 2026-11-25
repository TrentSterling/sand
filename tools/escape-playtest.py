"""Play the escape job through the shipped mouse, touch and keyboard controls."""

import argparse
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
cli = argparse.ArgumentParser()
cli.add_argument("--url", default=(ROOT / "index.html").as_uri())
cli.add_argument("--browser", choices=["chromium", "firefox", "chrome"], default="chromium")
cli.add_argument("--out", type=Path, default=ROOT / ".work/escape-play")
cli.add_argument("--touch", action="store_true")
cli.add_argument("--drive-through", action="store_true", help="Hold manual travel through the exit arm")
args = cli.parse_args()
if args.touch and args.browser == "firefox":
    cli.error("The sustained touch-input test requires Chromium.")
args.out.mkdir(parents=True, exist_ok=True)

with sync_playwright() as pw:
    if args.browser == "firefox":
        browser = pw.firefox.launch(firefox_user_prefs={"webgl.force-enabled": True, "webgl.disabled": False})
    else:
        browser = pw.chromium.launch(channel=args.browser, args=["--enable-gpu", "--use-angle=d3d11"])
    size = {"width": 393, "height": 852} if args.touch else {"width": 1280, "height": 800}
    page = browser.new_page(viewport=size, has_touch=args.touch, device_scale_factor=1)
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    if args.url.startswith("file:"):
        page.route("http**/*", lambda route: route.abort())
    page.goto(args.url)
    page.wait_for_function('window.sandLab?.state().yard==="escape" && sandLab.state().frame>15')

    def state():
        return page.evaluate("sandLab.state()")

    def press(selector):
        button = page.locator(selector)
        if args.touch:
            button.tap()
        else:
            button.click()

    def advance(ticks):
        page.wait_for_function("f=>sandLab.state().frame>=f", arg=state()["frame"] + ticks, timeout=45000)

    def finish_action():
        page.wait_for_function('sandLab.state().action!==""')
        page.wait_for_function('sandLab.state().action===""', timeout=48000)

    def readings():
        return [int(page.locator("#" + side).inner_text().split()[0]) for side in ("leftSand", "rightSand")]

    def drive_until(wait):
        button = page.locator('#rampPanel [data-hold="driveForward"]')
        box = button.bounding_box()
        x = box["x"] + box["width"] / 2
        y = box["y"] + box["height"] / 2
        if args.touch:
            session = page.context.new_cdp_session(page)
            session.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
            try:
                wait()
            finally:
                session.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
                session.detach()
        else:
            page.mouse.move(x, y)
            page.mouse.down()
            try:
                wait()
            finally:
                page.mouse.up()

    clean = readings()
    page.screenshot(path=args.out / "opening.png")
    drive_until(lambda: advance(350))
    failed = state()
    assert not failed["done"] and 2.5 < failed["base"]["x"] < 4.2 and failed["scoops"] == 0, failed
    assert failed["stallSide"] and "cross" in page.locator("#missionBrief").inner_text()
    page.screenshot(path=args.out / "stall.png")
    press("#helpToggle")
    press("#reset")
    press("#helpToggle")
    advance(18)

    # The desktop picks are on the bank face and at the foot of the left track.
    if args.touch or args.drive_through:
        press("#borrow")
    else:
        page.mouse.click(595, 261)
    finish_action()
    load = state()["load"]
    assert load > 8000, load
    if args.touch or args.drive_through:
        press("#placeLeft")
    else:
        page.mouse.click(717, 425)
    finish_action()
    advance(48)
    left = readings()
    assert left[0] > clean[0] + 10, (clean, left)
    if args.touch:
        press("#borrow")
    else:
        page.keyboard.press("1")
    finish_action()
    press("#placeRight")
    finish_action()
    advance(48)
    both = readings()
    assert both[1] > clean[1] + 10, (clean, both)
    if args.drive_through:
        # Build up both lanes again before testing the gate at speed.
        for placement in ("#placeLeft", "#placeRight"):
            press("#borrow")
            finish_action()
            press(placement)
            finish_action()
            advance(48)
        both = readings()
    expected_scoops = 4 if args.drive_through else 2
    page.screenshot(path=args.out / "built.png")
    if args.drive_through:
        # Approach straight up the player-built ramp. Take over before the parking zone.
        try:
            drive_until(lambda: page.wait_for_function("sandLab.state().base.x >= 6.7", timeout=42000))
            press("#manual")
            page.keyboard.down("ArrowUp")
            page.wait_for_function("sandLab.state().done && sandLab.state().base.x > 16.2", timeout=42000)
            assert state()["gateBroken"] and state()["propHits"] > 0
            assert not state()["stallSide"] and "made it out" in page.locator("#goal").inner_text()
        except Exception:
            page.screenshot(path=args.out / "drive-through-failure.png")
            print(state(), flush=True)
            raise
        finally:
            page.keyboard.up("ArrowUp")
    else:
        drive_until(lambda: page.wait_for_function("sandLab.state().done", timeout=42000))
    end = state()
    assert end["scoops"] == expected_scoops and end["massError"] == 0, end
    assert (abs(end["chassis"]["speed"]) > .1) == args.drive_through, end
    advance(85)
    page.screenshot(path=args.out / "escaped.png")

    replay = None
    if not args.touch:
        press("#labToggle")
        press("#bench")
        page.wait_for_function("sandLab.lastBenchmark!==null", timeout=45000)
        replay = page.evaluate("sandLab.lastBenchmark")
        assert replay["match"] and replay["liveMatch"] and replay["massError"] == 0, replay
        press("#labToggle")

    press("#retry")
    assert not state()["done"] and state()["scoops"] == 0
    assert f"{expected_scoops} scoop" in page.locator("#finishResult").inner_text()
    press("#borrow")
    finish_action()
    advance(18)
    starting_load = state()["load"]
    press("#split")
    press("#placeLeft")
    finish_action()
    advance(18)
    remaining = state()["load"]
    assert starting_load * .25 < remaining < starting_load * .7, (starting_load, remaining)
    press("#placeRight")
    finish_action()
    advance(40)
    split_lanes = readings()
    assert state()["load"] < 180 and state()["scoops"] == 1 and state()["massError"] == 0
    assert all(height > initial + 4 for height, initial in zip(split_lanes, clean)), split_lanes

    page.reload()
    page.wait_for_function("window.sandLab?.state().frame>10")
    assert f"{expected_scoops} scoop" in page.locator("#finishResult").inner_text()
    press("#helpToggle")
    press("#switchYard")
    assert state()["job"] == 0 and state()["yard"] == "quarry"
    assert not errors, errors
    receipt = {
        "url": args.url, "browser": args.browser, "version": browser.version, "touch": args.touch,
        "droveThrough":args.drive_through,"gateBroken":end["gateBroken"],"propHits":end["propHits"],
        "firstLoadM3": load / 64000, "bareStopX": failed["base"]["x"],
        "lipHeightCm": {"initial": clean, "leftOnly": left, "both": both},
        "finishSeconds": end["finishTime"], "scoops": end["scoops"],
        "parked": end["base"], "speed": end["chassis"]["speed"], "massError": end["massError"],
        "splitLoad": {"startingM3": starting_load / 64000, "retainedM3": remaining / 64000, "heightsCm": split_lanes},
        "retryAndPersonalBest": True, "quarryOrdersAccessible": True, "replay": replay,
    }
    (args.out / "escape.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf8")
    print(json.dumps(receipt))
    browser.close()
