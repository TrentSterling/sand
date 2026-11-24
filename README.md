# SandLab

Drive a tracked excavator in a small working quarry. Curl the bucket into the bank, lift a load, swing over the concrete bay, and watch where the sand actually lands. Spills stay in the yard. Take the second order to build a stockpile within a marked footprint, then keep the controls in free dig.

**[Play SandLab on GitHub Pages](https://tront.xyz/sand/)** · [Download the standalone HTML](https://github.com/TrentSterling/sand/raw/refs/heads/main/index.html)

![SandLab excavator at the working face of the quarry](evidence/quarry.png)

## In the operator seat

| Control | Action |
| --- | --- |
| **1, 2, 3, 4** or the four on-screen buttons | Dig, lift, swing to the current delivery point, dump. Each button runs the articulated machine through a movement. The soil solver decides how much it picks up and where it lands. |
| **W / S**, **E / D**, **R / F** | Raise / lower boom, extend / draw the stick, curl / tip the bucket. The first joint input switches to manual. |
| **Q / A**, **arrow keys** | Slew the upper house, or drive and steer the tracks. |
| **Double-click terrain** | Position the cutting edge at a reachable point using two-link inverse kinematics. |
| **Drag / scroll or pinch** | Orbit and zoom. The manual panel also has hold controls for touch. |
| **CPU lab** | Pause, single-step, show awake terrain tiles, or replay the same inputs through two CPU schedulers. |
| **Help** | Toggle engine sound, reset the quarry, or save the one-file offline build. |

The first order weighs 0.75 m³ of delivered sand. The second calls for 1.50 m³ inside the stockpile ring. Both count material that actually reaches the destination. Volumes are reported as their loose-sand equivalents so compacting a pile under the tracks cannot change the score.

## What moves the sand

The Rust core owns a 32 × 32 m yard at 125 mm spacing. Columns store integer quantities of sand plus compaction. The cutting edge samples the material it sweeps through. A curl or inward stroke can load the open bucket up to 1.05 m³. A reverse stroke shoves soil aside. Tilt or a quick swing releases parcels into gravity. The same material returns to the terrain on contact. Loose banks slump, and track pressure can lower their surface while preserving mass. This release models dry surface excavation. A column has one surface, so persistent undercuts would need another terrain representation.

The solver advances at 60 fixed steps per second on one CPU thread. Four alternating disjoint-neighbor passes cover both grid axes. A 16 × 16 tile wakes when material changes and stays awake long enough to cover the neighboring pairs. The renderer uploads only the affected position and normal ranges and reuses its shadow map while the machine and ground are still. WebGL2 draws the result. No compute shaders are required.

### Measure a dig

The lab compares the first minute of your recorded tool and drive inputs, a repeatable reference dig, or a quarry-wide avalanche. Both schedulers start from the same initial conditions. The panel reports elapsed simulation time, pair visits, mass balance and whether the final material-state hashes agree. The avalanche keeps much more of the yard active and gives a different performance comparison.

On an Intel Core Ultra 9 285K under Windows, 21 paired repetitions of the 720-tick reference dig gave the following results. Times cover the complete native replay loop. World creation, rendering, and validation are outside the timer. [Native benchmark receipt](evidence/native.json)

| Scheduler | Median per replay | p95 per replay | Neighbor pairs visited |
| --- | ---: | ---: | ---: |
| Active tiles | 0.874 ms | 0.952 ms | 352,384 |
| Full grid | 32.359 ms | 32.678 ms | 23,500,800 |

Both runs ended with material hash `7eab9f1f` and zero mass error. In Chrome at 1440 × 900 on an RTX 5070 Ti, the two delivery jobs measured 16.7 ms median and 16.8 ms p95 between animation frames. The browser's quarry-wide avalanche took 19.9 ms with active tiles and 38.4 ms with a full scan over the complete 360-tick replay. The final material states matched. [Browser playtest and timing receipt](evidence/browser.json)

## The excavator

The machine is an original parametric model. Its house, boom, stick, toothed bucket and track assemblies are grouped around their mechanical pivots. Four telescoping cylinders resolve between attachment points. A pin-jointed four-bar linkage connects the crowd cylinder to the bucket. The same tooth transform drives the excavation solver. Static surfaces are batched by finish and joint. The track shoes are instanced. [Editable machine source](web/machine.js)

The model combines AnyMachine's part-by-part approach with profiled plates, swept hoses and measured proportions from production excavators. Robotlife's earlier img2threejs work informed the fixed-view review. The cutter and pins were authored directly in Three.js. [AnyMachine](https://github.com/apekshik/anymachine) · [img2threejs](https://github.com/img2threejs/img2threejs) · [Excavator dimensional reference](https://www.cat.com/en_GB/products/new/equipment/excavators/medium-excavators/126532.html)

Validation covers 1,485 joint combinations, plus front, rear, top, underside, side and oblique views of the dig, carry and dump poses. Reversing object and triangle order exposed competing decal surfaces. After the fix, at most three pixels changed in any 640 × 640 comparison. [Rig checks](evidence/rig.json) · [Draw-order audit](evidence/surface-audit.json)

## Run and build

Open `index.html` directly in a WebGL2 and WebAssembly browser. The release embeds the simulation, renderer, machine and scenery. It also runs with the network disabled. The Three.js license is included in the HTML.

Rebuild with Rust, Node.js and npm from the repository root.

```sh
rustup target add wasm32-unknown-unknown
npm ci
npm run build
```

Run the native simulation and kinematic checks with the following commands.

```sh
cargo test --locked --release
cargo run --locked --release --bin bench
node tools/verify-machine.mjs
```

For browser verification, install Python Playwright and Chrome. Run `python tools/playtest.py` to complete both jobs, compare the solvers and open the downloaded build with network requests blocked. Run `python -m playwright install chromium` and `python tools/inspect-machine.py` for the orthographic model review.
