"""Drive identical approaches with different amounts of player-placed sand."""
import argparse
import base64
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--capture", type=Path, default=ROOT / ".work/gauntlet/private/candidate/capture.html")
parser.add_argument("--out", type=Path, default=ROOT / ".work/escape-comparison")
args = parser.parse_args()
args.out.mkdir(parents=True, exist_ok=True)

views = {
    "cut": {"eye": [0, 7, -10], "look": [3, 2.0, -1.4], "width": 13},
    "tracks": {"eye": [9, 5, 8], "look": [4, 1.65, 0], "width": 11},
    "lip": {"eye": [2, 2.5, 8], "look": [4.5, .7, 0], "width": 7},
    "exit": {"eye": [15, 7, -10], "look": [7, 2, 0], "width": 15},
}

def picture(page, name):
    pixels = page.evaluate("lens => gauntlet.photograph(lens)", views[name])
    (args.out / (name + ".png")).write_bytes(base64.b64decode(pixels))

with sync_playwright() as pw:
    browser = pw.chromium.launch(channel="chromium", args=["--enable-gpu", "--use-angle=d3d11"])
    cases = []
    for count in (0, 1, 2, 4):
        page = browser.new_page(viewport={"width": 1000, "height": 650})
        page.goto(args.capture.resolve().as_uri())
        page.wait_for_function("window.gauntlet")
        page.evaluate("gauntlet.advance(18)")
        for i in range(count):
            for key in ("Digit1", "Digit3" if i % 2 else "Digit2"):
                page.evaluate("""key => {
                    gauntlet.key(key,true);
                    gauntlet.key(key,false);
                    let ticks=0;
                    while(sandLab.state().action && ticks<1200){gauntlet.advance(8);ticks+=8;}
                    if(sandLab.state().action) throw Error('Assisted movement timed out.');
                    gauntlet.advance(36);
                }""", key)
            if count == 2 and i == 0:
                picture(page, "cut")
        if count == 2:
            picture(page, "lip")
        page.evaluate("gauntlet.key('ArrowUp',true)")
        for tick in range(130):
            page.evaluate("gauntlet.advance(15)")
            if count == 2 and tick == 12:
                picture(page, "tracks")
            if page.evaluate("sandLab.state().done"):
                break
        page.evaluate("gauntlet.key('ArrowUp',false); gauntlet.advance(90)")
        state = page.evaluate("sandLab.state()")
        assert state["done"] == (count >= 2) and state["massError"] == 0, (count, state)
        if count == 2:
            picture(page, "exit")
        cases.append(dict(scoops=count, escaped=state["done"], stoppedX=round(state["base"]["x"], 3),
                          massError=state["massError"]))
        page.close()
    browser.close()
    result = json.dumps(cases, indent=2)
    (args.out / "comparison.json").write_text(result + "\n", encoding="utf-8")
    print(result)
