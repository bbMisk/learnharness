use fsrs::{FSRS, MemoryState};
use serde::Deserialize;

#[derive(Deserialize)]
struct MemoryInput { stability: f32, difficulty: f32 }

#[derive(Deserialize)]
struct Input { memory: Option<MemoryInput>, days: u32, retention: f32 }

fn schedule(input: &[u8]) -> Result<fsrs::NextStates, String> {
    let input: Input = serde_json::from_slice(input).map_err(|e| e.to_string())?;
    if !(0.0 < input.retention && input.retention < 1.0) || input.days > 365_000 {
        return Err("Invalid retention or elapsed days".into());
    }
    let memory = input.memory.map(|m| MemoryState { stability: m.stability, difficulty: m.difficulty });
    if memory.is_some_and(|m| !m.stability.is_finite() || m.stability <= 0.0 || !(1.0..=10.0).contains(&m.difficulty)) {
        return Err("Invalid memory state".into());
    }
    FSRS::default().next_states(memory, input.retention, input.days).map_err(|e| e.to_string())
}

pub fn next_json(input: &[u8]) -> String {
    match schedule(input) {
        Ok(states) => serde_json::json!({"ok": states}),
        Err(error) => serde_json::json!({"error": error}),
    }.to_string()
}

/// Small JSON ABI, shared unchanged by Node and the browser. Scheduling needs no RNG.
#[unsafe(no_mangle)]
pub extern "C" fn lh_alloc(len: usize) -> *mut u8 {
    Box::into_raw(vec![0_u8; len].into_boxed_slice()) as *mut u8
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn lh_free(ptr: *mut u8, len: usize) {
    unsafe { drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len))); }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn lh_next(ptr: *const u8, len: usize) -> u64 {
    let output = next_json(unsafe { std::slice::from_raw_parts(ptr, len) }).into_bytes().into_boxed_slice();
    let len = output.len();
    let ptr = Box::into_raw(output) as *mut u8;
    ((ptr as u64) << 32) | len as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_default_new_card_states() {
        let value: serde_json::Value = serde_json::from_str(&next_json(br#"{"days":0,"retention":0.9}"#)).unwrap();
        assert!((value["ok"]["good"]["memory"]["stability"].as_f64().unwrap() - 2.3065).abs() < 0.000001);
        assert_eq!(value["ok"]["easy"]["memory"]["difficulty"], 1.0);
        assert_eq!(value["ok"].as_object().unwrap().len(), 4);
    }

    #[test]
    fn malformed_input_is_a_reported_error_not_a_panic() {
        for input in [br#"{"days":0,"retention":0}"#.as_slice(), br#"{"memory":{"stability":-1,"difficulty":5},"days":1,"retention":0.9}"#, b"not json"] {
            let value: serde_json::Value = serde_json::from_str(&next_json(input)).unwrap();
            assert!(value["error"].is_string());
        }
    }
}
