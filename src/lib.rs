//! Fixed-step dry sand in integer height units. One unit is 1 mm over a 125 mm square.

pub const N: usize = 256;
const TILE: usize = 16;
const T: usize = N / TILE;
const CELLS: usize = N * N;
pub const CAPACITY: i32 = 67_200;
const DT: f32 = 1.0 / 60.0;
const SETTLE: i32 = 80;
const REST: i32 = 92;
const MAX_AIR: usize = 640;

#[derive(Clone, Copy, Default)]
#[repr(C)]
pub struct Grain {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub mass: i32,
    vx: f32,
    vy: f32,
    vz: f32,
}

pub struct World {
    height: Vec<i32>,
    compact: Vec<u8>,
    base: Vec<i32>,
    in_bay: Vec<bool>,
    active: [u8; T * T],
    next: [u8; T * T],
    dirty: [u8; T * T],
    air: Vec<Grain>,
    phase: usize,
    pub load: i32,
    pub bay: i32,
    pub lost: i32,
    pub visited: usize,
    pub initial: i64,
    pub dense: bool,
    random: u32,
    last_tool: Option<[f32; 4]>,
}

fn coord(i: usize) -> f32 {
    (i as f32 + 0.5) * 0.125 - 16.0
}
fn cell(v: f32) -> i32 {
    ((v + 16.0) * 8.0).floor() as i32
}
fn tile(i: usize) -> usize {
    (i % N) / TILE + (i / N / TILE) * T
}
fn inside(c: i32) -> bool {
    (0..N as i32).contains(&c)
}

impl World {
    pub fn new(dense: bool) -> Self {
        let mut w = Self {
            height: vec![0; CELLS],
            compact: vec![0; CELLS],
            base: vec![0; CELLS],
            in_bay: vec![false; CELLS],
            active: [5; T * T],
            next: [0; T * T],
            dirty: [1; T * T],
            air: Vec::with_capacity(MAX_AIR),
            phase: 0,
            load: 0,
            bay: 0,
            lost: 0,
            visited: 0,
            initial: 0,
            dense,
            random: 27011997,
            last_tool: None,
        };
        for z in 0..N {
            for x in 0..N {
                let i = z * N + x;
                let (a, b) = (coord(x), coord(z));
                let bay = a.abs() < 1.8 && (3.8..7.4).contains(&b);
                w.in_bay[i] = bay;
                let wall = ((1.8..2.04).contains(&a.abs()) && (3.8..7.64).contains(&b))
                    || (a.abs() < 1.8 && (7.4..7.64).contains(&b));
                if wall {
                    w.base[i] = 780;
                }
                // Two overlapping deposited cones leave an asymmetric working face.
                let bank = (2.45
                    - 0.66 * ((a - 5.45).powi(2) + ((b + 0.42) * 0.92).powi(2)).sqrt())
                .max(1.65 - 0.62 * ((a - 6.3).powi(2) + (b - 1.25).powi(2)).sqrt())
                .max(0.0);
                w.height[i] = (1000.0 * bank).round() as i32;
                w.initial += w.height[i] as i64;
            }
        }
        w
    }
    pub fn avalanche(dense: bool) -> Self {
        let mut w = Self::new(dense);
        w.initial = 0;
        w.bay = 0;
        for z in 0..N {
            for x in 0..N {
                let i = z * N + x;
                // Repeated steep banks keep most tiles busy during the opening steps.
                let bank = ((x + (z / 16) * 3) % 24) as i32;
                w.height[i] = if bank < 12 { 110 + bank * 180 } else { 65 };
                w.initial += w.height[i] as i64;
                if w.in_bay[i] {
                    w.bay += w.height[i];
                }
            }
        }
        w
    }
    fn wake(&mut self, i: usize) {
        let t = tile(i);
        self.dirty[t] = 1;
        self.next[t] = 5;
        // An unstable pair can be owned by the neighboring tile to the left or above.
        if i.is_multiple_of(TILE) && !t.is_multiple_of(T) {
            self.next[t - 1] = 5;
        }
        if (i / N).is_multiple_of(TILE) && t >= T {
            self.next[t - T] = 5;
        }
    }
    fn change(&mut self, i: usize, amount: i32) {
        self.height[i] += amount;
        if self.height[i] == 0 {
            self.compact[i] = 0;
        }
        // Fresh loose material dilutes the packed fraction already in this column.
        else if amount > 0 && self.compact[i] != 0 {
            self.compact[i] =
                (self.compact[i] as i32 * (self.height[i] - amount) / self.height[i]) as u8;
        }
        if self.in_bay[i] {
            self.bay += amount;
        }
        self.wake(i);
    }
    fn pair(&mut self, a: usize, b: usize) {
        let delta = self.mm(a) - self.mm(b);
        if delta.abs() <= REST {
            return;
        }
        let (high, low) = if delta > 0 { (a, b) } else { (b, a) };
        let mass = self.height[high].min((delta.abs() - SETTLE + 1) / 2);
        if mass > 0 {
            self.change(high, -mass);
            self.change(low, mass);
        }
    }
    #[inline]
    fn mm(&self, i: usize) -> i32 {
        self.base[i] + self.height[i] - ((self.height[i] * self.compact[i] as i32) >> 11)
    }
    pub fn tracks(&mut self, x: f32, z: f32, yaw: f32) {
        let (s, c) = yaw.sin_cos();
        for iz in cell(z - 2.5).max(0)..=cell(z + 2.5).min(N as i32 - 1) {
            for ix in cell(x - 2.5).max(0)..=cell(x + 2.5).min(N as i32 - 1) {
                let a = coord(ix as usize) - x;
                let b = coord(iz as usize) - z;
                let lateral = (a * s + b * c).abs();
                let i = iz as usize * N + ix as usize;
                if (a * c - b * s).abs() > 1.69
                    || !(0.79..1.39).contains(&lateral)
                    || self.height[i] < 10
                {
                    continue;
                }
                let packed = self.compact[i].saturating_add(12);
                if packed != self.compact[i] {
                    self.compact[i] = packed;
                    self.wake(i);
                }
            }
        }
    }
    fn local_random(&mut self) -> f32 {
        self.random ^= self.random << 13;
        self.random ^= self.random >> 17;
        self.random ^= self.random << 5;
        (self.random >> 8) as f32 / 16_777_216.0 - 0.5
    }
    pub fn surface(&self, x: f32, z: f32) -> f32 {
        let (a, b) = (cell(x), cell(z));
        if !inside(a) || !inside(b) {
            return 0.0;
        }
        let i = b as usize * N + a as usize;
        self.mm(i) as f32 * 0.001
    }
    pub fn tool(&mut self, x: f32, y: f32, z: f32, yaw: f32, pitch: f32) {
        let previous = self.last_tool.replace([x, y, z, pitch]);
        let Some([px, py, pz, pp]) = previous else {
            return;
        };
        let (dx, dz) = (x - px, z - pz);
        let length = dx.hypot(dz);
        let (s, c) = yaw.sin_cos();
        let inward = -(dx * c - dz * s);
        let curl = pitch - pp;
        let speed = length / DT;
        if (pitch < -0.50 || speed > 4.8) && self.load > 0 {
            let fraction = ((-pitch - 0.48) * 0.12)
                .max((speed - 4.8) * 0.008)
                .clamp(0.0, 0.22);
            let amount = ((self.load as f32 * fraction).ceil() as i32)
                .max(100)
                .min(self.load);
            for _ in 0..4 {
                if self.air.len() >= MAX_AIR || self.load <= 0 {
                    break;
                }
                let m = ((amount + 3) / 4).min(self.load);
                let side = self.local_random() * 0.83;
                let spread = self.local_random() * 0.16;
                let vx = (dx / DT).clamp(-3.0, 3.0) + s * side + c * spread;
                let vz = (dz / DT).clamp(-3.0, 3.0) + c * side - s * spread;
                self.air.push(Grain {
                    x: x + s * side,
                    y: y.max(0.03),
                    z: z + c * side,
                    mass: m,
                    vx,
                    vy: -0.30,
                    vz,
                });
                self.load -= m;
            }
        }
        if length + (y - py).abs() + curl.abs() < 0.0002 || y > 3.4 || length > 0.9 {
            return;
        }
        let capture = (inward > 0.001 || curl > 0.002) && pitch > -1.35;
        let budget = ((length + (py - y).max(0.0) * 0.45 + curl.max(0.0) * 0.40) * 72_000.0) as i32;
        if budget < 1 {
            return;
        }
        let mut remaining = budget;
        let ax = cell(x - 0.9).max(0);
        let bx = cell(x + 0.9).min(N as i32 - 1);
        let az = cell(z - 0.9).max(0);
        let bz = cell(z + 0.9).min(N as i32 - 1);
        for gz in az..=bz {
            for gx in ax..=bx {
                if remaining <= 0 {
                    return;
                }
                let i = gz as usize * N + gx as usize;
                let rx = coord(gx as usize) - x;
                let rz = coord(gz as usize) - z;
                if (rx * c - rz * s).abs() > 0.23 || (rx * s + rz * c).abs() > 0.57 {
                    continue;
                }
                let depth = (self.mm(i) - (y.max(0.0) * 1000.0) as i32).min(self.height[i]);
                let mut mass = depth.min(remaining).min(130);
                if mass <= 0 {
                    continue;
                }
                if capture && self.load < CAPACITY {
                    mass = mass.min(CAPACITY - self.load);
                    self.change(i, -mass);
                    self.load += mass;
                } else {
                    let sign = if inward > 0.0 { -1.0 } else { 1.0 };
                    let jx = gx + (c * sign * 4.0).round() as i32;
                    let jz = gz - (s * sign * 4.0).round() as i32;
                    if !inside(jx) || !inside(jz) {
                        continue;
                    }
                    let j = jz as usize * N + jx as usize;
                    if self.base[j] > self.height[i] + self.base[i] {
                        continue;
                    }
                    self.change(i, -mass);
                    self.change(j, mass);
                }
                remaining -= mass;
            }
        }
    }
    pub fn tick(&mut self) {
        for k in 0..T * T {
            self.active[k] = self.active[k].saturating_sub(1).max(self.next[k]);
            self.next[k] = 0;
        }
        let axis = self.phase % 2;
        let parity = (self.phase / 2) % 2;
        self.phase = self.phase.wrapping_add(1);
        self.visited = 0;
        for t in 0..T * T {
            if !self.dense && self.active[t] == 0 {
                continue;
            }
            let x0 = t % T * TILE;
            let z0 = t / T * TILE;
            let (xs, zs, offset) = if axis == 0 { (2, 1, 1) } else { (1, 2, N) };
            let xend = (x0 + TILE).min(N - usize::from(axis == 0));
            let zend = (z0 + TILE).min(N - usize::from(axis == 1));
            for z in (z0 + usize::from(axis == 1) * parity..zend).step_by(zs) {
                for x in (x0 + usize::from(axis == 0) * parity..xend).step_by(xs) {
                    let i = z * N + x;
                    self.pair(i, i + offset);
                    self.visited += 1;
                }
            }
        }
        let mut k = 0;
        while k < self.air.len() {
            let mut p = self.air[k];
            let prev = (p.x, p.z);
            p.vy -= 9.81 * DT;
            p.x += p.vx * DT;
            p.y += p.vy * DT;
            p.z += p.vz * DT;
            let (a, b) = (cell(p.x), cell(p.z));
            if !inside(a) || !inside(b) {
                self.lost += p.mass;
                self.air.swap_remove(k);
                continue;
            }
            let i = b as usize * N + a as usize;
            if p.y <= self.surface(p.x, p.z) {
                let (ax, az) = (cell(prev.0), cell(prev.1));
                let prior = az as usize * N + ax as usize;
                let dest = if self.base[i] > self.base[prior] && p.y < self.base[i] as f32 * 0.001 {
                    prior
                } else {
                    i
                };
                self.change(dest, p.mass);
                self.air.swap_remove(k);
            } else {
                self.air[k] = p;
                k += 1;
            }
        }
    }
    pub fn balance(&self) -> i64 {
        self.height.iter().map(|&v| v as i64).sum::<i64>()
            + self.load as i64
            + self.lost as i64
            + self.air.iter().map(|p| p.mass as i64).sum::<i64>()
            - self.initial
    }
}

// The browser owns each handle and destroys it only after all typed views are retired.
#[no_mangle]
pub extern "C" fn world_new(dense: u32) -> *mut World {
    Box::into_raw(Box::new(World::new(dense != 0)))
}
#[no_mangle]
pub extern "C" fn avalanche_new(dense: u32) -> *mut World {
    Box::into_raw(Box::new(World::avalanche(dense != 0)))
}
/// # Safety
/// Pass a live handle returned by `world_new` or `avalanche_new` exactly once.
/// All references and JavaScript memory views into this world must be retired.
#[no_mangle]
pub unsafe extern "C" fn world_drop(w: *mut World) {
    drop(Box::from_raw(w))
}
#[no_mangle]
pub extern "C" fn world_tick(w: &mut World) {
    w.tick()
}
#[no_mangle]
pub extern "C" fn world_tool(w: &mut World, x: f32, y: f32, z: f32, yaw: f32, pitch: f32) {
    w.tool(x, y, z, yaw, pitch)
}
#[no_mangle]
pub extern "C" fn world_ground(w: &World, x: f32, z: f32) -> f32 {
    w.surface(x, z)
}
#[no_mangle]
pub extern "C" fn world_height(w: &World) -> *const i32 {
    w.height.as_ptr()
}
#[no_mangle]
pub extern "C" fn world_compact(w: &World) -> *const u8 {
    w.compact.as_ptr()
}
#[no_mangle]
pub extern "C" fn world_tracks(w: &mut World, x: f32, z: f32, yaw: f32) {
    w.tracks(x, z, yaw)
}
#[no_mangle]
pub extern "C" fn world_dirty(w: &World) -> *const u8 {
    w.dirty.as_ptr()
}
#[no_mangle]
pub extern "C" fn world_active(w: &World) -> *const u8 {
    w.active.as_ptr()
}
#[no_mangle]
pub extern "C" fn world_clear_dirty(w: &mut World) {
    w.dirty.fill(0)
}
#[no_mangle]
pub extern "C" fn world_air(w: &World) -> *const Grain {
    w.air.as_ptr()
}
#[no_mangle]
pub extern "C" fn world_air_len(w: &World) -> usize {
    w.air.len()
}
#[no_mangle]
pub extern "C" fn world_load(w: &World) -> i32 {
    w.load
}
#[no_mangle]
pub extern "C" fn world_bay(w: &World) -> i32 {
    w.bay
}
#[no_mangle]
pub extern "C" fn world_visited(w: &World) -> usize {
    w.visited
}
#[no_mangle]
pub extern "C" fn world_balance(w: &World) -> i32 {
    w.balance() as i32
}
#[no_mangle]
pub extern "C" fn world_hash(w: &World) -> u32 {
    let mut h = 2166136261u32;
    for (&v, &c) in w.height.iter().zip(&w.compact) {
        h = (h ^ (v as u32) ^ ((c as u32) << 24)).wrapping_mul(16777619);
    }
    for v in [w.load, w.bay, w.lost] {
        h = (h ^ (v as u32)).wrapping_mul(16777619);
    }
    for p in &w.air {
        for v in [
            p.x.to_bits(),
            p.y.to_bits(),
            p.z.to_bits(),
            p.vx.to_bits(),
            p.vy.to_bits(),
            p.vz.to_bits(),
            p.mass as u32,
        ] {
            h = (h ^ v).wrapping_mul(16777619);
        }
    }
    h
}

/// Measured on both schedulers with exactly the same fixed-step tool path.
#[no_mangle]
pub extern "C" fn replay_step(w: &mut World, frame: u32) {
    let keys = [
        (0, 6.7, 3.1, 0.0, -0.9),
        (42, 6.1, 0.58, 0.0, -0.85),
        (115, 3.95, 0.57, 0.0, 0.45),
        (173, 4.15, 2.85, 0.0, 0.50),
        (280, 5.5, 2.6, -1.5707964, 0.40),
        (328, 5.55, 2.2, -1.5707964, -1.2),
        (370, 5.55, 2.2, -1.5707964, -1.2),
    ];
    if frame <= 370 {
        let pair = keys.windows(2).find(|p| frame <= p[1].0).unwrap();
        let (a, b) = (pair[0], pair[1]);
        let t = (frame - a.0) as f32 / (b.0 - a.0) as f32;
        let blend = |x: f32, y: f32| x + (y - x) * t;
        let r = blend(a.1, b.1);
        let yaw = blend(a.3, b.3);
        w.tool(
            r * yaw.cos(),
            blend(a.2, b.2),
            -r * yaw.sin(),
            yaw,
            blend(a.4, b.4),
        );
    }
    w.tick();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replay_conserves_mass_and_matches_full_grid_each_step() {
        let mut sparse = World::new(false);
        let mut dense = World::new(true);
        let (mut peak, mut sparse_pairs, mut dense_pairs) = (0, 0, 0);
        for frame in 0..720 {
            replay_step(&mut sparse, frame);
            replay_step(&mut dense, frame);
            peak = peak.max(sparse.load);
            assert_eq!(sparse.height, dense.height, "terrain step {frame}");
            assert_eq!(sparse.balance(), 0);
            assert_eq!(dense.balance(), 0);
            sparse_pairs += sparse.visited;
            dense_pairs += dense.visited;
        }
        assert!(peak > CAPACITY / 3 && sparse.bay > 10_000);
        assert!(sparse_pairs < dense_pairs / 8);
        assert_eq!(world_hash(&sparse), world_hash(&dense));
        assert!(sparse.air.is_empty());
        assert_eq!(sparse.visited, 0);
        println!("peak={peak} bay={} mass_error={} sparse_pairs={sparse_pairs} dense_pairs={dense_pairs}",sparse.bay,sparse.balance());
    }
    #[test]
    fn stationary_or_reverse_facing_bucket_does_not_collect() {
        let mut w = World::new(false);
        for n in 0..80 {
            w.tool(4.0 + n as f32 * 0.022, 0.25, 0., 0., -0.75);
            w.tick();
        }
        for _ in 0..100 {
            w.tool(5.738, 0.25, 0., 0., -0.75);
            w.tick();
        }
        assert_eq!(w.load, 0);
        assert_eq!(w.balance(), 0);
    }
    #[test]
    fn tracks_lower_the_surface_and_preserve_material() {
        let mut w = World::new(false);
        let original = w.surface(5.4, 1.1);
        for _ in 0..25 {
            w.tracks(5.4, 0.0, 0.0);
        }
        assert!(w.surface(5.4, 1.1) < original * 0.90);
        assert_eq!(w.balance(), 0);
    }
    #[test]
    fn complete_yard_collapse_matches_dense_scan() {
        let mut a = World::avalanche(false);
        let mut b = World::avalanche(true);
        for _ in 0..360 {
            a.tick();
            b.tick();
        }
        assert_eq!(a.height, b.height);
        assert_eq!(a.balance(), 0);
        assert_eq!(b.balance(), 0);
    }
}
