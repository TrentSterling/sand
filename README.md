# SandLab

A browser excavation sandbox from Tront Graphics Lab. Put a tracked excavator in a small quarry and make every bucketful count. Take a bite out of a bank, swing over a retaining wall, and tip the bucket. The cut should still be there when you swing back. So should the sand you spilled on the way.

**Design stage.** This page is the project brief. The first playable build is still ahead.

[Project page on GitHub Pages](https://tront.xyz/sand/) · [Source on GitHub](https://github.com/TrentSterling/sand)

## The first dig

One excavator, a bank of dry sand, and a concrete bay to fill. The boom, stick, and bucket each have their own pivot and travel limits. Curling the bucket should trap a load. Lifting it with the mouth pointed down should leave most of that load at your feet. The same controls should let you skim a shallow cut or take a deep bite.

The first milestone is a repeatable scoop, carry, and dump. After the pile settles, account for the sand still in the bank, in the bucket, in flight, on the ground, and beyond the quarry boundary. Track mass separately from volume so compacting a pile can change its height while preserving its mass.

## Inside the lab

Replay one recorded dig against the same starting terrain. Run it once scanning the full grid and again updating only the active regions. Check the resulting piles and mass balance alongside simulation time, terrain update time, and bytes uploaded to the GPU. A useful inspector should let you pause on the frame the bank gives way and see which cells woke up.

The proposed stack is a Rust simulation core compiled to WebAssembly, with TypeScript and Three.js rendering the quarry in WebGL2. Running the same core natively would let us benchmark a dig without the browser or renderer. One open design question is whether an undercut can leave an unsupported shelf. That choice affects how the terrain is stored.

## Release target

The intended release includes a browser build at the project URL and a single downloadable HTML file with its code and assets embedded for offline use.
