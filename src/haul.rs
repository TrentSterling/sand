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
}

impl TruckBed {
    pub(crate) fn new(
        x: f32,
        z: f32,
        half_x: f32,
        half_z: f32,
        floor: f32,
        order: i32,
        heading: f32,
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
            dispatch_ticks: 0,
        }
    }
    pub(crate) fn drive(&mut self) {
        if self.mass < self.order || self.dispatch_ticks >= 450 {
            return;
        }
        self.dispatch_ticks += 1;
        let t = (self.dispatch_ticks.saturating_sub(150) as f32 / 300.).min(1.);
        self.offset = self.heading * 5.8 * t * t * (3. - 2. * t);
    }

    pub(crate) fn catch(&mut self, p: &super::Grain, old_y: f32) -> bool {
        let u = (p.x - self.x - self.offset) / self.half_x;
        let v = (p.z - self.z) / self.half_z;
        if u.abs() >= 1. || v.abs() >= 1. || p.vy >= 0. {
            return false;
        }
        let col = ((u + 1.) * 2.5) as usize;
        let row = ((v + 1.) * 1.5) as usize;
        let index = row.min(2) * 5 + col.min(4);
        let surface = self.floor + self.bins[index] as f32 / self.bin_units;
        if p.y > surface
            || old_y + 0.005 < self.floor
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
        true
    }
    fn level(&mut self, a: usize, b: usize) {
        let d = self.bins[a] - self.bins[b];
        let move_units = ((d.abs() - (self.bin_units * 0.25) as i32).max(0) / 2) * d.signum();
        self.bins[a] -= move_units;
        self.bins[b] += move_units;
    }
}
