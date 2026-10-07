#![allow(dead_code)]
mod diagnostic {
    pub fn push_json_str(out: &mut String, value: &str) {
        out.push_str(&serde_json::to_string(value).unwrap());
    }
}
mod old;
mod new;
use std::{hint::black_box, time::Instant};

fn measure(engine: &str, text: &str, repetitions: usize) -> f64 {
    let start = Instant::now();
    match engine {
        "old" => for _ in 0..repetitions { drop(black_box(old::parse(black_box(text)).unwrap())); },
        "new" => for _ in 0..repetitions { drop(black_box(new::parse(black_box(text)).unwrap())); },
        _ => unreachable!(),
    }
    start.elapsed().as_secs_f64() * 1e6 / repetitions as f64
}

fn main() {
    let catalog = include_str!("../catalog.json").to_string();
    let small = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"processId":null,"rootUri":null,"capabilities":{}}}"#.to_string();
    let row = r#"{"id":-0,"n":123456789012345678901234567890.1200e+300,"s":"éあ😀\ntext 1e999","a":[true,false,null,1e999999999999999999999],"o":{"x":1,"x":2}}"#;
    let make = |count| format!("[{}]", vec![row; count].join(","));
    let inputs = [("actual_catalog", catalog, 1000), ("initialize", small, 10000), ("mixed_360k", make(2500), 25), ("mixed_multimb", make(15000), 5)];
    let mut results = Vec::new();
    for (name, text, repetitions) in inputs {
        // Warm both parsers on the same bytes before timing alternating rounds.
        for _ in 0..2 { measure("old", &text, repetitions); measure("new", &text, repetitions); }
        let mut old_times = Vec::new(); let mut new_times = Vec::new();
        for round in 0..7 {
            let order = if round % 2 == 0 { ["old", "new"] } else { ["new", "old"] };
            for engine in order {
                let micros = measure(engine, &text, repetitions);
                if engine == "old" { old_times.push(micros); } else { new_times.push(micros); }
            }
        }
        let median = |times: &[f64]| { let mut sorted=times.to_vec(); sorted.sort_by(f64::total_cmp); sorted[sorted.len()/2] };
        let old_median=median(&old_times); let new_median=median(&new_times);
        results.push(serde_json::json!({"name":name,"input_bytes":text.len(),"repetitions_per_round":repetitions,"warmup_rounds_per_engine":2,"rounds":7,"old_microseconds_per_parse":old_times,"new_microseconds_per_parse":new_times,"old_median_microseconds":old_median,"new_median_microseconds":new_median,"new_over_old":new_median/old_median}));
    }
    println!("{}", serde_json::to_string_pretty(&serde_json::json!({"method":"release parse+drop, black_box input and result, alternating engine order, 2 warmup rounds each, 7 measured rounds; shim never measured/output-qualified", "results":results})).unwrap());
}
