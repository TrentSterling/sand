use super::suspension::Suspension;

pub(crate) struct TruckBed {
    x: f32,
    z: f32,
    half_x: f32,
    half_z: f32,
    floor: f32,
    bin_units: f32,
    pub(crate) bins: [i32; 15],
    pub(crate) mass: i32,
    pub(crate) dispatch_ticks: u32,
    pub(crate) offset: f32,
    order: i32,
    heading: f32,
    pub suspension: Suspension,
    speed: f32,
    cargo: [f32; 3],
    pub external: [f32; 3],
    pub blocked: bool,
}

impl TruckBed {
    pub(crate) fn new(
        [x, z]: [f32; 2],
        [half_x, half_z]: [f32; 2],
        floor: f32,
        order: i32,
        heading: f32,
        offroad: bool,
    ) -> Self {
        Self {
            x,
            z,
            half_x,
            half_z,
            floor,
            bin_units: half_x * half_z * 4. / 15. * 64000.,
            bins: [0; 15],
            mass: 0,
            order,
            heading,
            offset: 0.,
            speed: 0.,
            cargo: [0.; 3],
            external: [0.; 3],
            blocked: false,
            suspension: Suspension::new(half_x, half_z, heading, offroad),
            dispatch_ticks: 0,
        }
    }
    pub fn step(&mut self, elevation: impl Fn(f32, f32) -> f32) {
        let mut ground = [0.; 6];
        for (i, h) in ground.iter_mut().enumerate() {
            let x = self.x + self.offset + self.suspension.axles[i / 2];
            let z = self.z
                + if i % 2 == 0 {
                    -self.suspension.half_track
                } else {
                    self.suspension.half_track
                };
            // Three points across the rolling contact patch smooth cell edges.
            let r = self.suspension.radius * 0.42;
            *h = elevation(x, z)
                .max(elevation(x - r, z) - 0.09 * self.suspension.radius)
                .max(elevation(x + r, z) - 0.09 * self.suspension.radius);
        }
        if self.mass >= self.order {
            self.dispatch_ticks = (self.dispatch_ticks + 1).min(450);
        }
        let remaining = (5.8 - self.offset * self.heading).max(0.);
        let target = if self.dispatch_ticks >= 150 && !self.blocked {
            (2.0 * 1.3 * remaining).sqrt().min(1.75)
        } else {
            0.
        };
        let grip: f32 = self.suspension.state[15..].iter().sum();
        let traction = (grip * 0.65 / self.suspension.total_mass(self.cargo[0])).clamp(0., 2.8);
        let accel = ((target - self.speed) * 7.).clamp(-traction, traction.min(1.05));
        self.speed = (self.speed + accel * super::DT).max(0.);
        let distance = (self.speed * super::DT).min(remaining);
        self.offset += distance * self.heading;
        if distance >= remaining {
            self.speed = 0.;
        }
        self.suspension
            .tick(&ground, self.cargo, accel * self.heading, self.external);
    }

    pub(crate) fn catch(&mut self, p: &super::Grain, old_y: f32) -> bool {
        let pose = &self.suspension.state;
        let dx = p.x - self.x - self.offset;
        let dz = p.z - self.z;
        let floor_y = self.floor + pose[0] + pose[1] * dx + pose[2] * dz;
        let (sin_z, cos_z) = pose[1].atan().sin_cos();
        let (sin_x, cos_x) = (-pose[2] * cos_z).atan().sin_cos();
        let dy = p.y - self.floor - pose[0];
        let u = (cos_z * dx + sin_z * dy) / self.half_x;
        let v = (sin_z * sin_x * dx - cos_z * sin_x * dy + cos_x * dz) / self.half_z;
        if u.abs() >= 1. || v.abs() >= 1. || p.vy >= 0. {
            return false;
        }
        let col = ((u + 1.) * 2.5) as usize;
        let row = ((v + 1.) * 1.5) as usize;
        let index = row.min(2) * 5 + col.min(4);
        let surface = floor_y + self.bins[index] as f32 / (self.bin_units * cos_x * cos_z);
        if p.y > surface
            || old_y + 0.005 < floor_y
            || self.mass + p.mass > (self.bin_units * 15. * 0.8) as i32
        {
            return false;
        }
        self.bins[index] += p.mass;
        self.mass += p.mass;
        // Local repose on the steel bed. Material that hits the opposite end stays there.
        for _ in 0..2 {
            for i in 0..15 {
                if i % 5 != 4 {
                    self.level(i, i + 1);
                }
                if i < 10 {
                    self.level(i, i + 5);
                }
            }
        }
        let mut mx = 0.;
        let mut mz = 0.;
        for (i, &units) in self.bins.iter().enumerate() {
            mx += units as f32 * (((i % 5) as f32 + 0.5) / 2.5 - 1.) * self.half_x;
            mz += units as f32 * (((i / 5) as f32 + 0.5) / 1.5 - 1.) * self.half_z;
        }
        self.cargo = [
            self.mass as f32 / 40000.,
            mx / self.mass as f32,
            mz / self.mass as f32,
        ];
        true
    }
    fn level(&mut self, a: usize, b: usize) {
        let d = self.bins[a] - self.bins[b];
        let move_units = ((d.abs() - (self.bin_units * 0.25) as i32).max(0) / 2) * d.signum();
        self.bins[a] -= move_units;
        self.bins[b] += move_units;
    }
}
