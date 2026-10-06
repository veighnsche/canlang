//! V03.2 ordered input transport arena vectors (decision rows D1–D8).
//!
//! Frames below mirror host `JSON.parse` outcomes bit-for-bit; the arena
//! never parses text. Each test names the `cases.json` row it pins.

use values_semantics::input::{
    json_admissible_tags, Budgets, Frame, InputArena, MintedTag, TransportNode, MAX_ID_LENGTH_UNITS,
};

fn generous() -> Budgets {
    Budgets {
        max_nodes: 10_000,
        max_depth: 100,
        max_text_units: 10_000,
        max_entries: 1_000,
    }
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn root_of(arena: &InputArena) -> &TransportNode {
    let root = arena.root();
    arena.node(root)
}

#[test]
fn f64_bits_stay_distinct() {
    // f64/neg-zero-distinct, pos-zero-contrast, huge-rounded-integer,
    // one-tenth-bits, 1e400-infinity.
    for bits in [
        0x8000_0000_0000_0000u64, // -0
        0x0000_0000_0000_0000u64, // +0
        0x4340_0000_0000_0000u64, // 9007199254740993 rounded
        0x3FB9_9999_9999_999Au64, // 0.1
        0x7FF0_0000_0000_0000u64, // 1e400 Infinity
    ] {
        let arena = InputArena::build(&Frame::F64Bits(bits), &generous()).unwrap();
        assert_eq!(root_of(&arena), &TransportNode::F64 { bits });
    }
    assert_ne!(0x8000_0000_0000_0000u64, 0x0000_0000_0000_0000u64);
}

#[test]
fn nan_bits_are_a_corrupt_frame() {
    let err = InputArena::build(&Frame::F64Bits(f64::NAN.to_bits()), &generous()).unwrap_err();
    assert_eq!(err.stage(), "transport");
    assert_eq!(err.code, "corrupt/nan-bits");
}

#[test]
fn text_crosses_as_lossless_units() {
    // text/lone-surrogate-preserved, surrogate-pair-control,
    // controls-are-data, empty-vs-missing, empty-text-ok.
    let lone = InputArena::build(&Frame::TextUnits(vec![0xD800]), &generous()).unwrap();
    assert_eq!(
        root_of(&lone),
        &TransportNode::Text {
            units: vec![0xD800]
        }
    );
    let pair = InputArena::build(&Frame::TextUnits(vec![0xD83D, 0xDE00]), &generous()).unwrap();
    assert_eq!(
        root_of(&pair),
        &TransportNode::Text {
            units: vec![0xD83D, 0xDE00]
        }
    );
    let controls = InputArena::build(&Frame::TextUnits(units("ab")), &generous()).unwrap();
    assert_eq!(
        root_of(&controls),
        &TransportNode::Text {
            units: units("ab")
        }
    );
    let empty = InputArena::build(&Frame::TextUnits(vec![]), &generous()).unwrap();
    assert_eq!(root_of(&empty), &TransportNode::Text { units: vec![] });
}

#[test]
fn entries_keep_order_duplicates_and_proto() {
    // keys/duplicates-preserved, own-proto-is-data, insertion-order,
    // integer-like-order, lone-surrogate-key, numeric-string-key-order.
    let frame = Frame::Entries(vec![
        (units("b"), Frame::F64Bits(1.0_f64.to_bits())),
        (units("a"), Frame::F64Bits(2.0_f64.to_bits())),
        (units("b"), Frame::F64Bits(3.0_f64.to_bits())),
        (units("__proto__"), Frame::OwnNull),
        (vec![0xD800], Frame::Bool(true)),
    ]);
    let arena = InputArena::build(&frame, &generous()).unwrap();
    let TransportNode::Entries { entries } = root_of(&arena) else {
        panic!("entries root");
    };
    let keys: Vec<Vec<u16>> = entries.iter().map(|e| e.key.clone()).collect();
    assert_eq!(
        keys,
        vec![
            units("b"),
            units("a"),
            units("b"),
            units("__proto__"),
            vec![0xD800]
        ]
    );
    // Duplicate values stay distinct positions.
    let first = arena.node(entries[0].node);
    let third = arena.node(entries[2].node);
    assert_eq!(
        first,
        &TransportNode::F64 {
            bits: 1.0_f64.to_bits()
        }
    );
    assert_eq!(
        third,
        &TransportNode::F64 {
            bits: 3.0_f64.to_bits()
        }
    );
}

#[test]
fn arrays_keep_order_and_own_nulls() {
    // kinds/array-mixed, bool-true, empty-object.
    let frame = Frame::Array(vec![
        Frame::F64Bits(1.0_f64.to_bits()),
        Frame::TextUnits(units("a")),
        Frame::OwnNull,
        Frame::Bool(false),
    ]);
    let arena = InputArena::build(&frame, &generous()).unwrap();
    let TransportNode::Array { items } = root_of(&arena) else {
        panic!("array root");
    };
    assert_eq!(items.len(), 4);
    assert_eq!(arena.node(items[2]), &TransportNode::OwnNull);
    let truthy = InputArena::build(&Frame::Bool(true), &generous()).unwrap();
    assert_eq!(root_of(&truthy), &TransportNode::Bool(true));
}

#[test]
fn missing_and_null_are_distinct_positions() {
    // presence/missing-vs-null, explicit-null-preserved.
    let frame = Frame::Entries(vec![
        (units("a"), Frame::OwnNull),
        (units("b"), Frame::Missing),
    ]);
    let arena = InputArena::build(&frame, &generous()).unwrap();
    let TransportNode::Entries { entries } = root_of(&arena) else {
        panic!("entries root");
    };
    assert_eq!(arena.node(entries[0].node), &TransportNode::OwnNull);
    assert_eq!(arena.node(entries[1].node), &TransportNode::Missing);
}

#[test]
fn lineage_tags_are_unrepresentable_from_json() {
    // presence/undefined-never-from-json, inherited-never-from-json,
    // accessor-never-from-json (exclusion rows: must-hold).
    let tags = json_admissible_tags();
    assert!(!tags.contains(&"own-undefined"));
    assert!(!tags.contains(&"inherited"));
    assert!(!tags.contains(&"accessor"));
    assert_eq!(tags.len(), 7);
}

#[test]
fn id_length_uses_the_pinned_unit_bound() {
    // length/id-256-units-ok, id-257-units-rejects.
    assert_eq!(MAX_ID_LENGTH_UNITS, 256);
    // A surrogate pair counts 2 units, like JS `.length`.
    let mut ok = vec![0x0061u16; 254];
    ok.extend([0xD83D, 0xDE00]);
    assert_eq!(ok.len(), 256);
    assert!(InputArena::check_id_length(&ok).is_ok());
    let mut over = ok.clone();
    over.push(0x0061);
    let err = InputArena::check_id_length(&over).unwrap_err();
    assert_eq!(err.stage(), "transport");
    assert_eq!(err.code, "length/id");
}

#[test]
fn counts_reject_before_any_node_exists() {
    // length/node-count-before-traverse, depth-before-descent,
    // exclusion/no-coerce-then-check (must-hold: Err carries no arena).
    let deep = Frame::Array(vec![Frame::Array(vec![Frame::Bool(true)])]);
    let shallow = Budgets {
        max_depth: 1,
        ..generous()
    };
    let err = InputArena::build(&deep, &shallow).unwrap_err();
    assert_eq!((err.stage(), err.code), ("transport", "length/depth"));
    let tiny = Budgets {
        max_nodes: 2,
        ..generous()
    };
    let err = InputArena::build(&deep, &tiny).unwrap_err();
    assert_eq!((err.stage(), err.code), ("transport", "length/nodes"));
    let narrow = Budgets {
        max_text_units: 1,
        ..generous()
    };
    let err = InputArena::build(&Frame::TextUnits(units("ab")), &narrow).unwrap_err();
    assert_eq!((err.stage(), err.code), ("transport", "length/text"));
    let few = Budgets {
        max_entries: 1,
        ..generous()
    };
    let frame = Frame::Entries(vec![
        (units("a"), Frame::Bool(true)),
        (units("b"), Frame::Bool(false)),
    ]);
    let err = InputArena::build(&frame, &few).unwrap_err();
    assert_eq!((err.stage(), err.code), ("transport", "length/entries"));
}

#[test]
fn minted_tags_carry_identity_and_paths() {
    // tags/default-applied-carries-identity, default-absent-when-present,
    // update-omitted-minted, dropped-unknown-with-path.
    let mut arena = InputArena::build(&Frame::Missing, &generous()).unwrap();
    let value = arena.root();
    let filled = arena.mint_tag(
        MintedTag::DefaultApplied {
            registry: "owner-defaults".to_string(),
            plan_rev: "artifact-1".to_string(),
        },
        value,
    );
    assert_eq!(
        arena.node(filled),
        &TransportNode::Tagged {
            tag: MintedTag::DefaultApplied {
                registry: "owner-defaults".to_string(),
                plan_rev: "artifact-1".to_string(),
            },
            value,
        }
    );
    let absent = arena.mint_tag(MintedTag::DefaultAbsent, value);
    assert!(matches!(arena.node(absent), TransportNode::Tagged { .. }));
    let omitted = arena.mint_tag(MintedTag::UpdateOmitted, value);
    assert!(matches!(arena.node(omitted), TransportNode::Tagged { .. }));
    let dropped = arena.mint_tag(
        MintedTag::DroppedUnknown {
            path: vec![units("a"), units("b")],
        },
        value,
    );
    let TransportNode::Tagged { tag, .. } = arena.node(dropped) else {
        panic!("tagged drop");
    };
    assert_eq!(
        tag,
        &MintedTag::DroppedUnknown {
            path: vec![units("a"), units("b")],
        }
    );
    // tags/drop-never-known is a profile rule (drops apply only to
    // unknown positions); the arena mints what profiles decide.
}

#[test]
fn forged_sentinel_shapes_stay_data() {
    // tags/forged-sentinel-is-data, exclusion/opaque-json-never-transport.
    let frame = Frame::Entries(vec![
        (units("$sentinel"), Frame::TextUnits(units("x"))),
        (units("$omitted"), Frame::Bool(true)),
    ]);
    let arena = InputArena::build(&frame, &generous()).unwrap();
    let TransportNode::Entries { entries } = root_of(&arena) else {
        panic!("entries root");
    };
    assert_eq!(entries.len(), 2);
    for entry in entries {
        assert!(!matches!(
            arena.node(entry.node),
            TransportNode::Tagged { .. }
        ));
    }
}
