//! Native solver comparison. Run with cargo run --release --bin bench.
use sandlab::{replay_step, world_hash, World, N};
use std::time::{Duration, Instant};

const TICKS: u32 = 720;
const SAMPLES: usize = 21;
const WARMUPS: usize = 2;

#[derive(Debug, PartialEq)]
struct Outcome {
    hash: u32,
    mass_error: i64,
    visited_pairs: u64,
}

fn replay(dense: bool) -> (Duration, Outcome) {
    let mut world = World::new(dense);
    let mut visited_pairs = 0;
    let start = Instant::now();
    for frame in 0..TICKS {
        replay_step(&mut world, frame);
        visited_pairs += world.visited as u64;
    }
    let elapsed = start.elapsed();
    let outcome = Outcome {
        hash: world_hash(&world),
        mass_error: world.balance(),
        visited_pairs,
    };
    assert_eq!(outcome.mass_error, 0, "replay lost material");
    (elapsed, outcome)
}

fn describe(samples: &mut [Duration], outcome: &Outcome) -> String {
    samples.sort_unstable();
    let millis_at = |percent: usize| {
        let rank = (percent * samples.len()).div_ceil(100);
        samples[rank - 1].as_secs_f64() * 1000.0
    };
    format!(
        r#"{{"median_ms":{:.4},"p95_ms":{:.4},"visited_pairs":{},"final_hash":"{:08x}","mass_error":{}}}"#,
        millis_at(50),
        millis_at(95),
        outcome.visited_pairs,
        outcome.hash,
        outcome.mass_error
    )
}

fn main() {
    let mut durations = [Vec::with_capacity(SAMPLES), Vec::with_capacity(SAMPLES)];
    let mut expected = [None, None];
    for pair in 0..WARMUPS + SAMPLES {
        let sparse_first = pair % 2 == 0;
        for dense in [!sparse_first, sparse_first] {
            let solver = usize::from(dense);
            let (elapsed, outcome) = replay(dense);
            if let Some(reference) = &expected[solver] {
                assert_eq!(&outcome, reference, "solver diverged across repetitions");
            } else {
                expected[solver] = Some(outcome);
            }
            if pair >= WARMUPS {
                durations[solver].push(elapsed);
            }
        }
    }
    let [sparse, dense] = expected.map(Option::unwrap);
    assert_eq!(
        sparse.hash, dense.hash,
        "sparse and dense final states differ"
    );
    let sparse_stats = describe(&mut durations[0], &sparse);
    let dense_stats = describe(&mut durations[1], &dense);
    println!(
        concat!(
            r#"{{"platform":"{}-{}","solver_grid":[{},{}],"ticks_per_replay":{},"#,
            r#""warmups_per_solver":{},"samples_per_solver":{},"order":"alternating paired","#,
            r#""timer_scope":"replay loop","quantile":"nearest rank","sparse":{},"dense":{}}}"#
        ),
        std::env::consts::OS,
        std::env::consts::ARCH,
        N,
        N,
        TICKS,
        WARMUPS,
        SAMPLES,
        sparse_stats,
        dense_stats
    );
}
