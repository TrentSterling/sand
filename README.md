# SandLab

The exit deck stands just above the excavator's tracks. Take a bite out of the bank, pour sand against the concrete lip, and drive up what you built. Park on the deck for a clean exit, or keep the throttle down and take the striped arm with you. Both finishes count.

**[Play Build Your Way Out on GitHub Pages](https://tront.xyz/sand/)** · [Open the quarry orders](https://tront.xyz/sand/?yard=quarry) · [Download the standalone HTML](https://github.com/TrentSterling/sand/raw/refs/heads/main/index.html)

**[Load the trucks](https://tront.xyz/sand/?yard=haul)** · **[Dig in the dune field](https://tront.xyz/sand/?yard=dunes)**

[Watch the driving crest test](https://tront.xyz/sand/review/drive/) · [Compare the original and revised excavator from 15 angles](https://tront.xyz/sand/review/) · [Read the blind reviews and mechanical results](GAUNTLET.md)

![Four game captures showing a bucket placement, the built approach, a test climb and the excavator parked on the exit deck](evidence/escape-approach.webp)

## Build your way out

Tap a spot on the bank to cut there. With sand in the bucket, tap the spot where you want to pour. **Half pour** keeps some sand in the bucket for a second placement. The two gauges show how much sand is supporting each approach at the lip. If you stall, back up and look for the orange cross where the low track needs help.

Hold **Drive to exit** to line up with the deck, or steer the tracks yourself. Your browser remembers the fewest scoops you escaped with. A faster run breaks a tie.

## Truck dispatch and dune field

Load **Cherry Picker**, a red long-nose highway tipper, with 0.85 m³. Its bed catches sand where it lands. Watch the pile grow and the suspension settle. When the truck has its order, its light turns green and it rolls out with the load. **Mule Six**, the teal six-wheel quarry dumper, takes 1.25 m³. A wide swing can spill a perfectly good scoop onto the ground. Cones, oil drums and a loose tyre can be knocked around by the excavator and the departing trucks. Turn sound on in Help to hear the send-off.

The **Dune field** is a free-dig yard with 2,062 m³ of movable sand. Open the CPU lab there and run **Dune field stress test** to trigger 15 landslides over 900 simulation ticks. On the development PC the shipped WASM took a median **92.87 ms** per complete replay with active tiles and **102.94 ms** scanning the full grid, over seven paired repetitions in Node. Both produced the same terrain and conserved every unit of sand. [Reproduce the measurements](tools/stress-dunes.mjs) · [Timing receipt](evidence/dune-stress.json)

![The red road tipper, teal quarry dumper, broken exit gate and sand-heavy dune field captured in the game](evidence/yard-shift.webp)

The standalone Chromium playtest filled the tippers in two and three scoops respectively. While digging in the dunes at 1280 × 800, the browser recorded 16.7 ms median and 16.8 ms p95 between animation frames across 240 frames. [Browser playtest receipt](evidence/yard-browser.json)

## In the operator seat

| Control | Action |
| --- | --- |
| **1, 2, 3** in the escape job | Scoop at the bank or place at the left or right track approach. Tap the ground for a custom cut or pour. |
| **1, 2, 3, 4** in quarry orders and truck dispatch | Dig, lift, swing to the delivery point, dump. The soil solver decides how much the bucket picks up and where it lands. |
| **W / S**, **E / D**, **R / F** | Raise / lower boom, extend / draw the stick, curl / tip the bucket. The first joint input switches to manual. |
| **Q / A**, **arrow keys** | Slew the upper house, or drive and steer the tracks. |
| **Double-click terrain in manual** | Position the cutting edge at a reachable point using two-link inverse kinematics. |
| **Cut view** | Look across the pin axes and drag the teeth through the bank with a mouse or finger. Hold R or F to adjust the bucket pitch while dragging. The cursor changes colour when the teeth fall short. |
| **Drag / scroll or pinch** | Orbit and zoom. Open Manual to see the bound key on each hold button or to operate the machine by touch. |
| **CPU lab** | Pause, single-step, show track forces and centre of mass, show awake terrain tiles, or replay the same inputs through two CPU schedulers. |
| **Help** | Toggle engine sound, reset the quarry, or save the one-file offline build. |

Open **Help → Quarry orders** for the original yard. The first order weighs 0.75 m³ of delivered sand. The second calls for 1.50 m³ inside the stockpile ring, then unlocks free dig. Both count material that reaches the destination. Volumes are reported as loose-sand equivalents so compacting a pile under the tracks cannot change the score.

## Driving the crawler

If the machine gets wedged, open **Jobs / Help → Recover excavator**. It returns the excavator to the starting pad with its bucket load, delivered sand, excavated terrain and current job intact. The truck-loading yard has an open apron where the quarry orders use a concrete weigh bay.

Raise the boom with **W**, drive up the bank with **↑**, release to brake, then slew with **Q**. The 20.4 t carrier carries its velocity into the stop. The house, counterweight, boom, stick, bucket and payload determine how the two tracks share its weight. A heaped bucket adds 880 kg at the attachment. The raised arm can rock the chassis, and pressing the bucket into hard ground can lift weight off the tracks.

Each track drives and brakes independently. Loaded shoes compress loose sand and can push material sideways into ruts. The CPU integrates the chassis at 120 Hz and the soil at 60 Hz. The machine uses a rigid undercarriage, a prescribed hydraulic linkage and a dry granular heightfield. The masses, drive characteristics and soil coefficients are game calibrations. [Physics source](web/crawler.js) · [Crest films and six matched views](https://tront.xyz/sand/review/drive/) · [Drive test measurements](evidence/drive.json)

### Haul truck suspension

Each truck carries six wheel masses on springs and dampers. At 240 Hz the CPU samples the live sand under each tyre, transfers load through the rear tandem and integrates chassis heave, pitch and roll. The position of sand in the bed affects which springs compress. The bed, cab, axle beams, dampers and wheel collision shapes follow the simulated pose. The dispatch driver brakes for an occupied lane and continues when it clears. In **CPU lab**, the truck springs row shows left and right compression in millimetres for each axle. [Watch a loaded departure](evidence/loaded-suspension.webp) · [Suspension source](src/suspension.rs)

The handling is tuned for two fictional trucks on straight dispatch routes. CrumpleCar informed the loaded-tyre contact and bump-stop design, Dunes informed the per-wheel terrain sampling and rebound, and Jet Game informed the hub-to-shock visual linkage. A two-tonne off-centre load in the test rig lowered Cherry Picker's bed centre by 62 mm and Mule Six's by 60 mm. The collision checks drive the crawler into the side, cab and tail, reverse clear and block a departing truck until the lane opens. [Truck contact measurements](evidence/truck-contact.json)

## What moves the sand

The Rust core owns a 32 × 32 m yard at 125 mm spacing. Columns store integer quantities of dry sand plus compaction. A curl or inward stroke loads the bucket to a heaped capacity of 0.55 m³. Once full, the blade moves soil sideways across both cheeks. The bucket retains its load through steady transport. Tipping or accelerating it can release material. A parcel's mass, velocity and impact location drive the visible discharge and the resulting deposit. A darker cut face shows where the teeth removed the original bank. Each column has one surface, so a persistent overhang would need a different representation.

The solver advances at 60 fixed steps per second on one CPU thread. Four alternating disjoint-neighbor passes cover both grid axes. A 16 × 16 tile wakes when material changes and stays awake long enough to cover the neighboring pairs. Sand transfers and track pressure update the compacted surface height for each affected column. The renderer keeps the grid coordinates on the GPU and uploads changed heights, normals and packing in tile order. Once the quarry settles, the browser keeps the last image on screen while input and physics continue to run.

### Measure a dig

On the 225-frame dune drive at 1280 × 800, version 0.6.1 reduced WebGL buffer traffic from 226 MB to 107 MB and buffer uploads from 77,140 to 17,727. Both versions used the same mesh, shadows, resolution and input sequence. The comparison also covers quarry cuts, airborne sand, truck loading, and waking a parked view. [Frame measurements](evidence/frame-profile.json)

The CPU solver now spends 256 KiB per world caching compacted surface heights. In seven WebAssembly runs of the 900-tick dune stress test, the active-tile median fell from 101.1 ms to 87.8 ms. Both releases visited 23,656,496 pairs, conserved all the sand, and ended with the same material hash.

The lab compares the first minute of your recorded tool and drive inputs, a repeatable reference dig, or a quarry-wide avalanche. Both schedulers start from the same initial conditions. The panel reports elapsed simulation time, pair visits, mass balance and whether the final material-state hashes agree. The avalanche keeps much more of the yard active and gives a different performance comparison.

The original native benchmark on an Intel Core Ultra 9 285K under Windows used 21 paired repetitions of the 720-tick reference dig. Times cover the complete replay loop. World creation, rendering, and validation are outside the timer. [Native benchmark receipt](evidence/native.json)

| Scheduler | Median per replay | p95 per replay | Neighbor pairs visited |
| --- | ---: | ---: | ---: |
| Active tiles | 0.742 ms | 0.762 ms | 217,088 |
| Full grid | 32.473 ms | 33.727 ms | 23,500,800 |

Both runs ended with material hash `92c38cf6` and zero mass error. In Chrome at 1440 × 900 on an RTX 5070 Ti, the playtest measured 16.7 ms median and 16.8 ms p95 between animation frames. The browser's quarry-wide avalanche took 20.3 ms with active tiles and 37.8 ms with a full scan over the complete 360-tick replay. The final material states matched. [Browser playtest and timing receipt](evidence/browser.json)

## The excavator

The machine is an original parametric model. Its house, boom, stick, toothed bucket and track assemblies are grouped around their mechanical pivots. Four telescoping cylinders resolve between attachment points. A pin-jointed four-bar linkage connects the crowd cylinder to the bucket. The same tooth transform drives the excavation solver. Static surfaces are batched by finish and joint. The track shoes are instanced. [Editable machine source](web/machine.js)

The boom and dipper are extruded steel profiles. The bucket shell, side plates, tooth faces, fork and cylinder eyes have editable cross-sections and local pin coordinates. The authoring inputs are hand-set Three.js geometry and dimensions. AnyMachine informed the part decomposition. The img2threejs workflow informed the fixed-view visual checks. Production machines provided proportion and working-motion references. The exact linkage dimensions and cylinder stops are original to this game. [AnyMachine](https://github.com/apekshik/anymachine) · [img2threejs](https://github.com/img2threejs/img2threejs) · [Caterpillar digging and trenching reference](https://www.cat.com/en_US/articles/for-owners/tips-for-digging-and-trenching-with-your-excavator.html)

Validation covers 1,485 forward poses, 2,288 reachable tooth targets through the game's actual IK, 80 constrained target cases, 2,048 stroke intervals per actuator joint, and 21 isolated model renders. The driving gauntlet separately exercises free fall, braking, a ledge drop, bank traversal, cross-slope load transfer, bucket jacking and a parked crest reversal. [Rig checks](evidence/rig.json) · [IK checks](evidence/controls.json) · [Draw-order audit](evidence/surface-audit.json)

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
node tools/verify-controls.mjs
node tools/verify-drive.mjs
node tools/verify-truck-contact.mjs
node tools/stress-dunes.mjs
```

For browser verification, install Python Playwright and its Chromium browser. Run `python tools/escape-playtest.py` for a mouse and keyboard escape, a metered two-spot pour, a retry and a saved best. Add `--touch` to drive using a phone-sized touch viewport. Run `node tools/gauntlet-build.mjs candidate` followed by `python tools/escape-gauntlet.py` for the matched zero-, one-, two- and four-load approaches. [Drive comparison](evidence/escape.json)

Run `python tools/playtest.py --channel chromium` to complete both quarry orders, compare the solvers and open the downloaded build with network requests blocked. Run `python tools/drive-playtest.py` with Chrome for the keyboard crest test. Run `python tools/inspect-machine.py` for the orthographic model review.

Run `python tools/escape-playtest.py --drive-through` to hold the throttle through the gate and check the win on the far side. Run `python tools/yard-playtest.py` to load and dispatch both trucks with the on-screen controls, dig in the dunes, measure 240 frames and check the stress replay. Both scripts accept `--browser firefox` and `--url` for testing the published game.

Run `python tools/haul-recovery.py` to drive into a parked truck with a loaded bucket, recover the excavator and finish that delivery.

To compare two builds, save the previous standalone HTML and run the following commands with Python Playwright, Chromium and Pillow installed. Each run records browser main-thread callback time, WebGL buffer traffic, gameplay checkpoints and ten screenshots.

```sh
python tools/frame-profile.py previous.html .work/frames-before
python tools/frame-profile.py index.html .work/frames-after --compare .work/frames-before
```
