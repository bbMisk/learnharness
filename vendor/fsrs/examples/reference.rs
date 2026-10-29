use fsrs::{FSRS, MemoryState};

fn main() {
    let cases = [
        (None, 0.9, 0),
        (Some(MemoryState { stability: 2.3065, difficulty: 2.118103 }), 0.9, 0),
        (Some(MemoryState { stability: 10.0, difficulty: 5.0 }), 0.9, 10),
        (Some(MemoryState { stability: 50.0, difficulty: 7.0 }), 0.9, 80),
        (Some(MemoryState { stability: 25.0, difficulty: 3.0 }), 0.95, 5),
    ];
    let fsrs = FSRS::default();
    let values: Vec<_> = cases.into_iter().map(|(memory, retention, days)| serde_json::json!({
        "input": {"memory": memory, "retention": retention, "days": days},
        "expected": fsrs.next_states(memory, retention, days).unwrap(),
    })).collect();
    println!("{}", serde_json::to_string_pretty(&values).unwrap());
}
