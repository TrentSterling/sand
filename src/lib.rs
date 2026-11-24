//! Fixed-step dry sand in integer height units. One unit is 1 mm over a 125 mm square.

pub const N: usize = 256;
const TILE: usize = 16;
const T: usize = N / TILE;
const CELLS: usize = N * N;
// The modeled bucket holds 0.44 m³ struck and 0.55 m³ with a heaped load.
pub const CAPACITY: i32 = 35_200;
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
    tip_velocity: Option<[f32; 2]>,
    tip_accel: [f32; 2],
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
            tip_velocity: None,
            tip_accel: [0.0; 2],
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
        self.track_contact(x, z, yaw, [f32::NEG_INFINITY, 0., 0.]);
    }
    pub fn track_contact(&mut self, x: f32, z: f32, yaw: f32, plane: [f32; 3]) {
        let (s, c) = yaw.sin_cos();
        for iz in cell(z - 2.5).max(0)..=cell(z + 2.5).min(N as i32 - 1) {
            for ix in cell(x - 2.5).max(0)..=cell(x + 2.5).min(N as i32 - 1) {
                let a = coord(ix as usize) - x;
                let b = coord(iz as usize) - z;
                let lateral = a * s + b * c;
                let fore = a * c - b * s;
                let i = iz as usize * N + ix as usize;
                if fore.abs() > 1.69
                    || !(0.79..1.39).contains(&lateral.abs())
                    || self.height[i] < 10
                    || (self.mm(i) as f32) * 0.001 + 0.035
                        < plane[0] + fore * plane[1] + lateral * plane[2]
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
    fn neighbors(i: usize) -> [usize; 4] {
        [
            if i.is_multiple_of(N) { i } else { i - 1 },
            if (i + 1).is_multiple_of(N) { i } else { i + 1 },
            if i < N { i } else { i - N },
            if i + N >= CELLS { i } else { i + N },
        ]
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
        let mut curl = (pitch - pp) % std::f32::consts::TAU;
        if curl > std::f32::consts::PI {
            curl -= std::f32::consts::TAU;
        }
        if curl < -std::f32::consts::PI {
            curl += std::f32::consts::TAU;
        }
        // A discontinuous control pose seeds the new contact; it has no physical velocity.
        if length > 0.9 || (y - py).abs() > 0.9 {
            self.tip_velocity = None;
            self.tip_accel = [0.0; 2];
            return;
        }
        let velocity = [dx / DT, dz / DT];
        if let Some(prior) = self.tip_velocity.replace(velocity) {
            for k in 0..2 {
                let instant = ((velocity[k] - prior[k]) / DT).clamp(-55.0, 55.0);
                self.tip_accel[k] += 0.18 * (instant - self.tip_accel[k]);
            }
        }
        if self.load > 0 {
            self.spill(
                [x, y, z],
                [velocity[0], (y - py) / DT, velocity[1]],
                (s, c),
                pitch,
            );
        }
        if length + (y - py).abs() + curl.abs() < 0.0002 || y > 3.4 {
            return;
        }
        let capture = (inward > 0.001 || curl > 0.002) && (pitch - 0.32).cos() > -0.10;
        let budget = ((length + (py - y).max(0.0) * 0.45 + curl.max(0.0) * 0.40) * 72_000.0) as i32;
        if budget < 1 {
            return;
        }
        let tooth_mm = (y.max(0.0) * 1000.0) as i32;
        let mut sources = [(0usize, 0i32); 64];
        let (mut count, mut demand, mut source_high) = (0, 0, 0);
        for gz in cell(z - 0.65).max(0)..=cell(z + 0.65).min(N as i32 - 1) {
            for gx in cell(x - 0.65).max(0)..=cell(x + 0.65).min(N as i32 - 1) {
                let rx = coord(gx as usize) - x;
                let rz = coord(gz as usize) - z;
                if (rx * c - rz * s).abs() > 0.23 || (rx * s + rz * c).abs() > 0.57 {
                    continue;
                }
                let i = gz as usize * N + gx as usize;
                let h = self.mm(i);
                if h <= tooth_mm || self.height[i] == 0 {
                    continue;
                }
                // A full bucket meets resistance from the face. Bound the new
                // edge gradient while the neighboring sand is still supported.
                let shoulder = Self::neighbors(i)
                    .into_iter()
                    .filter(|&j| self.height[j] != 0)
                    .map(|j| self.mm(j))
                    .max()
                    .unwrap_or(h);
                let available = (h - tooth_mm)
                    .min(self.height[i])
                    .min(130)
                    .min(h - shoulder + REST + 28);
                if available > 0 {
                    sources[count] = (i, available);
                    count += 1;
                    demand += available;
                    source_high = source_high.max(h);
                }
            }
        }
        if demand == 0 {
            return;
        }
        let work = demand.min(budget);
        let captured = if capture {
            work.min(CAPACITY - self.load)
        } else {
            0
        };
        let mut pushed = 0;
        if work > captured {
            // Loose soil bleeds around both bucket cheeks and forms a wedge
            // ahead of the moving lip. Restrict every receiver using the same
            // pre-cut neighborhood, then apportion the accepted mass by area.
            let direction = if inward > 0.0 { -1.0 } else { 1.0 };
            let (tx, tz) = (
                cell(x).clamp(0, N as i32 - 1),
                cell(z).clamp(0, N as i32 - 1),
            );
            let near_wall = x.abs() < 3.5 && (2.3..9.1).contains(&z);
            let mut receivers = [(0usize, 0i32); 256];
            let (mut receiver_count, mut capacity) = (0, 0);
            for gz in cell(z - 1.4).max(0)..=cell(z + 1.4).min(N as i32 - 1) {
                for gx in cell(x - 1.4).max(0)..=cell(x + 1.4).min(N as i32 - 1) {
                    let rx = coord(gx as usize) - x;
                    let rz = coord(gz as usize) - z;
                    let advance = (rx * c - rz * s) * direction;
                    let side = (rx * s + rz * c).abs();
                    let shoulder = side > 0.57 && side < 1.14 && advance.abs() < 0.61;
                    let nose = advance > 0.23 && advance < 1.03 && side < 0.79;
                    if !(shoulder || nose) {
                        continue;
                    }
                    let i = gz as usize * N + gx as usize;
                    let h = self.mm(i);
                    if self.base[i] > 0 || h > source_high + REST {
                        continue;
                    }
                    if near_wall && !self.clear_route(tx, tz, gx, gz, tooth_mm) {
                        continue;
                    }
                    let low = Self::neighbors(i)
                        .into_iter()
                        .map(|j| self.mm(j))
                        .min()
                        .unwrap();
                    let allowance = (low + REST - h).min(70);
                    if allowance > 0 {
                        receivers[receiver_count] = (i, allowance);
                        receiver_count += 1;
                        capacity += allowance;
                    }
                }
            }
            pushed = (work - captured).min(capacity);
            self.distribute(&receivers[..receiver_count], capacity, pushed);
        }
        self.distribute(&sources[..count], demand, -(captured + pushed));
        self.load += captured;
    }
    fn spill(
        &mut self,
        [x, y, z]: [f32; 3],
        [vx, vy, vz]: [f32; 3],
        (s, c): (f32, f32),
        pitch: f32,
    ) {
        // Apparent acceleration toward the mouth or over a sidewall lowers
        // the retained free surface. Steady transport creates no spill.
        let outward = self.tip_accel[0] * c - self.tip_accel[1] * s;
        let lateral = self.tip_accel[0] * s + self.tip_accel[1] * c;
        let shear =
            ((outward - 6.5).max(0.0) * 0.020 + (lateral.abs() - 3.7).max(0.0) * 0.025).min(0.36);
        // The actual signed angle can wrap past a half turn; an inverted cup drains.
        let gravity_capacity = (((pitch - 0.52).cos() - 0.05) / 0.50).clamp(0.0, 1.0);
        let retained = (CAPACITY as f32 * (gravity_capacity - shear).max(0.0)) as i32;
        let excess = (self.load - retained).max(0);
        if excess == 0 {
            return;
        }
        // Discharge is metered over the lip. An open heaped bucket takes
        // roughly three quarters of a second to empty during a normal tip.
        let rate = 145 + (self.load as f32 * 0.009 + (1.0 - gravity_capacity) * 800.0) as i32;
        let amount = excess.min(rate);
        let parcels = ((amount + 419) / 420).clamp(1, 4) as usize;
        if self.air.len() + parcels > MAX_AIR {
            return;
        }
        for k in 0..parcels {
            let mass =
                amount * (k + 1) as i32 / parcels as i32 - amount * k as i32 / parcels as i32;
            let side = (self.local_random() * 0.84 - lateral.clamp(-12.0, 12.0) * 0.009)
                .clamp(-0.52, 0.52);
            let scatter = self.local_random() * 0.13;
            let lip_speed = 0.16 + (1.0 - gravity_capacity) * 0.36;
            self.air.push(Grain {
                x: x + s * side,
                y: y.max(0.03),
                z: z + c * side,
                mass,
                vx: vx.clamp(-5.0, 5.0) - c * lip_speed + s * (side + scatter),
                vy: vy.clamp(-3.0, 3.0) - 0.35,
                vz: vz.clamp(-5.0, 5.0) + s * lip_speed + c * (side + scatter),
            });
        }
        self.load -= amount;
    }
    // Integer cumulative apportionment. Rounding changes each column by less
    // than one unit and the total is exact, independently of scan direction.
    fn distribute(&mut self, columns: &[(usize, i32)], total: i32, amount: i32) {
        if amount == 0 {
            return;
        }
        let (mut sum, mut previous) = (0, 0);
        for &(i, weight) in columns {
            sum += weight;
            let end = sum * amount / total;
            if end != previous {
                self.change(i, end - previous);
            }
            previous = end;
        }
    }
    // A parcel represents many grains. Its resting footprint is a small
    // repose cone on the receiving surface, clipped by the concrete bay.
    fn deposit(&mut self, impact: usize, mass: i32) {
        if mass <= 12 {
            self.change(impact, mass);
            return;
        }
        let (cx, cz) = ((impact % N) as i32, (impact / N) as i32);
        let near_wall =
            (cell(-3.0)..=cell(3.0)).contains(&cx) && (cell(2.9)..=cell(8.5)).contains(&cz);
        let radius = if mass < 160 {
            1
        } else if mass < 640 {
            2
        } else if mass < 2000 {
            3
        } else {
            4
        };
        let mut footprint = [(0usize, 0i32); 81];
        let (mut count, mut floor) = (0, i32::MAX);
        for dz in -radius..=radius {
            for dx in -radius..=radius {
                let (x, z) = (cx + dx, cz + dz);
                if dx * dx + dz * dz > radius * radius || !inside(x) || !inside(z) {
                    continue;
                }
                if near_wall && !self.clear_route(cx, cz, x, z, self.mm(impact)) {
                    continue;
                }
                let i = z as usize * N + x as usize;
                // Octile distance tracks the radial repose slope within 8%.
                let diagonal = dx.abs().min(dz.abs());
                let cost = self.mm(i) + SETTLE * dx.abs().max(dz.abs()) + 33 * diagonal;
                footprint[count] = (i, cost);
                floor = floor.min(cost);
                count += 1;
            }
        }
        let footprint = &footprint[..count];
        let (mut lo, mut hi) = (floor, floor + mass + 1);
        while hi - lo > 1 {
            let middle = (lo + hi) / 2;
            let volume: i32 = footprint
                .iter()
                .map(|&(_, cost)| (middle - cost).max(0))
                .sum();
            if volume > mass {
                hi = middle;
            } else {
                lo = middle;
            }
        }
        let mut residue = mass;
        for &(i, cost) in footprint {
            let share = (lo - cost).max(0);
            if share > 0 {
                self.change(i, share);
                residue -= share;
            }
        }
        for &(i, cost) in footprint {
            if residue == 0 {
                break;
            }
            if cost <= lo {
                self.change(i, 1);
                residue -= 1;
            }
        }
        debug_assert_eq!(residue, 0);
    }
    fn clear_route(&self, cx: i32, cz: i32, x: i32, z: i32, clearance: i32) -> bool {
        let dx = x - cx;
        let dz = z - cz;
        let steps = dx.abs().max(dz.abs());
        for k in 1..=steps {
            let tx = cx + (dx * k + dx.signum() * (steps / 2)) / steps;
            let tz = cz + (dz * k + dz.signum() * (steps / 2)) / steps;
            if self.base[tz as usize * N + tx as usize] > clearance {
                return false;
            }
        }
        true
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
                let prior = if inside(ax) && inside(az) {
                    az as usize * N + ax as usize
                } else {
                    i
                };
                let dest = if self.base[i] > self.base[prior] && p.y < self.base[i] as f32 * 0.001 {
                    prior
                } else {
                    i
                };
                self.deposit(dest, p.mass);
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
pub extern "C" fn world_bearing(w: &World, x: f32, z: f32) -> f32 {
    let (cx, cz) = (cell(x), cell(z));
    if !inside(cx) || !inside(cz) {
        return 0.;
    }
    let i = cz as usize * N + cx as usize;
    // Allow up to 65 mm of shoe seating, limited by remaining compressible depth.
    let loose = ((w.height[i] as i64 * (255 - i64::from(w.compact[i]))) >> 11).min(65) as i32;
    (w.mm(i) - loose) as f32 * 0.001
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
pub extern "C" fn world_track_contact(
    w: &mut World,
    x: f32,
    z: f32,
    yaw: f32,
    y: f32,
    fore: f32,
    lateral: f32,
) {
    w.track_contact(x, z, yaw, [y, fore, lateral]);
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
pub extern "C" fn bucket_capacity() -> i32 {
    CAPACITY
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
    fn full_bucket_drag_leaves_a_low_berm_and_relaxes_when_held() {
        let mut sparse = World::new(false);
        let mut dense = World::new(true);
        for world in [&mut sparse, &mut dense] {
            // Begin with a load carried in from outside the quarry.
            world.load = CAPACITY;
            world.initial += i64::from(CAPACITY);
        }
        let original = sparse.height.clone();
        let (mut peak_rise, mut peak_lip, mut settled_lip) = (0, 0, 0);
        let mut cut = 0i64;
        for frame in 0..360 {
            // Constant travel through the working face, then decelerate into
            // the hold; this isolates displacement from an emergency-stop spill.
            let brake = ((frame as f32 - 100.0) / 24.0).clamp(0.0, 1.0);
            let travel = frame.min(100) as f32 + 24.0 * (brake - 0.5 * brake * brake);
            let x = 6.9 - 3.6 * travel / 112.0;
            for world in [&mut sparse, &mut dense] {
                world.tool(x, 0.54, -0.37, 0.0, 0.5);
                world.tick();
            }
            assert_eq!(
                sparse.height, dense.height,
                "full-bucket drag frame {frame}"
            );
            assert_eq!(sparse.balance(), 0);
            assert_eq!(sparse.load, CAPACITY);
            let mut lip = 0;
            cut = 0;
            for z in cell(-2.4)..=cell(1.6) {
                for x in cell(1.8)..=cell(8.4) {
                    let i = z as usize * N + x as usize;
                    let rise = sparse.height[i] - original[i];
                    if rise > 0 {
                        peak_rise = peak_rise.max(rise);
                        for neighbor in [i - 1, i + 1, i - N, i + N] {
                            lip = lip.max(sparse.mm(i) - sparse.mm(neighbor));
                        }
                    } else {
                        cut -= i64::from(rise);
                    }
                }
            }
            peak_lip = peak_lip.max(lip);
            settled_lip = lip;
        }
        println!("full drag peak rise={peak_rise} mm; peak lip={peak_lip} mm/125 mm; settled lip={settled_lip} mm; displaced={cut}");
        assert!(
            cut > 10_000 && peak_rise > 5,
            "full bucket should still plow soil"
        );
        assert!(
            peak_rise < 225,
            "full-bucket drag built a spike {peak_rise} mm high"
        );
        assert!(peak_lip < 200, "one-cell spike at the tool {peak_lip} mm");
        assert!(settled_lip <= REST);
    }
    #[test]
    fn steady_fast_transport_and_lifting_retain_the_load() {
        for &(dx, dy, dz) in &[
            (0.13, 0.0, 0.0),
            (0.0, 0.12, 0.0),
            (0.0, 0.0, 0.11),
            (0., 0., 0.),
        ] {
            let mut w = World::new(false);
            w.load = CAPACITY;
            w.initial += i64::from(CAPACITY);
            for n in 0..42 {
                w.tool(
                    -8.0 + dx * n as f32,
                    4.0 + dy * n as f32,
                    -7.0 + dz * n as f32,
                    0.0,
                    0.55,
                );
                w.tick();
            }
            assert_eq!(w.load, CAPACITY, "velocity = {dx},{dy},{dz}");
            assert!(w.air.is_empty());
            assert_eq!(w.balance(), 0);
        }
    }
    #[test]
    fn sideways_acceleration_slips_over_the_cheek_but_a_light_load_stays_in() {
        for load in [CAPACITY, CAPACITY / 3] {
            let mut w = World::new(false);
            w.load = load;
            w.initial += i64::from(load);
            for frame in 0..24 {
                let t = (frame as f32 - 4.).max(0.) * DT;
                let angle = 0.5 * 2.4 * t * t;
                w.tool(
                    -5. + 5. * angle.cos(),
                    4.,
                    -5. - 5. * angle.sin(),
                    angle,
                    0.55,
                );
                w.tick();
            }
            if load == CAPACITY {
                assert!(w.load < load - 500 && w.load > load * 2 / 3);
            } else {
                assert_eq!(w.load, load);
            }
            assert_eq!(w.balance(), 0);
        }
    }
    #[test]
    fn an_open_or_inverted_bucket_finishes_draining_and_settles() {
        for pitch in [
            -1.22,
            std::f32::consts::PI - 0.02,
            -std::f32::consts::PI + 0.02,
        ] {
            let mut w = World::new(false);
            w.load = CAPACITY;
            w.initial += i64::from(CAPACITY);
            for _ in 0..140 {
                w.tool(-7.0, 2.0, -6.0, 0.0, pitch);
                w.tick();
            }
            assert_eq!(w.load, 0);
            assert!(w.air.is_empty());
            assert_eq!(w.balance(), 0);
        }
        let mut w = World::new(false);
        w.load = 11;
        w.initial += 11;
        for _ in 0..100 {
            w.tool(-5., 1., -5., 0., -1.3);
            w.tick();
        }
        assert_eq!((w.load, w.air.len(), w.balance()), (0, 0, 0));
    }
    #[test]
    fn impact_forms_a_repose_footprint_and_stays_on_its_side_of_concrete() {
        let mut w = World::new(false);
        let impact = cell(-6.0) as usize * N + cell(-6.0) as usize;
        w.initial += 2800;
        w.deposit(impact, 2800);
        let neighborhood = (-4..=4).flat_map(|dz| {
            (-4..=4).map(move |dx| (impact as isize + dz * N as isize + dx) as usize)
        });
        let mut footprint = 0;
        let mut crest = 0;
        let mut relief = 0;
        for i in neighborhood {
            let high = w.height[i];
            footprint += usize::from(high > 0);
            crest = crest.max(high);
            relief = relief
                .max(high - w.height[i + 1])
                .max(high - w.height[i - 1]);
        }
        assert!(
            footprint > 15 && crest < 310 && relief <= REST,
            "footprint={footprint} crest={crest} relief={relief}"
        );
        let bay_before = w.bay;
        let beside_wall = cell(5.1) as usize * N + cell(2.13) as usize;
        w.initial += 2800;
        w.deposit(beside_wall, 2800);
        assert_eq!(w.bay, bay_before);
        assert_eq!(w.balance(), 0);
        println!("landed 2800 units across {footprint} cells; crest={crest} mm; axial relief={relief} mm");
    }
    #[test]
    fn a_symmetric_full_bucket_cut_pushes_on_both_cheeks() {
        let mut w = World::new(false);
        w.height.fill(600);
        w.load = CAPACITY;
        let before = w.height.clone();
        w.tool(-4., 0.2, -5., 0., 0.5);
        w.tool(-4.015, 0.2, -5., 0., 0.5);
        let (mut left, mut right) = (0, 0);
        for gz in cell(-6.2)..=cell(-3.8) {
            for gx in cell(-5.2)..=cell(-2.8) {
                let i = gz as usize * N + gx as usize;
                let banked = (w.height[i] - before[i]).max(0);
                if coord(gz as usize) < -5. {
                    left += banked;
                } else {
                    right += banked;
                }
            }
        }
        assert!(
            left > 450 && right > 450 && (left - right).abs() < 6,
            "left/right share on a level bed: {left}/{right}"
        );
    }
    #[test]
    fn a_cut_can_reach_the_last_cells_inside_the_quarry() {
        let mut w = World::new(false);
        let row = cell(-6.) as usize * N;
        for i in row..row + 6 {
            w.height[i] = 800;
            w.initial += 800;
        }
        w.tool(-15.8, 0.25, -6., 0., 0.5);
        w.tool(-15.95, 0.25, -6., 0., 0.5);
        assert!(w.load > 0 && w.height[row] < 800);
        assert_eq!(w.balance(), 0);
    }
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
    fn bridged_shoes_only_compact_soil_in_contact() {
        let mut w = World::new(false);
        let i = cell(1.1) as usize * N + cell(5.4) as usize;
        let level = w.mm(i) as f32 * 0.001;
        let bearing = world_bearing(&w, 5.4, 1.1);
        assert!((level - bearing - 0.065).abs() < 0.001);
        w.track_contact(5.4, 0., 0., [level + 0.2, 0., 0.]);
        assert_eq!(w.compact[i], 0);
        for _ in 0..24 {
            w.track_contact(5.4, 0., 0., [bearing, 0., 0.]);
        }
        assert!(w.compact[i] > 0);
        assert!(w.mm(i) as f32 * 0.001 >= bearing - 0.055);
        assert_eq!(world_bearing(&w, -4., -4.), 0.);
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
