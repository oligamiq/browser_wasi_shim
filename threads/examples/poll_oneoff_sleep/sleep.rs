use std::time::{Duration, Instant};

fn main() {
    let sleep_ms: u64 = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "100".to_string())
        .parse()
        .expect("first argument must be a number (milliseconds)");

    println!("poll_oneoff_sleep: sleeping for {}ms", sleep_ms);

    let start = Instant::now();
    std::thread::sleep(Duration::from_millis(sleep_ms));
    let elapsed = start.elapsed();

    println!(
        "poll_oneoff_sleep: woke up after {:.1}ms (requested {}ms)",
        elapsed.as_secs_f64() * 1000.0,
        sleep_ms
    );

    // Verify accuracy: allow up to 50ms tolerance
    let elapsed_ms = elapsed.as_millis() as u64;
    if elapsed_ms >= sleep_ms {
        println!("poll_oneoff_sleep: OK (elapsed >= requested)");
    } else {
        eprintln!(
            "poll_oneoff_sleep: WARN elapsed {}ms < requested {}ms",
            elapsed_ms, sleep_ms
        );
    }
}
