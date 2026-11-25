//! Six unsprung wheel masses and a sprung chassis, integrated in tonnes, metres and seconds.
//! The driver follows a straight dispatch lane. Suspension and bed attitude use world X/Z.
const G: f32 = 9.81;
const H: f32 = 1.0 / 240.0;

pub(crate) struct Suspension {
    pub axles: [f32; 3],
    pub half_track: f32,
    pub radius: f32,
    mass: f32,
    wheel_mass: f32,
    travel: f32,
    tandem_share: f32,
    com_x: f32,
    heave: f32,
    pitch: f32,
    roll: f32,
    velocity: [f32; 3],
    hub_v: [f32; 6],
    // Bed centre elevation change, two surface gradients, six hub heights,
    // six spring compressions and six normal loads in kN.
    pub state: [f32; 21],
}

impl Suspension {
    pub fn new(l: f32, w: f32, heading: f32, offroad: bool) -> Self {
        let (mass, wheel_mass, radius, travel, cab) = if offroad {
            (13.2, 0.24, 0.65, 0.48, 1.36)
        } else {
            (8.6, 0.16, 0.51, 0.31, 0.85)
        };
        let axles = [-l + 0.51, l - 0.72, l + cab + 0.85].map(|x| x * heading);
        let com_x = axles.iter().sum::<f32>() / 3.;
        let mut state = [0.; 21];
        state[3..9].fill(radius);
        state[9..15].fill(travel * 0.42);
        state[15..].fill((mass / 6. + wheel_mass) * G);
        Self {
            axles,
            half_track: w - 0.025,
            radius,
            mass,
            wheel_mass,
            travel,
            tandem_share: if offroad { 0.34 } else { 0.20 },
            com_x,
            heave: 0.,
            pitch: 0.,
            roll: 0.,
            velocity: [0.; 3],
            hub_v: [0.; 6],
            state,
        }
    }

    pub fn total_mass(&self, cargo: f32) -> f32 {
        self.mass + 6. * self.wheel_mass + cargo
    }

    pub fn tick(&mut self, ground: &[f32; 6], cargo: [f32; 3], accel: f32, external: [f32; 3]) {
        let [load, cargo_x, cargo_z] = cargo;
        let total = self.mass + load;
        let static_force = self.mass * G / 6.;
        let preload = self.travel * 0.42;
        let spring = static_force / preload;
        let tyre_k = (static_force + self.wheel_mass * G) / 0.032;
        let damper = 0.48 * (spring * self.mass / 6.).sqrt();
        let tyre_c = 0.55 * (tyre_k * self.wheel_mass).sqrt();
        let pitch_inertia = self.mass * 3.8 + load * ((cargo_x - self.com_x).powi(2) + 0.65);
        let roll_inertia = self.mass * 1.12 + load * (cargo_z * cargo_z + 0.65);
        for _ in 0..4 {
            let mut force = -total * G - external[0];
            let mut pitch_torque = -load * G * (cargo_x - self.com_x) + total * accel * 0.88
                - external[1]
                + external[0] * self.com_x;
            let mut roll_torque = -load * G * cargo_z - external[2];
            // Compute axle coupling from a common pose to avoid left/right update bias.
            let compression_at = |i: usize| {
                let x = self.axles[i / 2] - self.com_x;
                let z = if i.is_multiple_of(2) {
                    -self.half_track
                } else {
                    self.half_track
                };
                preload + self.state[3 + i]
                    - self.radius
                    - self.heave
                    - x * self.pitch
                    - z * self.roll
            };
            let deflections: [f32; 6] = std::array::from_fn(compression_at);
            for (i, &floor) in ground.iter().enumerate() {
                let x = self.axles[i / 2] - self.com_x;
                let z = if i.is_multiple_of(2) {
                    -self.half_track
                } else {
                    self.half_track
                };
                let body_v = self.velocity[0] + x * self.velocity[1] + z * self.velocity[2];
                let hub = self.state[3 + i];
                let v = self.hub_v[i];
                let compression = deflections[i];
                let rate = v - body_v;
                let bump = (compression - self.travel * 0.84).max(0.);
                let droop = compression.min(0.);
                let antiroll = 0.12 * (compression - deflections[i ^ 1]);
                let tandem = if i < 4 {
                    self.tandem_share * (deflections[i ^ 2].max(0.) - compression.max(0.))
                } else {
                    0.
                };
                let support = spring * (compression.max(0.) + antiroll + tandem)
                    + spring * 6. * bump
                    + spring * 5. * droop
                    + damper * if rate > 0. { 1. } else { 1.65 } * rate;
                let deflection = floor + self.radius + 0.032 - hub;
                let normal = if deflection > 0. {
                    (tyre_k * deflection - tyre_c * v).max(0.)
                } else {
                    0.
                };
                self.hub_v[i] += (normal - support - self.wheel_mass * G) / self.wheel_mass * H;
                self.state[3 + i] += self.hub_v[i] * H;
                self.state[9 + i] = compression;
                self.state[15 + i] = normal;
                force += support;
                pitch_torque += x * support;
                roll_torque += z * support;
            }
            self.velocity[0] += force / total * H;
            self.velocity[1] += pitch_torque / pitch_inertia * H;
            self.velocity[2] += roll_torque / roll_inertia * H;
            self.heave += self.velocity[0] * H;
            self.pitch += self.velocity[1] * H;
            self.roll += self.velocity[2] * H;
        }
        self.state[0] = self.heave - self.com_x * self.pitch;
        self.state[1] = self.pitch;
        self.state[2] = self.roll;
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn six_contacts_carry_static_mass_and_respond_to_an_offcentre_load() {
        for offroad in [false, true] {
            let mut s = Suspension::new(1.7, 1., 1., offroad);
            let flat = [0.; 6];
            for _ in 0..240 {
                s.tick(&flat, [0.; 3], 0., [0.; 3]);
            }
            let empty = s.state;
            assert!((empty[15..].iter().sum::<f32>() - s.total_mass(0.) * G).abs() < 0.1);
            for _ in 0..240 {
                s.tick(&flat, [2., -1., 0.65], 0., [0.; 3]);
            }
            let loaded = s.state;
            assert!(loaded[0] < empty[0] - 0.025 && loaded[1] > 0.005 && loaded[2] < -0.01);
            assert!(loaded[10] > loaded[9] && loaded[10] > loaded[14]);
            assert!((loaded[15..].iter().sum::<f32>() - s.total_mass(2.) * G).abs() < 0.25);
            println!(
                "offroad={offroad} load=2t bed sag={:.1}mm pitch={:.2}deg roll={:.2}deg",
                -1000. * loaded[0],
                loaded[1].atan().to_degrees(),
                loaded[2].atan().to_degrees()
            );
        }
    }

    #[test]
    fn single_wheel_bump_droop_and_rebound() {
        let mut s = Suspension::new(1.58, 0.95, 1., false);
        let mut ground = [0.; 6];
        ground[1] = 0.19;
        let mut peak_roll = f32::MIN;
        for _ in 0..120 {
            s.tick(&ground, [0.; 3], 0., [0.; 3]);
            peak_roll = peak_roll.max(s.state[2]);
        }
        assert!(s.state[4] - s.state[3] > 0.15 && peak_roll > 0.025);
        ground[1] = -0.8;
        s.tick(&ground, [0.; 3], 0., [0.; 3]);
        assert_eq!(s.state[16], 0.);
        for _ in 0..50 {
            s.tick(&ground, [0.; 3], 0., [0.; 3]);
        }
        assert!(s.state[10] < 0.01 && s.state[16] < 0.1);
        for _ in 0..300 {
            s.tick(&[0.; 6], [0.; 3], 0., [0.; 3]);
        }
        assert!(s.state[..3].iter().all(|v| v.abs() < 0.001));
        assert!(s.state[15..].iter().all(|v| *v > 5.));
        println!(
            "one wheel +190 mm, peak body roll {:.2}deg; dropped wheel regained contact",
            peak_roll.atan().to_degrees()
        );
    }
}
