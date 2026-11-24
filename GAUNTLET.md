# Excavator review

The first model passed its pin-closure test while the bucket faced the wrong way for a backhoe. Its crowd cylinder also passed through two dead centres. The first clue in play was a bucket apparently carrying a full load while its arm was buried in the bank. This review follows the visible tooth, load and deposit through a whole operating cycle.

**[Watch the synchronized comparison and inspect all 25 matched views](https://tront.xyz/sand/review/)** · [Play the revised machine](https://tront.xyz/sand/)

## Driving on the stockpile

The 0.2 chassis advanced a fixed distance per input tick and fitted its pose to the terrain. On a sharp crest, an unsupported end could hang there for as long as the operator held the brake. For the 0.3 comparison both machines approach the same bank with a raised empty boom, brake at x = 5.18 m, swing the house, descend, reverse and stop back at x = 5.65 m. The two films keep their original rates. The gallery's brake button aligns the moment each machine releases its drive input. [Watch both drives and inspect six paired views](https://tront.xyz/sand/review/drive/)

| Anonymous review | Judgment before identities were revealed |
| --- | --- |
| First physics pass | The reviewer chose 0.2, 7/10, over the first dynamic chassis, 2/10. The prototype went nose-over after the raised-arm crest maneuver. |
| Second pass | The reviewer preferred the dynamic chassis, 6.5/10 versus 4/10, and held both. The new machine parked convincingly. Its descent looked abrupt and the uphill reverse was easy to miss. |
| Released pass | A fresh reviewer chose B, the dynamic chassis, for public prototype release and held A, the 0.2 chassis. They saw the uphill attitude persist through the slew from both sides. At 15.2 to 16.1 seconds the crest still reads as a hard fulcrum with too little visible yielding. |

Each judgment was based on anonymous footage and multiple angles. The final pass adds granular rolling resistance at the loaded shoes, speed-dependent damping of track rocking, visible pressure-packed soil and near-field tread shading. The final films show the full return to a common marker. [Driving footage](https://tront.xyz/sand/review/drive/) · [Contact view](review/drive/contact.webp)

The release machine brakes from 1.52 m/s in 0.42 m on flat bedrock. On the fixed crest maneuver its maximum longitudinal travel from the brake point through the slew was 0.14 m. With the loaded arm extended downhill on a 10.2° tilt table, the two tracks carried about 187 and 13 kN. The separate ledge test loses support and drops to the lower level. The free-fall test records zero drive force and zero horizontal travel. These are game measurements. The geometry and masses target a 20-tonne class machine, and the joint motion remains prescribed. [Drive receipt](evidence/drive.json) · [Volvo EC220 product guide](https://www.volvoce.com/-/media/aprimo/pdf/crawler-excavators/ec220/product-guide-ec220-d5-t3-en-30-20064400-d.pdf) · [Sequential impulses, Erin Catto](https://box2d.org/files/ErinCatto_SequentialImpulses_GDC2006.pdf)

To reproduce the driving comparison, set `SAND_GAUNTLET_DIR` to a fresh private work directory. Build the game, run `node tools/gauntlet-build.mjs baseline f6a7c1a`, then `node tools/gauntlet-build.mjs candidate` and `python tools/drive-capture.py`. The script writes anonymous copies under `drive-blind/` and the label key under `private/`. Run `node tools/verify-drive.mjs` for the deterministic measurements and `python tools/drive-playtest.py` for physical-key input on the shipped page.

## Arm and excavation blind results (0.2)

Two independent AI reviewers each received two anonymous sets of game captures. Each committed to a winner, scores and a ship-or-hold judgment before the build identities were revealed. Neither had source code, prior reviews or performance figures. These are two individual judgments about the footage.

| Round | First build | Revision in that round | Verdict |
| --- | --- | --- | --- |
| 1 | A, 4.4/10 | B, 5.6/10 | Hold both. B's inward teeth and readable linkage won. Its falling sand looked so faint that the heaps seemed to grow by themselves. |
| 2 | B, 6.0/10 | A, 7.0/10 | Ship A as a public prototype. Hold B. The reviewer could follow the teeth through the cut and see grains arrive and accumulate in the bay. |

Each reviewer rated the original independently. The second-round starting camera is wider in both builds. Compare scores within a row.

| Round two, visible evidence | First build | Released revision |
| --- | ---: | ---: |
| Bucket and hydraulics | 5 | 8 |
| Track support | 6 | 7 |
| Reading the excavation | 6.5 | 6 |
| Reading the retained load | 7.5 | 7 |
| Release and landing | 4.5 | 7 |
| Camera | 6.5 | 7 |

**What the first build still did better.** Both reviewers could see a larger hollow in the original bank and a more obvious payload during the swing. In the revision, the teeth visibly enter and roll inward around 2.90 to 4.40 seconds. The resulting bite is small. The second reviewer wanted more draw and daylight between the loaded bucket and the crest. They also saw a sideways leading spray and low contrast at the start of the dump. In the original movie, the falling stream becomes tall smooth pillars at 13.00 to 13.10 seconds and a single cone at 13.15. [Round-one original movie](evidence/gauntlet/original.mp4) · [Round-one revised movie](evidence/gauntlet/first-revision.mp4) · [Final matched movie](review/cycle.mp4)

## What actually changed

| Reproduction | Failing case | Released revision |
| --- | --- | --- |
| Roll the crowd cylinder through its full stroke | Cylinder travel reversed twice near curl angles of −0.084 and +2.070 rad. The original closure test passed. | The teeth rake inward. Extension increases continuously at 0.250 to 0.484 m per radian across 2,048 stroke intervals. |
| Fold and slew the tool toward the right crawler | After correcting the bucket direction, the exposed joint range admitted a tooth inside the track. | A signed clearance check guards the bucket, carriers and slew base. The regression pose has 0.379 m penetration at 45° slew and 0.130 m separation when centered. A held boom command stopped just outside contact for 20 more ticks, then withdrew by 0.338 m. [Browser stop check](evidence/carrier-stop.json) |
| Aim the cutting edge | The game clamped joint angles after solving. The old solver missed a request for 2.10 m reach, 0.05 m height and −0.60 rad pitch by 1.42 m. | Reachable targets use a two-link solve with the actual tooth offset. Targets beyond a stop project to the nearest attainable point at the chosen feasible pitch. A side-on cursor shows the residual while dragging. |
| Fill and lift the scoop | A 1.05 m³ game capacity and a rigid faceted load made the carry look disconnected from its bucket. | The inner mesh measures 0.440 m³ struck. The heaped surface and simulation agree at 0.550 m³. At half load, the visible centre shifts 87 mm between tipped and curled poses. A loaded assisted cut breaks out of the bank. |
| Drag an already full bucket through the same bank | Peak rise in one cell was 1,552 mm. Peak height difference to a neighbour reached 1,326 mm over a 125 mm span. | Peak rise is 148 mm. The worst adjacent difference is 156 mm during the stroke and 92 mm after settling. The cut moved 0.356 m³ and conserved mass. |
| Drop one 2,800-unit parcel | One cell took the whole impact, creating a 2.80 m spike. | The parcel settles across 29 cells with a 263 mm crest and 81 mm maximum axial step. Partial loads can collect against a wall without teleporting to the other side. |
| Drive both tracks onto a bank | Four terrain samples let the centre of a crawler bury itself in a crest. | Eighteen samples fit a support plane to both shoe runs. Loose sand allows up to 65 mm of seating. Only soil near the shoe plane receives compaction. |

The geometry is authored directly in Three.js. The boom, fork, stick, bucket shell, hangers and teeth have separate profiles or cross-sections. Four telescoping actuators connect pin pairs, and two links close the bucket's four-bar. This is an original machine with dimensioned joints. The mechanical checks cover geometric plausibility. Hydraulic pressure, breakout force, track forces and balance against a suspended load still need a dynamics model. [Machine source](web/machine.js) · [Rig receipt](evidence/rig.json)

## How to inspect the evidence

- **Look along the pins.** Views 04, 06 and 08 show tooth direction, retained volume and the cylinder eyes. Across 1,485 forward poses the largest gap between the reference point and the modeled cutting face is below 0.000001 m. Seven specified pairs of steel parts retain at least 4 mm clearance in their sampled sweeps. [Cab side](https://tront.xyz/sand/review/#04) · [Load close-up](https://tront.xyz/sand/review/#06) · [Hydraulics](https://tront.xyz/sand/review/#08)
- **Watch the contact move.** T02 through T05 show approach, inward draw and breakout. Views 13 and 15 show the two sides on the bank. A rigid crawler can bridge an uneven surface. The terrain-support checks cover a plane, crest and one-sided step. [Working bank](https://tront.xyz/sand/review/#T03) · [Opposite crawler](https://tront.xyz/sand/review/#15) · [0.2 IK and support receipt](https://github.com/TrentSterling/sand/blob/f6a7c1a/evidence/controls.json)
- **Follow the main discharge.** The close-up shows onset, and the wide angle shows the landing. A few grains can arrive during swing braking. The published impact plate requires at least another 0.025 m³ to hit the bay after the opening close-up, with material still airborne. [Lip close-up](https://tront.xyz/sand/review/#11) · [Impact](https://tront.xyz/sand/review/#14)
- **Drive it yourself.** Cut view accepts a mouse or touch drag in the vertical working plane. Automated runs also completed the two orders in two and three cycles, then repeated both in the downloaded build with HTTP requests blocked. [Play](https://tront.xyz/sand/) · [Browser receipt](evidence/browser.json)

The blind sets contained 13 working views, 10 cycle stills and a 14.4-second movie for each build. The public gallery adds two diagnostic angles and uses the stricter impact trigger. The movies in round two and the gallery have identical game inputs, timing and camera. Dig begins at tick 0, lift at 360, swing at 435 and dump at 708. Both machines wait for the scheduled lift even if they finish digging early. The main game lets the operator choose the timing.

The review harness loads each revision's game and WASM into a private build. It controls the simulation clock and capture camera, and dispatches the game's real inputs. Isolated front and underside views hide scenery for mechanical inspection. The gallery images are 1600 × 960 WebP exports of the original PNGs. The native 20 fps movies capture every third 60 Hz simulation step. [Capture metadata and build hashes](review/captures.json) · [Draw-order stress test](evidence/surface-audit.json)

## Repeat the gauntlet

Install the game's build dependencies, Python Playwright, Pillow, Chrome and FFmpeg. From the repository root, use the following sequence. The private assignment and poses live under `.work/gauntlet/private/`. Give the reviewer only `.work/gauntlet/blind/` and record the verdict before opening the key. Set `SAND_GAUNTLET_DIR` to a fresh directory for each independent round.

```sh
npm run build
cargo test --locked --release -- --nocapture
node tools/verify-machine.mjs
node tools/verify-controls.mjs
node tools/gauntlet-build.mjs baseline 677fca8
python tools/pose-gauntlet.py baseline
node tools/gauntlet-build.mjs candidate
python tools/pose-gauntlet.py candidate
python tools/pose-gauntlet.py contact
python tools/pose-gauntlet.py plates
python tools/pose-gauntlet.py gallery
python tools/check-gallery.py
python tools/playtest.py
```
