"""Compare release HTMLs in the same browser with a fixed input and display clock."""
import argparse
import json
import math
from pathlib import Path
from statistics import median

from PIL import Image, ImageChops
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument("html", type=Path)
parser.add_argument("out", type=Path)
parser.add_argument("--compare", type=Path, help="Directory from an earlier run at the same viewport")
args = parser.parse_args()
args.out.mkdir(parents=True, exist_ok=True)

# Use the real display callback, keep each input on the same tick, and count
# actual WebGL submissions. Read the composited image outside the timing window.
instrument = """() => {
  const nativeFrame = window.requestAnimationFrame.bind(window);
  let callbacks = [], frame = 0, uploads = 0, bytes = 0, draws = 0;
  window.requestAnimationFrame = cb => callbacks.push(cb);
  const proto = WebGL2RenderingContext.prototype;
  const sub = proto.bufferSubData;
  proto.bufferSubData = function(target, offset, src, start = 0, length) {
    uploads++;
    bytes += length ? length * src.BYTES_PER_ELEMENT : src.byteLength - start * (src.BYTES_PER_ELEMENT || 1);
    return sub.apply(this, arguments);
  };
  for (const name of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced']) {
    const original = proto[name];
    proto[name] = function() { draws++; return original.apply(this, arguments); };
  }
  window.profileFrames = count => new Promise(resolve => {
    const rows = [];
    function pump() {
      const queue = callbacks;
      callbacks = [];
      uploads = bytes = draws = 0;
      const time = 1000 + (++frame) * (1000 / 60);
      const start = performance.now();
      for (const cb of queue) cb(time);
      rows.push([performance.now() - start, uploads, bytes, draws]);
      if (rows.length < count) nativeFrame(pump);
      else resolve(rows);
    }
    nativeFrame(pump);
  });
}"""

def summarize(rows):
    cpu = sorted(row[0] for row in rows)
    return dict(frames=len(rows), cpuMedianMs=round(median(cpu), 3),
                cpuP95Ms=round(cpu[math.ceil(len(cpu) * .95) - 1], 3),
                bufferUploads=sum(row[1] for row in rows), bufferBytes=sum(row[2] for row in rows),
                drawCalls=sum(row[3] for row in rows))

with sync_playwright() as pw:
    browser = pw.chromium.launch(channel="chromium", args=["--enable-gpu", "--use-angle=d3d11"])
    result = {"browser": browser.version, "viewport": [1280, 800], "scenes": {}}
    for yard in ["quarry", "haul", "dunes"]:
        page = browser.new_page(viewport={"width":1280,"height":800}, device_scale_factor=1)
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
        page.add_init_script("(" + instrument + ")()")
        page.goto(args.html.resolve().as_uri() + "?yard=" + yard)
        page.wait_for_function("!!window.sandLab", polling=20)
        result["gpu"] = page.evaluate("""() => {const gl=document.querySelector('#view').getContext('webgl2');
            const ext=gl.getExtension('WEBGL_debug_renderer_info'); return ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);}""")
        scene = result["scenes"][yard] = {}
        def run(n):
            return page.evaluate("n => profileFrames(n)", n)
        def capture(phase):
            page.screenshot(path=args.out / f"{yard}-{phase}.png",
                            style="body * {visibility:hidden!important} #view {visibility:visible!important}")
            scene[phase]["state"] = page.evaluate("""() => {
                const {frame, pose, base, load, air, truckLoads, truckTravel, truckSuspension,
                       massError, bay, maxLoad, triangles} = sandLab.state();
                return {frame, pose, base, load, air, truckLoads, truckTravel, truckSuspension,
                        massError, bay, maxLoad, triangles};
            }""")
        def action(name):
            page.evaluate("a => document.querySelector('[data-action='+a+']').click()", name)
        run(120)
        scene["rest"] = summarize(run(90))
        capture("rest")
        if yard == "dunes":
            page.keyboard.down("ArrowUp")
            scene["drive"] = summarize(run(225))
            page.keyboard.up("ArrowUp")
            capture("drive")
        else:
            action("dig")
            scene["dig"] = summarize(run(175))
            capture("dig")
            run(160)
            action("lift")
            run(120)
            action("swing")
            run(200)
            action("dump")
            scene["pour"] = summarize(run(55))
            capture("pour")
            scene["settle"] = summarize(run(140))
            capture("settle")
            assert scene["dig"]["state"]["maxLoad"] > 0
            assert (scene["settle"]["state"]["truckLoads"][0] if yard == "haul"
                    else scene["settle"]["state"]["bay"]) > 0
        assert all(phase["state"]["massError"] == 0 for phase in scene.values())
        if yard == "quarry":
            # A settled image must still react to a resize, pointer input and both
            # diagnostic overlays, including while the simulation clock is paused.
            page.evaluate("document.querySelector('#pause').click()")
            run(2)
            page.set_viewport_size({"width":1200, "height":760})
            assert summarize(run(2))["drawCalls"] > 0
            page.mouse.move(630, 330)
            page.mouse.down()
            page.mouse.move(740, 370, steps=4)
            page.mouse.up()
            assert summarize(run(8))["drawCalls"] > 0
            for selector in ["#forces", "#tiles", "#forces", "#tiles"]:
                page.evaluate("s => document.querySelector(s).click()", selector)
                assert summarize(run(1))["drawCalls"] > 0
        assert not errors, errors
        print(yard, {k:{m:v for m,v in row.items() if m!="state"} for k,row in scene.items()}, flush=True)
        page.close()
    browser.close()

if args.compare:
    before = json.loads((args.compare / "frames.json").read_text(encoding="utf-8"))
    images = {}
    for yard, phases in result["scenes"].items():
        for phase, metric in phases.items():
            assert before["scenes"][yard][phase]["state"] == metric["state"], (yard, phase)
            name = f"{yard}-{phase}.png"
            with Image.open(args.compare / name) as a, Image.open(args.out / name) as b:
                diff = ImageChops.difference(a.convert("RGB"), b.convert("RGB"))
                red, green, blue = diff.split()
                histogram = ImageChops.lighter(ImageChops.lighter(red, green), blue).histogram()
                images[name] = {"changedPixels": sum(histogram[1:]),
                                "maxChannelDelta": max(i for i, n in enumerate(histogram) if n)}
    result["imageComparison"] = images
    print("Matched gameplay checkpoints and image differences:", images, flush=True)
    assert all(item["maxChannelDelta"] <= 2 for item in images.values()), images
(args.out / "frames.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
