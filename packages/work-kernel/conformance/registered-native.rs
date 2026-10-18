// Registered N03 witnesses: mechanical grouping of immutable native-numeric-text.rs.
// Source SHA-256: add8194c697abfb55e3fb0671bb67471733d6b126db66ad43548d9a97606ac64
// Expected values and supplied raw bits are retained, never regenerated.
// caller_34 keeps the same successful unwrap; its tautological unit binding
// and assertion were removed to satisfy Clippy.
#[test]
fn immutable_primitive_corpus() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/numeric-text.json")).unwrap();
    let cases = fixture["numbers"].as_array().unwrap();
    assert_eq!(cases.len(), 10213);
    for case in cases {
        let bits = u64::from_str_radix(case["inputBits"].as_str().unwrap(), 16).unwrap();
        let n = f64::from_bits(bits);
        assert_eq!(
            crate::decisions::numeric_text::string(n),
            case["stringText"].as_str().unwrap(),
            "String bits={bits:016x}"
        );
        assert_eq!(
            crate::decisions::numeric_text::json_token(n),
            case["jsonTokenText"].as_str().unwrap(),
            "JSON bits={bits:016x}"
        );
        assert_eq!(n.to_bits(), bits);
    }
}
mod rows {
    use crate::decisions::rows::*;
    use std::rc::Rc;
    #[test]
    fn caller_0() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Str(U16::from_utf8("model")),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x4415af1d78b58c40)),
                    ),
                ])),
            },
            Direction::Work,
        )
        .unwrap_err();
        assert_eq!(error.name, "KernelTableError");
        assert_eq!(
            error.message,
            "work.fanout_intent.memberCount 100000000000000000000 mismatches members length 2."
        );
        assert_eq!(error.code, None);
    }
    #[test]
    fn caller_1() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Num(f64::from_bits(0x7ff8000000000000)),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x4415af1d78b58c40)),
                    ),
                ])),
            },
            Direction::Work,
        )
        .unwrap_err();
        assert_eq!(error.name, "KernelTableError");
        assert_eq!(
            error.message,
            "fanout cohort must be model or anchored-collection, got null."
        );
        assert_eq!(error.code, None);
    }
    #[test]
    fn caller_2() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Str(U16::from_utf8("model")),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x444b1ae4d6e2ef50)),
                    ),
                ])),
            },
            Direction::Work,
        )
        .unwrap_err();
        assert_eq!(error.name, "KernelTableError");
        assert_eq!(
            error.message,
            "work.fanout_intent.memberCount 1e+21 mismatches members length 2."
        );
        assert_eq!(error.code, None);
    }
    #[test]
    fn caller_3() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Num(f64::from_bits(0x7ff8000000000000)),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x444b1ae4d6e2ef50)),
                    ),
                ])),
            },
            Direction::Work,
        )
        .unwrap_err();
        assert_eq!(error.name, "KernelTableError");
        assert_eq!(
            error.message,
            "fanout cohort must be model or anchored-collection, got null."
        );
        assert_eq!(error.code, None);
    }
    #[test]
    fn caller_4() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Str(U16::from_utf8("model")),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x43e0000000000000)),
                    ),
                ])),
            },
            Direction::Work,
        )
        .unwrap_err();
        assert_eq!(error.name, "KernelTableError");
        assert_eq!(
            error.message,
            "work.fanout_intent.memberCount 9223372036854776000 mismatches members length 2."
        );
        assert_eq!(error.code, None);
    }
    #[test]
    fn caller_5() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Num(f64::from_bits(0x7ff8000000000000)),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x43e0000000000000)),
                    ),
                ])),
            },
            Direction::Work,
        )
        .unwrap_err();
        assert_eq!(error.name, "KernelTableError");
        assert_eq!(
            error.message,
            "fanout cohort must be model or anchored-collection, got null."
        );
        assert_eq!(error.code, None);
    }
    #[test]
    fn caller_6() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Num(f64::from_bits(0x4415af1d78b58c40)),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x4000000000000000)),
                    ),
                ])),
            },
            Direction::Work,
        )
        .unwrap_err();
        assert_eq!(error.name, "KernelTableError");
        assert_eq!(
            error.message,
            "fanout cohort must be model or anchored-collection, got 100000000000000000000."
        );
        assert_eq!(error.code, None);
    }
    #[test]
    fn caller_7() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Num(f64::from_bits(0xc415af1d78b58c40)),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x4000000000000000)),
                    ),
                ])),
            },
            Direction::Work,
        )
        .unwrap_err();
        assert_eq!(error.name, "KernelTableError");
        assert_eq!(
            error.message,
            "fanout cohort must be model or anchored-collection, got -100000000000000000000."
        );
        assert_eq!(error.code, None);
    }
    #[test]
    fn caller_8() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Num(f64::from_bits(0x7ff8000000000000)),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x4000000000000000)),
                    ),
                ])),
            },
            Direction::Work,
        )
        .unwrap_err();
        assert_eq!(error.name, "KernelTableError");
        assert_eq!(
            error.message,
            "fanout cohort must be model or anchored-collection, got null."
        );
        assert_eq!(error.code, None);
    }
    #[test]
    fn caller_9() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Num(f64::from_bits(0x7ff0000000000000)),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x4000000000000000)),
                    ),
                ])),
            },
            Direction::Work,
        )
        .unwrap_err();
        assert_eq!(error.name, "KernelTableError");
        assert_eq!(
            error.message,
            "fanout cohort must be model or anchored-collection, got null."
        );
        assert_eq!(error.code, None);
    }
    #[test]
    fn caller_10() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Num(f64::from_bits(0xfff0000000000000)),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x4000000000000000)),
                    ),
                ])),
            },
            Direction::Work,
        )
        .unwrap_err();
        assert_eq!(error.name, "KernelTableError");
        assert_eq!(
            error.message,
            "fanout cohort must be model or anchored-collection, got null."
        );
        assert_eq!(error.code, None);
    }
    #[test]
    fn caller_11() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Num(f64::from_bits(0x3e7ad7f29abcaf48)),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x4000000000000000)),
                    ),
                ])),
            },
            Direction::Work,
        )
        .unwrap_err();
        assert_eq!(error.name, "KernelTableError");
        assert_eq!(
            error.message,
            "fanout cohort must be model or anchored-collection, got 1e-7."
        );
        assert_eq!(error.code, None);
    }
    #[test]
    fn caller_12() {
        let error = fanout_child_page_result(
            &[
                StoredRow {
                    id: U16::from_utf8("a"),
                    version: f64::from_bits(0x3ff0000000000000),
                    created: f64::from_bits(0x4279254d38000000),
                    updated: f64::from_bits(0x4279254d38000000),
                    created_by: U16::from_utf8("w02.2-freeze"),
                    updated_by: U16::from_utf8("w02.2-freeze"),
                    archived_at: Value::Null,
                    parent: Value::Null,
                    data: Value::Obj(Rc::new(vec![])),
                },
                StoredRow {
                    id: U16::from_utf8("b"),
                    version: f64::from_bits(0x3ff0000000000000),
                    created: f64::from_bits(0x4279254d38000000),
                    updated: f64::from_bits(0x4279254d38000000),
                    created_by: U16::from_utf8("w02.2-freeze"),
                    updated_by: U16::from_utf8("w02.2-freeze"),
                    archived_at: Value::Null,
                    parent: Value::Null,
                    data: Value::Obj(Rc::new(vec![])),
                },
                StoredRow {
                    id: U16::from_utf8("c"),
                    version: f64::from_bits(0x3ff0000000000000),
                    created: f64::from_bits(0x4279254d38000000),
                    updated: f64::from_bits(0x4279254d38000000),
                    created_by: U16::from_utf8("w02.2-freeze"),
                    updated_by: U16::from_utf8("w02.2-freeze"),
                    archived_at: Value::Null,
                    parent: Value::Null,
                    data: Value::Obj(Rc::new(vec![])),
                },
            ],
            f64::from_bits(0x4000000000000000),
            Direction::Work,
        )
        .unwrap_err();
        assert_eq!(error.name, "KernelTableError");
        assert_eq!(error.message, "fanout page returned 3 rows past limit 2.");
        assert_eq!(error.code, None);
    }
    #[test]
    fn caller_13() {
        let result = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Str(U16::from_utf8("model")),
                    ),
                    (U16::from_utf8("members"), Value::Arr(Rc::new(vec![]))),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x8000000000000000)),
                    ),
                ])),
            },
            Direction::Work,
        )
        .unwrap();
        assert_eq!(result.member_count.to_bits(), 0x8000000000000000);
    }
    #[test]
    fn caller_14() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Str(U16::from_utf8("model")),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x4415af1d78b58c40)),
                    ),
                ])),
            },
            Direction::State,
        )
        .unwrap_err();
        assert_eq!(error.name, "StateError");
        assert_eq!(
            error.message,
            "work.fanout_intent.memberCount 100000000000000000000 mismatches members length 2."
        );
        assert_eq!(error.code, Some("validation".to_owned()));
    }
    #[test]
    fn caller_15() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Num(f64::from_bits(0x7ff8000000000000)),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x4415af1d78b58c40)),
                    ),
                ])),
            },
            Direction::State,
        )
        .unwrap_err();
        assert_eq!(error.name, "StateError");
        assert_eq!(
            error.message,
            "Fanout cohort must be model or anchored-collection, got null."
        );
        assert_eq!(error.code, Some("validation".to_owned()));
    }
    #[test]
    fn caller_16() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Str(U16::from_utf8("model")),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x444b1ae4d6e2ef50)),
                    ),
                ])),
            },
            Direction::State,
        )
        .unwrap_err();
        assert_eq!(error.name, "StateError");
        assert_eq!(
            error.message,
            "work.fanout_intent.memberCount 1e+21 mismatches members length 2."
        );
        assert_eq!(error.code, Some("validation".to_owned()));
    }
    #[test]
    fn caller_17() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Num(f64::from_bits(0x7ff8000000000000)),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x444b1ae4d6e2ef50)),
                    ),
                ])),
            },
            Direction::State,
        )
        .unwrap_err();
        assert_eq!(error.name, "StateError");
        assert_eq!(
            error.message,
            "Fanout cohort must be model or anchored-collection, got null."
        );
        assert_eq!(error.code, Some("validation".to_owned()));
    }
    #[test]
    fn caller_18() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Str(U16::from_utf8("model")),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x43e0000000000000)),
                    ),
                ])),
            },
            Direction::State,
        )
        .unwrap_err();
        assert_eq!(error.name, "StateError");
        assert_eq!(
            error.message,
            "work.fanout_intent.memberCount 9223372036854776000 mismatches members length 2."
        );
        assert_eq!(error.code, Some("validation".to_owned()));
    }
    #[test]
    fn caller_19() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Num(f64::from_bits(0x7ff8000000000000)),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x43e0000000000000)),
                    ),
                ])),
            },
            Direction::State,
        )
        .unwrap_err();
        assert_eq!(error.name, "StateError");
        assert_eq!(
            error.message,
            "Fanout cohort must be model or anchored-collection, got null."
        );
        assert_eq!(error.code, Some("validation".to_owned()));
    }
    #[test]
    fn caller_20() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Num(f64::from_bits(0x4415af1d78b58c40)),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x4000000000000000)),
                    ),
                ])),
            },
            Direction::State,
        )
        .unwrap_err();
        assert_eq!(error.name, "StateError");
        assert_eq!(
            error.message,
            "Fanout cohort must be model or anchored-collection, got 100000000000000000000."
        );
        assert_eq!(error.code, Some("validation".to_owned()));
    }
    #[test]
    fn caller_21() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Num(f64::from_bits(0xc415af1d78b58c40)),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x4000000000000000)),
                    ),
                ])),
            },
            Direction::State,
        )
        .unwrap_err();
        assert_eq!(error.name, "StateError");
        assert_eq!(
            error.message,
            "Fanout cohort must be model or anchored-collection, got -100000000000000000000."
        );
        assert_eq!(error.code, Some("validation".to_owned()));
    }
    #[test]
    fn caller_22() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Num(f64::from_bits(0x7ff8000000000000)),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x4000000000000000)),
                    ),
                ])),
            },
            Direction::State,
        )
        .unwrap_err();
        assert_eq!(error.name, "StateError");
        assert_eq!(
            error.message,
            "Fanout cohort must be model or anchored-collection, got null."
        );
        assert_eq!(error.code, Some("validation".to_owned()));
    }
    #[test]
    fn caller_23() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Num(f64::from_bits(0x7ff0000000000000)),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x4000000000000000)),
                    ),
                ])),
            },
            Direction::State,
        )
        .unwrap_err();
        assert_eq!(error.name, "StateError");
        assert_eq!(
            error.message,
            "Fanout cohort must be model or anchored-collection, got null."
        );
        assert_eq!(error.code, Some("validation".to_owned()));
    }
    #[test]
    fn caller_24() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Num(f64::from_bits(0xfff0000000000000)),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x4000000000000000)),
                    ),
                ])),
            },
            Direction::State,
        )
        .unwrap_err();
        assert_eq!(error.name, "StateError");
        assert_eq!(
            error.message,
            "Fanout cohort must be model or anchored-collection, got null."
        );
        assert_eq!(error.code, Some("validation".to_owned()));
    }
    #[test]
    fn caller_25() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Num(f64::from_bits(0x3e7ad7f29abcaf48)),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x4000000000000000)),
                    ),
                ])),
            },
            Direction::State,
        )
        .unwrap_err();
        assert_eq!(error.name, "StateError");
        assert_eq!(
            error.message,
            "Fanout cohort must be model or anchored-collection, got 1e-7."
        );
        assert_eq!(error.code, Some("validation".to_owned()));
    }
    #[test]
    fn caller_26() {
        let error = fanout_child_page_result(
            &[
                StoredRow {
                    id: U16::from_utf8("a"),
                    version: f64::from_bits(0x3ff0000000000000),
                    created: f64::from_bits(0x4279254d38000000),
                    updated: f64::from_bits(0x4279254d38000000),
                    created_by: U16::from_utf8("w02.2-freeze"),
                    updated_by: U16::from_utf8("w02.2-freeze"),
                    archived_at: Value::Null,
                    parent: Value::Null,
                    data: Value::Obj(Rc::new(vec![])),
                },
                StoredRow {
                    id: U16::from_utf8("b"),
                    version: f64::from_bits(0x3ff0000000000000),
                    created: f64::from_bits(0x4279254d38000000),
                    updated: f64::from_bits(0x4279254d38000000),
                    created_by: U16::from_utf8("w02.2-freeze"),
                    updated_by: U16::from_utf8("w02.2-freeze"),
                    archived_at: Value::Null,
                    parent: Value::Null,
                    data: Value::Obj(Rc::new(vec![])),
                },
                StoredRow {
                    id: U16::from_utf8("c"),
                    version: f64::from_bits(0x3ff0000000000000),
                    created: f64::from_bits(0x4279254d38000000),
                    updated: f64::from_bits(0x4279254d38000000),
                    created_by: U16::from_utf8("w02.2-freeze"),
                    updated_by: U16::from_utf8("w02.2-freeze"),
                    archived_at: Value::Null,
                    parent: Value::Null,
                    data: Value::Obj(Rc::new(vec![])),
                },
            ],
            f64::from_bits(0x4000000000000000),
            Direction::State,
        )
        .unwrap_err();
        assert_eq!(error.name, "StateError");
        assert_eq!(error.message, "Fanout page returned 3 rows past limit 2.");
        assert_eq!(error.code, Some("validation".to_owned()));
    }
    #[test]
    fn caller_27() {
        let result = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Str(U16::from_utf8("model")),
                    ),
                    (U16::from_utf8("members"), Value::Arr(Rc::new(vec![]))),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x8000000000000000)),
                    ),
                ])),
            },
            Direction::State,
        )
        .unwrap();
        assert_eq!(result.member_count.to_bits(), 0x8000000000000000);
    }
    #[test]
    fn caller_52() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Num(f64::from_bits(0x4415af1d78b58c40)),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x4000000000000000)),
                    ),
                ])),
            },
            Direction::Work,
        )
        .unwrap_err();
        assert_eq!(error.name, "KernelTableError");
        assert_eq!(
            error.message,
            "fanout cohort must be model or anchored-collection, got 100000000000000000000."
        );
        assert_eq!(error.code, None);
    }
    #[test]
    fn caller_53() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Num(f64::from_bits(0x4415af1d78b58c40)),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x4000000000000000)),
                    ),
                ])),
            },
            Direction::State,
        )
        .unwrap_err();
        assert_eq!(error.name, "StateError");
        assert_eq!(
            error.message,
            "Fanout cohort must be model or anchored-collection, got 100000000000000000000."
        );
        assert_eq!(error.code, Some("validation".to_owned()));
    }
    #[test]
    fn caller_56() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Num(f64::from_bits(0x7ff8000000000000)),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x4000000000000000)),
                    ),
                ])),
            },
            Direction::Work,
        )
        .unwrap_err();
        assert_eq!(error.name, "KernelTableError");
        assert_eq!(
            error.message,
            "fanout cohort must be model or anchored-collection, got null."
        );
        assert_eq!(error.code, None);
    }
    #[test]
    fn caller_57() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Num(f64::from_bits(0x7ff8000000000000)),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x4000000000000000)),
                    ),
                ])),
            },
            Direction::State,
        )
        .unwrap_err();
        assert_eq!(error.name, "StateError");
        assert_eq!(
            error.message,
            "Fanout cohort must be model or anchored-collection, got null."
        );
        assert_eq!(error.code, Some("validation".to_owned()));
    }
    #[test]
    fn caller_60() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Num(f64::from_bits(0x7ff0000000000000)),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x4000000000000000)),
                    ),
                ])),
            },
            Direction::Work,
        )
        .unwrap_err();
        assert_eq!(error.name, "KernelTableError");
        assert_eq!(
            error.message,
            "fanout cohort must be model or anchored-collection, got null."
        );
        assert_eq!(error.code, None);
    }
    #[test]
    fn caller_61() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Num(f64::from_bits(0x7ff0000000000000)),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x4000000000000000)),
                    ),
                ])),
            },
            Direction::State,
        )
        .unwrap_err();
        assert_eq!(error.name, "StateError");
        assert_eq!(
            error.message,
            "Fanout cohort must be model or anchored-collection, got null."
        );
        assert_eq!(error.code, Some("validation".to_owned()));
    }
    #[test]
    fn caller_64() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Num(f64::from_bits(0xfff0000000000000)),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x4000000000000000)),
                    ),
                ])),
            },
            Direction::Work,
        )
        .unwrap_err();
        assert_eq!(error.name, "KernelTableError");
        assert_eq!(
            error.message,
            "fanout cohort must be model or anchored-collection, got null."
        );
        assert_eq!(error.code, None);
    }
    #[test]
    fn caller_65() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Num(f64::from_bits(0xfff0000000000000)),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x4000000000000000)),
                    ),
                ])),
            },
            Direction::State,
        )
        .unwrap_err();
        assert_eq!(error.name, "StateError");
        assert_eq!(
            error.message,
            "Fanout cohort must be model or anchored-collection, got null."
        );
        assert_eq!(error.code, Some("validation".to_owned()));
    }
    #[test]
    fn caller_68() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("1"),
                                Value::Num(f64::from_bits(0x7ff0000000000000)),
                            ),
                            (
                                U16::from_utf8("2"),
                                Value::Num(f64::from_bits(0xc415af1d78b58c40)),
                            ),
                            (
                                U16::from_utf8("z"),
                                Value::Arr(Rc::new(vec![
                                    Value::Num(f64::from_bits(0x4415af1d78b58c40)),
                                    Value::Num(f64::from_bits(0x7ff8000000000000)),
                                ])),
                            ),
                        ])),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x4000000000000000)),
                    ),
                ])),
            },
            Direction::Work,
        )
        .unwrap_err();
        assert_eq!(error.name, "KernelTableError");
        assert_eq!(error.message,"fanout cohort must be model or anchored-collection, got {\"1\":null,\"2\":-100000000000000000000,\"z\":[100000000000000000000,null]}.");
        assert_eq!(error.code, None);
    }
    #[test]
    fn caller_69() {
        let error = read_fanout_intent_row(
            &StoredRow {
                id: U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x4279254d38000000),
                updated: f64::from_bits(0x4279254d38000000),
                created_by: U16::from_utf8("w02.2-freeze"),
                updated_by: U16::from_utf8("w02.2-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("fanoutId"),
                        Value::Str(U16::from_utf8("fanout/v1/occ-5/h%2Fcommit/model")),
                    ),
                    (
                        U16::from_utf8("sourceOccurrence"),
                        Value::Str(U16::from_utf8("occ-5")),
                    ),
                    (
                        U16::from_utf8("handler"),
                        Value::Str(U16::from_utf8("h/commit")),
                    ),
                    (
                        U16::from_utf8("cohort"),
                        Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("1"),
                                Value::Num(f64::from_bits(0x7ff0000000000000)),
                            ),
                            (
                                U16::from_utf8("2"),
                                Value::Num(f64::from_bits(0xc415af1d78b58c40)),
                            ),
                            (
                                U16::from_utf8("z"),
                                Value::Arr(Rc::new(vec![
                                    Value::Num(f64::from_bits(0x4415af1d78b58c40)),
                                    Value::Num(f64::from_bits(0x7ff8000000000000)),
                                ])),
                            ),
                        ])),
                    ),
                    (
                        U16::from_utf8("members"),
                        Value::Arr(Rc::new(vec![
                            Value::Str(U16::from_utf8("A")),
                            Value::Str(U16::from_utf8("b")),
                        ])),
                    ),
                    (
                        U16::from_utf8("memberCount"),
                        Value::Num(f64::from_bits(0x4000000000000000)),
                    ),
                ])),
            },
            Direction::State,
        )
        .unwrap_err();
        assert_eq!(error.name, "StateError");
        assert_eq!(error.message,"Fanout cohort must be model or anchored-collection, got {\"1\":null,\"2\":-100000000000000000000,\"z\":[100000000000000000000,null]}.");
        assert_eq!(error.code, Some("validation".to_owned()));
    }
}
mod receipt {
    use crate::decisions::receipt::*;
    use std::rc::Rc;
    #[test]
    fn caller_28() {
        let error = with_association_row_data(
            &StoredRow {
                id: U16::from_utf8("receipt-assoc/v1/mod/rec/fld"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x408f400000000000),
                updated: f64::from_bits(0x408f400000000000),
                created_by: U16::from_utf8("fz"),
                updated_by: U16::from_utf8("fz"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("recordModel"),
                        Value::Str(U16::from_utf8("mod")),
                    ),
                    (
                        U16::from_utf8("recordId"),
                        Value::Str(U16::from_utf8("rec")),
                    ),
                    (U16::from_utf8("field"), Value::Str(U16::from_utf8("fld"))),
                    (
                        U16::from_utf8("deliveryId"),
                        Value::Str(U16::from_utf8("d-1")),
                    ),
                    (U16::from_utf8("source"), Value::Str(U16::from_utf8("src"))),
                    (
                        U16::from_utf8("revision"),
                        Value::Num(f64::from_bits(0x4415af1d78b58c40)),
                    ),
                ])),
            },
            &AssociationRowData {
                record_model: U16::from_utf8("mod"),
                record_id: U16::from_utf8("rec"),
                field: U16::from_utf8("fld"),
                delivery_id: U16::from_utf8("d-1"),
                source: U16::from_utf8("src"),
                revision: f64::from_bits(0xc415af1d78b58c40),
            },
            &NewRowMeta {
                now_ms: f64::from_bits(0x409f400000000000),
                actor: U16::from_utf8("w02.4-freeze"),
            },
        )
        .unwrap_err();
        assert_eq!(error.name, "ReceiptTableError");
        assert_eq!(error.message,"work.receipt_association: stale revision -100000000000000000000 under current 100000000000000000000.");
    }
    #[test]
    fn caller_29() {
        let error = with_association_row_data(
            &StoredRow {
                id: U16::from_utf8("receipt-assoc/v1/mod/rec/fld"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x408f400000000000),
                updated: f64::from_bits(0x408f400000000000),
                created_by: U16::from_utf8("fz"),
                updated_by: U16::from_utf8("fz"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("recordModel"),
                        Value::Str(U16::from_utf8("mod")),
                    ),
                    (
                        U16::from_utf8("recordId"),
                        Value::Str(U16::from_utf8("rec")),
                    ),
                    (U16::from_utf8("field"), Value::Str(U16::from_utf8("fld"))),
                    (
                        U16::from_utf8("deliveryId"),
                        Value::Str(U16::from_utf8("d-1")),
                    ),
                    (U16::from_utf8("source"), Value::Str(U16::from_utf8("src"))),
                    (
                        U16::from_utf8("revision"),
                        Value::Num(f64::from_bits(0x4415af1d78b58c40)),
                    ),
                ])),
            },
            &AssociationRowData {
                record_model: U16::from_utf8("mod"),
                record_id: U16::from_utf8("rec"),
                field: U16::from_utf8("fld"),
                delivery_id: U16::from_utf8("d-1"),
                source: U16::from_utf8("src"),
                revision: f64::from_bits(0xc415af1d78b58c40),
            },
            &NewRowMeta {
                now_ms: f64::from_bits(0x409f400000000000),
                actor: U16::from_utf8(""),
            },
        )
        .unwrap_err();
        assert_eq!(error.name, "ReceiptTableError");
        assert_eq!(
            error.message,
            "work.receipt_association: actor must be a non-empty string."
        );
    }
    #[test]
    fn caller_30() {
        let error = with_association_row_data(
            &StoredRow {
                id: U16::from_utf8("receipt-assoc/v1/mod/rec/fld"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x408f400000000000),
                updated: f64::from_bits(0x408f400000000000),
                created_by: U16::from_utf8("fz"),
                updated_by: U16::from_utf8("fz"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("recordModel"),
                        Value::Str(U16::from_utf8("mod")),
                    ),
                    (
                        U16::from_utf8("recordId"),
                        Value::Str(U16::from_utf8("rec")),
                    ),
                    (U16::from_utf8("field"), Value::Str(U16::from_utf8("fld"))),
                    (
                        U16::from_utf8("deliveryId"),
                        Value::Str(U16::from_utf8("d-1")),
                    ),
                    (U16::from_utf8("source"), Value::Str(U16::from_utf8("src"))),
                    (
                        U16::from_utf8("revision"),
                        Value::Num(f64::from_bits(0x444b1ae4d6e2ef50)),
                    ),
                ])),
            },
            &AssociationRowData {
                record_model: U16::from_utf8("mod"),
                record_id: U16::from_utf8("rec"),
                field: U16::from_utf8("fld"),
                delivery_id: U16::from_utf8("d-1"),
                source: U16::from_utf8("src"),
                revision: f64::from_bits(0xc415af1d78b58c40),
            },
            &NewRowMeta {
                now_ms: f64::from_bits(0x409f400000000000),
                actor: U16::from_utf8("w02.4-freeze"),
            },
        )
        .unwrap_err();
        assert_eq!(error.name, "ReceiptTableError");
        assert_eq!(
            error.message,
            "work.receipt_association: stale revision -100000000000000000000 under current 1e+21."
        );
    }
    #[test]
    fn caller_31() {
        let error = with_association_row_data(
            &StoredRow {
                id: U16::from_utf8("receipt-assoc/v1/mod/rec/fld"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x408f400000000000),
                updated: f64::from_bits(0x408f400000000000),
                created_by: U16::from_utf8("fz"),
                updated_by: U16::from_utf8("fz"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("recordModel"),
                        Value::Str(U16::from_utf8("mod")),
                    ),
                    (
                        U16::from_utf8("recordId"),
                        Value::Str(U16::from_utf8("rec")),
                    ),
                    (U16::from_utf8("field"), Value::Str(U16::from_utf8("fld"))),
                    (
                        U16::from_utf8("deliveryId"),
                        Value::Str(U16::from_utf8("d-1")),
                    ),
                    (U16::from_utf8("source"), Value::Str(U16::from_utf8("src"))),
                    (
                        U16::from_utf8("revision"),
                        Value::Num(f64::from_bits(0x444b1ae4d6e2ef50)),
                    ),
                ])),
            },
            &AssociationRowData {
                record_model: U16::from_utf8("mod"),
                record_id: U16::from_utf8("rec"),
                field: U16::from_utf8("fld"),
                delivery_id: U16::from_utf8("d-1"),
                source: U16::from_utf8("src"),
                revision: f64::from_bits(0xc415af1d78b58c40),
            },
            &NewRowMeta {
                now_ms: f64::from_bits(0x409f400000000000),
                actor: U16::from_utf8(""),
            },
        )
        .unwrap_err();
        assert_eq!(error.name, "ReceiptTableError");
        assert_eq!(
            error.message,
            "work.receipt_association: actor must be a non-empty string."
        );
    }
    #[test]
    fn caller_32() {
        let error = with_association_row_data(
            &StoredRow {
                id: U16::from_utf8("receipt-assoc/v1/mod/rec/fld"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x408f400000000000),
                updated: f64::from_bits(0x408f400000000000),
                created_by: U16::from_utf8("fz"),
                updated_by: U16::from_utf8("fz"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("recordModel"),
                        Value::Str(U16::from_utf8("mod")),
                    ),
                    (
                        U16::from_utf8("recordId"),
                        Value::Str(U16::from_utf8("rec")),
                    ),
                    (U16::from_utf8("field"), Value::Str(U16::from_utf8("fld"))),
                    (
                        U16::from_utf8("deliveryId"),
                        Value::Str(U16::from_utf8("d-1")),
                    ),
                    (U16::from_utf8("source"), Value::Str(U16::from_utf8("src"))),
                    (
                        U16::from_utf8("revision"),
                        Value::Num(f64::from_bits(0x43e0000000000000)),
                    ),
                ])),
            },
            &AssociationRowData {
                record_model: U16::from_utf8("mod"),
                record_id: U16::from_utf8("rec"),
                field: U16::from_utf8("fld"),
                delivery_id: U16::from_utf8("d-1"),
                source: U16::from_utf8("src"),
                revision: f64::from_bits(0xc415af1d78b58c40),
            },
            &NewRowMeta {
                now_ms: f64::from_bits(0x409f400000000000),
                actor: U16::from_utf8("w02.4-freeze"),
            },
        )
        .unwrap_err();
        assert_eq!(error.name, "ReceiptTableError");
        assert_eq!(error.message,"work.receipt_association: stale revision -100000000000000000000 under current 9223372036854776000.");
    }
    #[test]
    fn caller_33() {
        let error = with_association_row_data(
            &StoredRow {
                id: U16::from_utf8("receipt-assoc/v1/mod/rec/fld"),
                version: f64::from_bits(0x3ff0000000000000),
                created: f64::from_bits(0x408f400000000000),
                updated: f64::from_bits(0x408f400000000000),
                created_by: U16::from_utf8("fz"),
                updated_by: U16::from_utf8("fz"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("recordModel"),
                        Value::Str(U16::from_utf8("mod")),
                    ),
                    (
                        U16::from_utf8("recordId"),
                        Value::Str(U16::from_utf8("rec")),
                    ),
                    (U16::from_utf8("field"), Value::Str(U16::from_utf8("fld"))),
                    (
                        U16::from_utf8("deliveryId"),
                        Value::Str(U16::from_utf8("d-1")),
                    ),
                    (U16::from_utf8("source"), Value::Str(U16::from_utf8("src"))),
                    (
                        U16::from_utf8("revision"),
                        Value::Num(f64::from_bits(0x43e0000000000000)),
                    ),
                ])),
            },
            &AssociationRowData {
                record_model: U16::from_utf8("mod"),
                record_id: U16::from_utf8("rec"),
                field: U16::from_utf8("fld"),
                delivery_id: U16::from_utf8("d-1"),
                source: U16::from_utf8("src"),
                revision: f64::from_bits(0xc415af1d78b58c40),
            },
            &NewRowMeta {
                now_ms: f64::from_bits(0x409f400000000000),
                actor: U16::from_utf8(""),
            },
        )
        .unwrap_err();
        assert_eq!(error.name, "ReceiptTableError");
        assert_eq!(
            error.message,
            "work.receipt_association: actor must be a non-empty string."
        );
    }
    #[test]
    fn caller_54() {
        let error = read_receipt_row(&StoredRow {
            id: U16::from_utf8("d-2"),
            version: f64::from_bits(0x3ff0000000000000),
            created: f64::from_bits(0x408f400000000000),
            updated: f64::from_bits(0x408f400000000000),
            created_by: U16::from_utf8("fz"),
            updated_by: U16::from_utf8("fz"),
            archived_at: Value::Null,
            parent: Value::Null,
            data: Value::Obj(Rc::new(vec![
                (
                    U16::from_utf8("deliveryId"),
                    Value::Str(U16::from_utf8("d-2")),
                ),
                (
                    U16::from_utf8("revision"),
                    Value::Num(f64::from_bits(0x4010000000000000)),
                ),
                (
                    U16::from_utf8("status"),
                    Value::Str(U16::from_utf8("pending")),
                ),
                (U16::from_utf8("result"), Value::Null),
                (U16::from_utf8("error"), Value::Null),
                (
                    U16::from_utf8("contentRef"),
                    Value::Num(f64::from_bits(0x4415af1d78b58c40)),
                ),
                (
                    U16::from_utf8("resultExpiresAtMs"),
                    Value::Num(f64::from_bits(0x408f380000000000)),
                ),
            ])),
        })
        .unwrap_err();
        assert_eq!(error.name, "ReceiptTableError");
        assert_eq!(
            error.message,
            "work.receipt.contentRef must be a non-empty string or null."
        );
    }
    #[test]
    fn caller_58() {
        let error = read_receipt_row(&StoredRow {
            id: U16::from_utf8("d-2"),
            version: f64::from_bits(0x3ff0000000000000),
            created: f64::from_bits(0x408f400000000000),
            updated: f64::from_bits(0x408f400000000000),
            created_by: U16::from_utf8("fz"),
            updated_by: U16::from_utf8("fz"),
            archived_at: Value::Null,
            parent: Value::Null,
            data: Value::Obj(Rc::new(vec![
                (
                    U16::from_utf8("deliveryId"),
                    Value::Str(U16::from_utf8("d-2")),
                ),
                (
                    U16::from_utf8("revision"),
                    Value::Num(f64::from_bits(0x4010000000000000)),
                ),
                (
                    U16::from_utf8("status"),
                    Value::Str(U16::from_utf8("pending")),
                ),
                (U16::from_utf8("result"), Value::Null),
                (U16::from_utf8("error"), Value::Null),
                (
                    U16::from_utf8("contentRef"),
                    Value::Num(f64::from_bits(0x7ff8000000000000)),
                ),
                (
                    U16::from_utf8("resultExpiresAtMs"),
                    Value::Num(f64::from_bits(0x408f380000000000)),
                ),
            ])),
        })
        .unwrap_err();
        assert_eq!(error.name, "ReceiptTableError");
        assert_eq!(
            error.message,
            "work.receipt.contentRef must be a non-empty string or null."
        );
    }
    #[test]
    fn caller_62() {
        let error = read_receipt_row(&StoredRow {
            id: U16::from_utf8("d-2"),
            version: f64::from_bits(0x3ff0000000000000),
            created: f64::from_bits(0x408f400000000000),
            updated: f64::from_bits(0x408f400000000000),
            created_by: U16::from_utf8("fz"),
            updated_by: U16::from_utf8("fz"),
            archived_at: Value::Null,
            parent: Value::Null,
            data: Value::Obj(Rc::new(vec![
                (
                    U16::from_utf8("deliveryId"),
                    Value::Str(U16::from_utf8("d-2")),
                ),
                (
                    U16::from_utf8("revision"),
                    Value::Num(f64::from_bits(0x4010000000000000)),
                ),
                (
                    U16::from_utf8("status"),
                    Value::Str(U16::from_utf8("pending")),
                ),
                (U16::from_utf8("result"), Value::Null),
                (U16::from_utf8("error"), Value::Null),
                (
                    U16::from_utf8("contentRef"),
                    Value::Num(f64::from_bits(0x7ff0000000000000)),
                ),
                (
                    U16::from_utf8("resultExpiresAtMs"),
                    Value::Num(f64::from_bits(0x408f380000000000)),
                ),
            ])),
        })
        .unwrap_err();
        assert_eq!(error.name, "ReceiptTableError");
        assert_eq!(
            error.message,
            "work.receipt.contentRef must be a non-empty string or null."
        );
    }
    #[test]
    fn caller_66() {
        let error = read_receipt_row(&StoredRow {
            id: U16::from_utf8("d-2"),
            version: f64::from_bits(0x3ff0000000000000),
            created: f64::from_bits(0x408f400000000000),
            updated: f64::from_bits(0x408f400000000000),
            created_by: U16::from_utf8("fz"),
            updated_by: U16::from_utf8("fz"),
            archived_at: Value::Null,
            parent: Value::Null,
            data: Value::Obj(Rc::new(vec![
                (
                    U16::from_utf8("deliveryId"),
                    Value::Str(U16::from_utf8("d-2")),
                ),
                (
                    U16::from_utf8("revision"),
                    Value::Num(f64::from_bits(0x4010000000000000)),
                ),
                (
                    U16::from_utf8("status"),
                    Value::Str(U16::from_utf8("pending")),
                ),
                (U16::from_utf8("result"), Value::Null),
                (U16::from_utf8("error"), Value::Null),
                (
                    U16::from_utf8("contentRef"),
                    Value::Num(f64::from_bits(0xfff0000000000000)),
                ),
                (
                    U16::from_utf8("resultExpiresAtMs"),
                    Value::Num(f64::from_bits(0x408f380000000000)),
                ),
            ])),
        })
        .unwrap_err();
        assert_eq!(error.name, "ReceiptTableError");
        assert_eq!(
            error.message,
            "work.receipt.contentRef must be a non-empty string or null."
        );
    }
    #[test]
    fn caller_70() {
        let error = read_receipt_row(&StoredRow {
            id: U16::from_utf8("d-2"),
            version: f64::from_bits(0x3ff0000000000000),
            created: f64::from_bits(0x408f400000000000),
            updated: f64::from_bits(0x408f400000000000),
            created_by: U16::from_utf8("fz"),
            updated_by: U16::from_utf8("fz"),
            archived_at: Value::Null,
            parent: Value::Null,
            data: Value::Obj(Rc::new(vec![
                (
                    U16::from_utf8("deliveryId"),
                    Value::Str(U16::from_utf8("d-2")),
                ),
                (
                    U16::from_utf8("revision"),
                    Value::Num(f64::from_bits(0x4010000000000000)),
                ),
                (
                    U16::from_utf8("status"),
                    Value::Str(U16::from_utf8("pending")),
                ),
                (U16::from_utf8("result"), Value::Null),
                (U16::from_utf8("error"), Value::Null),
                (
                    U16::from_utf8("contentRef"),
                    Value::Obj(Rc::new(vec![
                        (
                            U16::from_utf8("1"),
                            Value::Num(f64::from_bits(0x7ff0000000000000)),
                        ),
                        (
                            U16::from_utf8("2"),
                            Value::Num(f64::from_bits(0xc415af1d78b58c40)),
                        ),
                        (
                            U16::from_utf8("z"),
                            Value::Arr(Rc::new(vec![
                                Value::Num(f64::from_bits(0x4415af1d78b58c40)),
                                Value::Num(f64::from_bits(0x7ff8000000000000)),
                            ])),
                        ),
                    ])),
                ),
                (
                    U16::from_utf8("resultExpiresAtMs"),
                    Value::Num(f64::from_bits(0x408f380000000000)),
                ),
            ])),
        })
        .unwrap_err();
        assert_eq!(error.name, "ReceiptTableError");
        assert_eq!(
            error.message,
            "work.receipt.contentRef must be a non-empty string or null."
        );
    }
}
mod recovery {
    use crate::decisions::recovery::*;
    #[test]
    fn caller_35() {
        let error = plan_related_progress_resume(&RelatedProgressResumeInput {
            relation: U16::from_utf8("std.EmailV1.send"),
            rows: vec![RelatedProgressRowView {
                relation: U16::from_utf8("std.EmailV1.send"),
                association: ResumeAssociation {
                    delivery_id: U16::from_utf8("a"),
                    revision: f64::from_bits(0x4415af1d78b58c40),
                },
                receipt: ResumeReceipt {
                    delivery_id: U16::from_utf8("a"),
                    revision: f64::from_bits(0xc415af1d78b58c40),
                    status: U16::from_utf8("pending"),
                },
            }],
        })
        .unwrap_err();
        assert_eq!(error.name, "Error");
        assert_eq!(error.message,"planRelatedProgressResume: association revision 100000000000000000000 disagrees with receipt revision -100000000000000000000.");
    }
    #[test]
    fn caller_36() {
        let error = plan_related_progress_resume(&RelatedProgressResumeInput {
            relation: U16::from_utf8("std.EmailV1.send"),
            rows: vec![RelatedProgressRowView {
                relation: U16::from_utf8("std.EmailV1.send"),
                association: ResumeAssociation {
                    delivery_id: U16::from_utf8("a"),
                    revision: f64::from_bits(0x4415af1d78b58c40),
                },
                receipt: ResumeReceipt {
                    delivery_id: U16::from_utf8("foreign"),
                    revision: f64::from_bits(0xc415af1d78b58c40),
                    status: U16::from_utf8("pending"),
                },
            }],
        })
        .unwrap_err();
        assert_eq!(error.name, "Error");
        assert_eq!(
            error.message,
            "planRelatedProgressResume: receipt \"foreign\" does not belong to association \"a\"."
        );
    }
    #[test]
    fn caller_38() {
        let result = plan_related_progress_resume(&RelatedProgressResumeInput {
            relation: U16::from_utf8("std.EmailV1.send"),
            rows: vec![RelatedProgressRowView {
                relation: U16::from_utf8("std.EmailV1.send"),
                association: ResumeAssociation {
                    delivery_id: U16::from_utf8("a"),
                    revision: f64::from_bits(0xc415af1d78b58c40),
                },
                receipt: ResumeReceipt {
                    delivery_id: U16::from_utf8("a"),
                    revision: f64::from_bits(0xc415af1d78b58c40),
                    status: U16::from_utf8("pending"),
                },
            }],
        })
        .unwrap();
        assert_eq!(
            result,
            RelatedProgressResumePlan {
                relation: U16::from_utf8("std.EmailV1.send"),
                resume: vec![U16::from_utf8("a")],
                settled: vec![]
            }
        );
    }
    #[test]
    fn caller_39() {
        let error = plan_related_progress_resume(&RelatedProgressResumeInput {
            relation: U16::from_utf8("std.EmailV1.send"),
            rows: vec![RelatedProgressRowView {
                relation: U16::from_utf8("std.EmailV1.send"),
                association: ResumeAssociation {
                    delivery_id: U16::from_utf8("a"),
                    revision: f64::from_bits(0xc415af1d78b58c40),
                },
                receipt: ResumeReceipt {
                    delivery_id: U16::from_utf8("foreign"),
                    revision: f64::from_bits(0xc415af1d78b58c40),
                    status: U16::from_utf8("pending"),
                },
            }],
        })
        .unwrap_err();
        assert_eq!(error.name, "Error");
        assert_eq!(
            error.message,
            "planRelatedProgressResume: receipt \"foreign\" does not belong to association \"a\"."
        );
    }
    #[test]
    fn caller_41() {
        let error = plan_related_progress_resume(&RelatedProgressResumeInput {
            relation: U16::from_utf8("std.EmailV1.send"),
            rows: vec![RelatedProgressRowView {
                relation: U16::from_utf8("std.EmailV1.send"),
                association: ResumeAssociation {
                    delivery_id: U16::from_utf8("a"),
                    revision: f64::from_bits(0x444b1ae4d6e2ef50),
                },
                receipt: ResumeReceipt {
                    delivery_id: U16::from_utf8("a"),
                    revision: f64::from_bits(0xc415af1d78b58c40),
                    status: U16::from_utf8("pending"),
                },
            }],
        })
        .unwrap_err();
        assert_eq!(error.name, "Error");
        assert_eq!(error.message,"planRelatedProgressResume: association revision 1e+21 disagrees with receipt revision -100000000000000000000.");
    }
    #[test]
    fn caller_42() {
        let error = plan_related_progress_resume(&RelatedProgressResumeInput {
            relation: U16::from_utf8("std.EmailV1.send"),
            rows: vec![RelatedProgressRowView {
                relation: U16::from_utf8("std.EmailV1.send"),
                association: ResumeAssociation {
                    delivery_id: U16::from_utf8("a"),
                    revision: f64::from_bits(0x444b1ae4d6e2ef50),
                },
                receipt: ResumeReceipt {
                    delivery_id: U16::from_utf8("foreign"),
                    revision: f64::from_bits(0xc415af1d78b58c40),
                    status: U16::from_utf8("pending"),
                },
            }],
        })
        .unwrap_err();
        assert_eq!(error.name, "Error");
        assert_eq!(
            error.message,
            "planRelatedProgressResume: receipt \"foreign\" does not belong to association \"a\"."
        );
    }
    #[test]
    fn caller_44() {
        let error = plan_related_progress_resume(&RelatedProgressResumeInput {
            relation: U16::from_utf8("std.EmailV1.send"),
            rows: vec![RelatedProgressRowView {
                relation: U16::from_utf8("std.EmailV1.send"),
                association: ResumeAssociation {
                    delivery_id: U16::from_utf8("a"),
                    revision: f64::from_bits(0x7ff8000000000000),
                },
                receipt: ResumeReceipt {
                    delivery_id: U16::from_utf8("a"),
                    revision: f64::from_bits(0xc415af1d78b58c40),
                    status: U16::from_utf8("pending"),
                },
            }],
        })
        .unwrap_err();
        assert_eq!(error.name, "Error");
        assert_eq!(error.message,"planRelatedProgressResume: association revision NaN disagrees with receipt revision -100000000000000000000.");
    }
    #[test]
    fn caller_45() {
        let error = plan_related_progress_resume(&RelatedProgressResumeInput {
            relation: U16::from_utf8("std.EmailV1.send"),
            rows: vec![RelatedProgressRowView {
                relation: U16::from_utf8("std.EmailV1.send"),
                association: ResumeAssociation {
                    delivery_id: U16::from_utf8("a"),
                    revision: f64::from_bits(0x7ff8000000000000),
                },
                receipt: ResumeReceipt {
                    delivery_id: U16::from_utf8("foreign"),
                    revision: f64::from_bits(0xc415af1d78b58c40),
                    status: U16::from_utf8("pending"),
                },
            }],
        })
        .unwrap_err();
        assert_eq!(error.name, "Error");
        assert_eq!(
            error.message,
            "planRelatedProgressResume: receipt \"foreign\" does not belong to association \"a\"."
        );
    }
    #[test]
    fn caller_47() {
        let error = plan_related_progress_resume(&RelatedProgressResumeInput {
            relation: U16::from_utf8("std.EmailV1.send"),
            rows: vec![RelatedProgressRowView {
                relation: U16::from_utf8("std.EmailV1.send"),
                association: ResumeAssociation {
                    delivery_id: U16::from_utf8("a"),
                    revision: f64::from_bits(0x7ff0000000000000),
                },
                receipt: ResumeReceipt {
                    delivery_id: U16::from_utf8("a"),
                    revision: f64::from_bits(0xc415af1d78b58c40),
                    status: U16::from_utf8("pending"),
                },
            }],
        })
        .unwrap_err();
        assert_eq!(error.name, "Error");
        assert_eq!(error.message,"planRelatedProgressResume: association revision Infinity disagrees with receipt revision -100000000000000000000.");
    }
    #[test]
    fn caller_48() {
        let error = plan_related_progress_resume(&RelatedProgressResumeInput {
            relation: U16::from_utf8("std.EmailV1.send"),
            rows: vec![RelatedProgressRowView {
                relation: U16::from_utf8("std.EmailV1.send"),
                association: ResumeAssociation {
                    delivery_id: U16::from_utf8("a"),
                    revision: f64::from_bits(0x7ff0000000000000),
                },
                receipt: ResumeReceipt {
                    delivery_id: U16::from_utf8("foreign"),
                    revision: f64::from_bits(0xc415af1d78b58c40),
                    status: U16::from_utf8("pending"),
                },
            }],
        })
        .unwrap_err();
        assert_eq!(error.name, "Error");
        assert_eq!(
            error.message,
            "planRelatedProgressResume: receipt \"foreign\" does not belong to association \"a\"."
        );
    }
    #[test]
    fn caller_50() {
        let error = plan_related_progress_resume(&RelatedProgressResumeInput {
            relation: U16::from_utf8("std.EmailV1.send"),
            rows: vec![RelatedProgressRowView {
                relation: U16::from_utf8("std.EmailV1.send"),
                association: ResumeAssociation {
                    delivery_id: U16::from_utf8("a"),
                    revision: f64::from_bits(0xfff0000000000000),
                },
                receipt: ResumeReceipt {
                    delivery_id: U16::from_utf8("a"),
                    revision: f64::from_bits(0xc415af1d78b58c40),
                    status: U16::from_utf8("pending"),
                },
            }],
        })
        .unwrap_err();
        assert_eq!(error.name, "Error");
        assert_eq!(error.message,"planRelatedProgressResume: association revision -Infinity disagrees with receipt revision -100000000000000000000.");
    }
    #[test]
    fn caller_51() {
        let error = plan_related_progress_resume(&RelatedProgressResumeInput {
            relation: U16::from_utf8("std.EmailV1.send"),
            rows: vec![RelatedProgressRowView {
                relation: U16::from_utf8("std.EmailV1.send"),
                association: ResumeAssociation {
                    delivery_id: U16::from_utf8("a"),
                    revision: f64::from_bits(0xfff0000000000000),
                },
                receipt: ResumeReceipt {
                    delivery_id: U16::from_utf8("foreign"),
                    revision: f64::from_bits(0xc415af1d78b58c40),
                    status: U16::from_utf8("pending"),
                },
            }],
        })
        .unwrap_err();
        assert_eq!(error.name, "Error");
        assert_eq!(
            error.message,
            "planRelatedProgressResume: receipt \"foreign\" does not belong to association \"a\"."
        );
    }
}
mod linkage {
    use crate::decisions::linkage::*;
    use std::rc::Rc;
    #[test]
    fn caller_34() {
        assert_receipt_join(&CommitBatch {
            outbox: vec![],
            writes: vec![
                DomainWrite {
                    kind: WriteKind::Insert,
                    model: U16::from_utf8("work.receipt_association"),
                    row: StoredRow {
                        id: U16::from_utf8("receipt-assoc/v1/m/r/f"),
                        version: f64::from_bits(0x3ff0000000000000),
                        created: f64::from_bits(0x408f400000000000),
                        updated: f64::from_bits(0x408f400000000000),
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("recordModel"),
                                Value::Str(U16::from_utf8("m")),
                            ),
                            (U16::from_utf8("recordId"), Value::Str(U16::from_utf8("r"))),
                            (U16::from_utf8("field"), Value::Str(U16::from_utf8("f"))),
                            (
                                U16::from_utf8("deliveryId"),
                                Value::Str(U16::from_utf8("d-1")),
                            ),
                            (U16::from_utf8("source"), Value::Str(U16::from_utf8("s"))),
                            (
                                U16::from_utf8("revision"),
                                Value::Num(f64::from_bits(0x4415af1d78b58c40)),
                            ),
                        ])),
                    },
                    id: None,
                },
                DomainWrite {
                    kind: WriteKind::Insert,
                    model: U16::from_utf8("work.receipt"),
                    row: StoredRow {
                        id: U16::from_utf8("d-1"),
                        version: f64::from_bits(0x3ff0000000000000),
                        created: f64::from_bits(0x408f400000000000),
                        updated: f64::from_bits(0x408f400000000000),
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("deliveryId"),
                                Value::Str(U16::from_utf8("d-1")),
                            ),
                            (
                                U16::from_utf8("revision"),
                                Value::Num(f64::from_bits(0x4415af1d78b58c40)),
                            ),
                            (
                                U16::from_utf8("status"),
                                Value::Str(U16::from_utf8("pending")),
                            ),
                            (U16::from_utf8("result"), Value::Null),
                            (U16::from_utf8("error"), Value::Null),
                            (U16::from_utf8("contentRef"), Value::Null),
                            (U16::from_utf8("resultExpiresAtMs"), Value::Null),
                        ])),
                    },
                    id: None,
                },
            ],
        })
        .unwrap();
    }
    #[test]
    fn caller_37() {
        let error = assert_receipt_join(&CommitBatch {
            outbox: vec![],
            writes: vec![
                DomainWrite {
                    kind: WriteKind::Insert,
                    model: U16::from_utf8("work.receipt_association"),
                    row: StoredRow {
                        id: U16::from_utf8("receipt-assoc/v1/m/r/f"),
                        version: f64::from_bits(0x3ff0000000000000),
                        created: f64::from_bits(0x408f400000000000),
                        updated: f64::from_bits(0x408f400000000000),
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("recordModel"),
                                Value::Str(U16::from_utf8("m")),
                            ),
                            (U16::from_utf8("recordId"), Value::Str(U16::from_utf8("r"))),
                            (U16::from_utf8("field"), Value::Str(U16::from_utf8("f"))),
                            (
                                U16::from_utf8("deliveryId"),
                                Value::Str(U16::from_utf8("d-1")),
                            ),
                            (U16::from_utf8("source"), Value::Str(U16::from_utf8("s"))),
                            (
                                U16::from_utf8("revision"),
                                Value::Num(f64::from_bits(0x4415af1d78b58c40)),
                            ),
                        ])),
                    },
                    id: None,
                },
                DomainWrite {
                    kind: WriteKind::Insert,
                    model: U16::from_utf8("work.receipt"),
                    row: StoredRow {
                        id: U16::from_utf8("d-1"),
                        version: f64::from_bits(0x3ff0000000000000),
                        created: f64::from_bits(0x408f400000000000),
                        updated: f64::from_bits(0x408f400000000000),
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("deliveryId"),
                                Value::Str(U16::from_utf8("d-1")),
                            ),
                            (
                                U16::from_utf8("revision"),
                                Value::Num(f64::from_bits(0xc415af1d78b58c40)),
                            ),
                            (
                                U16::from_utf8("status"),
                                Value::Str(U16::from_utf8("pending")),
                            ),
                            (U16::from_utf8("result"), Value::Null),
                            (U16::from_utf8("error"), Value::Null),
                            (U16::from_utf8("contentRef"), Value::Null),
                            (U16::from_utf8("resultExpiresAtMs"), Value::Null),
                        ])),
                    },
                    id: None,
                },
            ],
        })
        .unwrap_err();
        assert_eq!(error.name, "StateError");
        assert_eq!(
            error.message,
            "Receipt join: work.receipt.revision must be an integer >= 0."
        );
        assert_eq!(error.code, Some("validation".to_owned()));
    }
    #[test]
    fn caller_40() {
        let error = assert_receipt_join(&CommitBatch {
            outbox: vec![],
            writes: vec![
                DomainWrite {
                    kind: WriteKind::Insert,
                    model: U16::from_utf8("work.receipt_association"),
                    row: StoredRow {
                        id: U16::from_utf8("receipt-assoc/v1/m/r/f"),
                        version: f64::from_bits(0x3ff0000000000000),
                        created: f64::from_bits(0x408f400000000000),
                        updated: f64::from_bits(0x408f400000000000),
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("recordModel"),
                                Value::Str(U16::from_utf8("m")),
                            ),
                            (U16::from_utf8("recordId"), Value::Str(U16::from_utf8("r"))),
                            (U16::from_utf8("field"), Value::Str(U16::from_utf8("f"))),
                            (
                                U16::from_utf8("deliveryId"),
                                Value::Str(U16::from_utf8("d-1")),
                            ),
                            (U16::from_utf8("source"), Value::Str(U16::from_utf8("s"))),
                            (
                                U16::from_utf8("revision"),
                                Value::Num(f64::from_bits(0x4415af1d78b58c40)),
                            ),
                        ])),
                    },
                    id: None,
                },
                DomainWrite {
                    kind: WriteKind::Insert,
                    model: U16::from_utf8("work.receipt"),
                    row: StoredRow {
                        id: U16::from_utf8("d-1"),
                        version: f64::from_bits(0x3ff0000000000000),
                        created: f64::from_bits(0x408f400000000000),
                        updated: f64::from_bits(0x408f400000000000),
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("deliveryId"),
                                Value::Str(U16::from_utf8("d-1")),
                            ),
                            (
                                U16::from_utf8("revision"),
                                Value::Num(f64::from_bits(0x444b1ae4d6e2ef50)),
                            ),
                            (
                                U16::from_utf8("status"),
                                Value::Str(U16::from_utf8("pending")),
                            ),
                            (U16::from_utf8("result"), Value::Null),
                            (U16::from_utf8("error"), Value::Null),
                            (U16::from_utf8("contentRef"), Value::Null),
                            (U16::from_utf8("resultExpiresAtMs"), Value::Null),
                        ])),
                    },
                    id: None,
                },
            ],
        })
        .unwrap_err();
        assert_eq!(error.name, "StateError");
        assert_eq!(error.message,"Receipt join: receipt revision 1e+21 disagrees with association revision 100000000000000000000 for \"d-1\".");
        assert_eq!(error.code, Some("validation".to_owned()));
    }
    #[test]
    fn caller_43() {
        let error = assert_receipt_join(&CommitBatch {
            outbox: vec![],
            writes: vec![
                DomainWrite {
                    kind: WriteKind::Insert,
                    model: U16::from_utf8("work.receipt_association"),
                    row: StoredRow {
                        id: U16::from_utf8("receipt-assoc/v1/m/r/f"),
                        version: f64::from_bits(0x3ff0000000000000),
                        created: f64::from_bits(0x408f400000000000),
                        updated: f64::from_bits(0x408f400000000000),
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("recordModel"),
                                Value::Str(U16::from_utf8("m")),
                            ),
                            (U16::from_utf8("recordId"), Value::Str(U16::from_utf8("r"))),
                            (U16::from_utf8("field"), Value::Str(U16::from_utf8("f"))),
                            (
                                U16::from_utf8("deliveryId"),
                                Value::Str(U16::from_utf8("d-1")),
                            ),
                            (U16::from_utf8("source"), Value::Str(U16::from_utf8("s"))),
                            (
                                U16::from_utf8("revision"),
                                Value::Num(f64::from_bits(0x4415af1d78b58c40)),
                            ),
                        ])),
                    },
                    id: None,
                },
                DomainWrite {
                    kind: WriteKind::Insert,
                    model: U16::from_utf8("work.receipt"),
                    row: StoredRow {
                        id: U16::from_utf8("d-1"),
                        version: f64::from_bits(0x3ff0000000000000),
                        created: f64::from_bits(0x408f400000000000),
                        updated: f64::from_bits(0x408f400000000000),
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("deliveryId"),
                                Value::Str(U16::from_utf8("d-1")),
                            ),
                            (
                                U16::from_utf8("revision"),
                                Value::Num(f64::from_bits(0x7ff8000000000000)),
                            ),
                            (
                                U16::from_utf8("status"),
                                Value::Str(U16::from_utf8("pending")),
                            ),
                            (U16::from_utf8("result"), Value::Null),
                            (U16::from_utf8("error"), Value::Null),
                            (U16::from_utf8("contentRef"), Value::Null),
                            (U16::from_utf8("resultExpiresAtMs"), Value::Null),
                        ])),
                    },
                    id: None,
                },
            ],
        })
        .unwrap_err();
        assert_eq!(error.name, "StateError");
        assert_eq!(
            error.message,
            "Receipt join: work.receipt.revision must be an integer >= 0."
        );
        assert_eq!(error.code, Some("validation".to_owned()));
    }
    #[test]
    fn caller_46() {
        let error = assert_receipt_join(&CommitBatch {
            outbox: vec![],
            writes: vec![
                DomainWrite {
                    kind: WriteKind::Insert,
                    model: U16::from_utf8("work.receipt_association"),
                    row: StoredRow {
                        id: U16::from_utf8("receipt-assoc/v1/m/r/f"),
                        version: f64::from_bits(0x3ff0000000000000),
                        created: f64::from_bits(0x408f400000000000),
                        updated: f64::from_bits(0x408f400000000000),
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("recordModel"),
                                Value::Str(U16::from_utf8("m")),
                            ),
                            (U16::from_utf8("recordId"), Value::Str(U16::from_utf8("r"))),
                            (U16::from_utf8("field"), Value::Str(U16::from_utf8("f"))),
                            (
                                U16::from_utf8("deliveryId"),
                                Value::Str(U16::from_utf8("d-1")),
                            ),
                            (U16::from_utf8("source"), Value::Str(U16::from_utf8("s"))),
                            (
                                U16::from_utf8("revision"),
                                Value::Num(f64::from_bits(0x4415af1d78b58c40)),
                            ),
                        ])),
                    },
                    id: None,
                },
                DomainWrite {
                    kind: WriteKind::Insert,
                    model: U16::from_utf8("work.receipt"),
                    row: StoredRow {
                        id: U16::from_utf8("d-1"),
                        version: f64::from_bits(0x3ff0000000000000),
                        created: f64::from_bits(0x408f400000000000),
                        updated: f64::from_bits(0x408f400000000000),
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("deliveryId"),
                                Value::Str(U16::from_utf8("d-1")),
                            ),
                            (
                                U16::from_utf8("revision"),
                                Value::Num(f64::from_bits(0x7ff0000000000000)),
                            ),
                            (
                                U16::from_utf8("status"),
                                Value::Str(U16::from_utf8("pending")),
                            ),
                            (U16::from_utf8("result"), Value::Null),
                            (U16::from_utf8("error"), Value::Null),
                            (U16::from_utf8("contentRef"), Value::Null),
                            (U16::from_utf8("resultExpiresAtMs"), Value::Null),
                        ])),
                    },
                    id: None,
                },
            ],
        })
        .unwrap_err();
        assert_eq!(error.name, "StateError");
        assert_eq!(
            error.message,
            "Receipt join: work.receipt.revision must be an integer >= 0."
        );
        assert_eq!(error.code, Some("validation".to_owned()));
    }
    #[test]
    fn caller_49() {
        let error = assert_receipt_join(&CommitBatch {
            outbox: vec![],
            writes: vec![
                DomainWrite {
                    kind: WriteKind::Insert,
                    model: U16::from_utf8("work.receipt_association"),
                    row: StoredRow {
                        id: U16::from_utf8("receipt-assoc/v1/m/r/f"),
                        version: f64::from_bits(0x3ff0000000000000),
                        created: f64::from_bits(0x408f400000000000),
                        updated: f64::from_bits(0x408f400000000000),
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("recordModel"),
                                Value::Str(U16::from_utf8("m")),
                            ),
                            (U16::from_utf8("recordId"), Value::Str(U16::from_utf8("r"))),
                            (U16::from_utf8("field"), Value::Str(U16::from_utf8("f"))),
                            (
                                U16::from_utf8("deliveryId"),
                                Value::Str(U16::from_utf8("d-1")),
                            ),
                            (U16::from_utf8("source"), Value::Str(U16::from_utf8("s"))),
                            (
                                U16::from_utf8("revision"),
                                Value::Num(f64::from_bits(0x4415af1d78b58c40)),
                            ),
                        ])),
                    },
                    id: None,
                },
                DomainWrite {
                    kind: WriteKind::Insert,
                    model: U16::from_utf8("work.receipt"),
                    row: StoredRow {
                        id: U16::from_utf8("d-1"),
                        version: f64::from_bits(0x3ff0000000000000),
                        created: f64::from_bits(0x408f400000000000),
                        updated: f64::from_bits(0x408f400000000000),
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("deliveryId"),
                                Value::Str(U16::from_utf8("d-1")),
                            ),
                            (
                                U16::from_utf8("revision"),
                                Value::Num(f64::from_bits(0xfff0000000000000)),
                            ),
                            (
                                U16::from_utf8("status"),
                                Value::Str(U16::from_utf8("pending")),
                            ),
                            (U16::from_utf8("result"), Value::Null),
                            (U16::from_utf8("error"), Value::Null),
                            (U16::from_utf8("contentRef"), Value::Null),
                            (U16::from_utf8("resultExpiresAtMs"), Value::Null),
                        ])),
                    },
                    id: None,
                },
            ],
        })
        .unwrap_err();
        assert_eq!(error.name, "StateError");
        assert_eq!(
            error.message,
            "Receipt join: work.receipt.revision must be an integer >= 0."
        );
        assert_eq!(error.code, Some("validation".to_owned()));
    }
    #[test]
    fn caller_55() {
        let error = assert_receipt_join(&CommitBatch {
            outbox: vec![],
            writes: vec![
                DomainWrite {
                    kind: WriteKind::Insert,
                    model: U16::from_utf8("work.receipt_association"),
                    row: StoredRow {
                        id: U16::from_utf8("receipt-assoc/v1/m/r/f"),
                        version: f64::from_bits(0x3ff0000000000000),
                        created: f64::from_bits(0x408f400000000000),
                        updated: f64::from_bits(0x408f400000000000),
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("recordModel"),
                                Value::Str(U16::from_utf8("m")),
                            ),
                            (U16::from_utf8("recordId"), Value::Str(U16::from_utf8("r"))),
                            (U16::from_utf8("field"), Value::Str(U16::from_utf8("f"))),
                            (
                                U16::from_utf8("deliveryId"),
                                Value::Str(U16::from_utf8("d-1")),
                            ),
                            (U16::from_utf8("source"), Value::Str(U16::from_utf8("s"))),
                            (
                                U16::from_utf8("revision"),
                                Value::Num(f64::from_bits(0x4000000000000000)),
                            ),
                        ])),
                    },
                    id: None,
                },
                DomainWrite {
                    kind: WriteKind::Insert,
                    model: U16::from_utf8("work.receipt"),
                    row: StoredRow {
                        id: U16::from_utf8("d-1"),
                        version: f64::from_bits(0x3ff0000000000000),
                        created: f64::from_bits(0x408f400000000000),
                        updated: f64::from_bits(0x408f400000000000),
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("deliveryId"),
                                Value::Str(U16::from_utf8("d-1")),
                            ),
                            (
                                U16::from_utf8("revision"),
                                Value::Num(f64::from_bits(0x4008000000000000)),
                            ),
                            (
                                U16::from_utf8("status"),
                                Value::Str(U16::from_utf8("pending")),
                            ),
                            (U16::from_utf8("result"), Value::Null),
                            (U16::from_utf8("error"), Value::Null),
                            (
                                U16::from_utf8("contentRef"),
                                Value::Num(f64::from_bits(0x4415af1d78b58c40)),
                            ),
                            (U16::from_utf8("resultExpiresAtMs"), Value::Null),
                        ])),
                    },
                    id: None,
                },
            ],
        })
        .unwrap_err();
        assert_eq!(error.name, "StateError");
        assert_eq!(
            error.message,
            "Receipt join: work.receipt.contentRef must be a non-empty string or null."
        );
        assert_eq!(error.code, Some("validation".to_owned()));
    }
    #[test]
    fn caller_59() {
        let error = assert_receipt_join(&CommitBatch {
            outbox: vec![],
            writes: vec![
                DomainWrite {
                    kind: WriteKind::Insert,
                    model: U16::from_utf8("work.receipt_association"),
                    row: StoredRow {
                        id: U16::from_utf8("receipt-assoc/v1/m/r/f"),
                        version: f64::from_bits(0x3ff0000000000000),
                        created: f64::from_bits(0x408f400000000000),
                        updated: f64::from_bits(0x408f400000000000),
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("recordModel"),
                                Value::Str(U16::from_utf8("m")),
                            ),
                            (U16::from_utf8("recordId"), Value::Str(U16::from_utf8("r"))),
                            (U16::from_utf8("field"), Value::Str(U16::from_utf8("f"))),
                            (
                                U16::from_utf8("deliveryId"),
                                Value::Str(U16::from_utf8("d-1")),
                            ),
                            (U16::from_utf8("source"), Value::Str(U16::from_utf8("s"))),
                            (
                                U16::from_utf8("revision"),
                                Value::Num(f64::from_bits(0x4000000000000000)),
                            ),
                        ])),
                    },
                    id: None,
                },
                DomainWrite {
                    kind: WriteKind::Insert,
                    model: U16::from_utf8("work.receipt"),
                    row: StoredRow {
                        id: U16::from_utf8("d-1"),
                        version: f64::from_bits(0x3ff0000000000000),
                        created: f64::from_bits(0x408f400000000000),
                        updated: f64::from_bits(0x408f400000000000),
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("deliveryId"),
                                Value::Str(U16::from_utf8("d-1")),
                            ),
                            (
                                U16::from_utf8("revision"),
                                Value::Num(f64::from_bits(0x4008000000000000)),
                            ),
                            (
                                U16::from_utf8("status"),
                                Value::Str(U16::from_utf8("pending")),
                            ),
                            (U16::from_utf8("result"), Value::Null),
                            (U16::from_utf8("error"), Value::Null),
                            (
                                U16::from_utf8("contentRef"),
                                Value::Num(f64::from_bits(0x7ff8000000000000)),
                            ),
                            (U16::from_utf8("resultExpiresAtMs"), Value::Null),
                        ])),
                    },
                    id: None,
                },
            ],
        })
        .unwrap_err();
        assert_eq!(error.name, "StateError");
        assert_eq!(
            error.message,
            "Receipt join: work.receipt.contentRef must be a non-empty string or null."
        );
        assert_eq!(error.code, Some("validation".to_owned()));
    }
    #[test]
    fn caller_63() {
        let error = assert_receipt_join(&CommitBatch {
            outbox: vec![],
            writes: vec![
                DomainWrite {
                    kind: WriteKind::Insert,
                    model: U16::from_utf8("work.receipt_association"),
                    row: StoredRow {
                        id: U16::from_utf8("receipt-assoc/v1/m/r/f"),
                        version: f64::from_bits(0x3ff0000000000000),
                        created: f64::from_bits(0x408f400000000000),
                        updated: f64::from_bits(0x408f400000000000),
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("recordModel"),
                                Value::Str(U16::from_utf8("m")),
                            ),
                            (U16::from_utf8("recordId"), Value::Str(U16::from_utf8("r"))),
                            (U16::from_utf8("field"), Value::Str(U16::from_utf8("f"))),
                            (
                                U16::from_utf8("deliveryId"),
                                Value::Str(U16::from_utf8("d-1")),
                            ),
                            (U16::from_utf8("source"), Value::Str(U16::from_utf8("s"))),
                            (
                                U16::from_utf8("revision"),
                                Value::Num(f64::from_bits(0x4000000000000000)),
                            ),
                        ])),
                    },
                    id: None,
                },
                DomainWrite {
                    kind: WriteKind::Insert,
                    model: U16::from_utf8("work.receipt"),
                    row: StoredRow {
                        id: U16::from_utf8("d-1"),
                        version: f64::from_bits(0x3ff0000000000000),
                        created: f64::from_bits(0x408f400000000000),
                        updated: f64::from_bits(0x408f400000000000),
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("deliveryId"),
                                Value::Str(U16::from_utf8("d-1")),
                            ),
                            (
                                U16::from_utf8("revision"),
                                Value::Num(f64::from_bits(0x4008000000000000)),
                            ),
                            (
                                U16::from_utf8("status"),
                                Value::Str(U16::from_utf8("pending")),
                            ),
                            (U16::from_utf8("result"), Value::Null),
                            (U16::from_utf8("error"), Value::Null),
                            (
                                U16::from_utf8("contentRef"),
                                Value::Num(f64::from_bits(0x7ff0000000000000)),
                            ),
                            (U16::from_utf8("resultExpiresAtMs"), Value::Null),
                        ])),
                    },
                    id: None,
                },
            ],
        })
        .unwrap_err();
        assert_eq!(error.name, "StateError");
        assert_eq!(
            error.message,
            "Receipt join: work.receipt.contentRef must be a non-empty string or null."
        );
        assert_eq!(error.code, Some("validation".to_owned()));
    }
    #[test]
    fn caller_67() {
        let error = assert_receipt_join(&CommitBatch {
            outbox: vec![],
            writes: vec![
                DomainWrite {
                    kind: WriteKind::Insert,
                    model: U16::from_utf8("work.receipt_association"),
                    row: StoredRow {
                        id: U16::from_utf8("receipt-assoc/v1/m/r/f"),
                        version: f64::from_bits(0x3ff0000000000000),
                        created: f64::from_bits(0x408f400000000000),
                        updated: f64::from_bits(0x408f400000000000),
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("recordModel"),
                                Value::Str(U16::from_utf8("m")),
                            ),
                            (U16::from_utf8("recordId"), Value::Str(U16::from_utf8("r"))),
                            (U16::from_utf8("field"), Value::Str(U16::from_utf8("f"))),
                            (
                                U16::from_utf8("deliveryId"),
                                Value::Str(U16::from_utf8("d-1")),
                            ),
                            (U16::from_utf8("source"), Value::Str(U16::from_utf8("s"))),
                            (
                                U16::from_utf8("revision"),
                                Value::Num(f64::from_bits(0x4000000000000000)),
                            ),
                        ])),
                    },
                    id: None,
                },
                DomainWrite {
                    kind: WriteKind::Insert,
                    model: U16::from_utf8("work.receipt"),
                    row: StoredRow {
                        id: U16::from_utf8("d-1"),
                        version: f64::from_bits(0x3ff0000000000000),
                        created: f64::from_bits(0x408f400000000000),
                        updated: f64::from_bits(0x408f400000000000),
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("deliveryId"),
                                Value::Str(U16::from_utf8("d-1")),
                            ),
                            (
                                U16::from_utf8("revision"),
                                Value::Num(f64::from_bits(0x4008000000000000)),
                            ),
                            (
                                U16::from_utf8("status"),
                                Value::Str(U16::from_utf8("pending")),
                            ),
                            (U16::from_utf8("result"), Value::Null),
                            (U16::from_utf8("error"), Value::Null),
                            (
                                U16::from_utf8("contentRef"),
                                Value::Num(f64::from_bits(0xfff0000000000000)),
                            ),
                            (U16::from_utf8("resultExpiresAtMs"), Value::Null),
                        ])),
                    },
                    id: None,
                },
            ],
        })
        .unwrap_err();
        assert_eq!(error.name, "StateError");
        assert_eq!(
            error.message,
            "Receipt join: work.receipt.contentRef must be a non-empty string or null."
        );
        assert_eq!(error.code, Some("validation".to_owned()));
    }
    #[test]
    fn caller_71() {
        let error = assert_receipt_join(&CommitBatch {
            outbox: vec![],
            writes: vec![
                DomainWrite {
                    kind: WriteKind::Insert,
                    model: U16::from_utf8("work.receipt_association"),
                    row: StoredRow {
                        id: U16::from_utf8("receipt-assoc/v1/m/r/f"),
                        version: f64::from_bits(0x3ff0000000000000),
                        created: f64::from_bits(0x408f400000000000),
                        updated: f64::from_bits(0x408f400000000000),
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("recordModel"),
                                Value::Str(U16::from_utf8("m")),
                            ),
                            (U16::from_utf8("recordId"), Value::Str(U16::from_utf8("r"))),
                            (U16::from_utf8("field"), Value::Str(U16::from_utf8("f"))),
                            (
                                U16::from_utf8("deliveryId"),
                                Value::Str(U16::from_utf8("d-1")),
                            ),
                            (U16::from_utf8("source"), Value::Str(U16::from_utf8("s"))),
                            (
                                U16::from_utf8("revision"),
                                Value::Num(f64::from_bits(0x4000000000000000)),
                            ),
                        ])),
                    },
                    id: None,
                },
                DomainWrite {
                    kind: WriteKind::Insert,
                    model: U16::from_utf8("work.receipt"),
                    row: StoredRow {
                        id: U16::from_utf8("d-1"),
                        version: f64::from_bits(0x3ff0000000000000),
                        created: f64::from_bits(0x408f400000000000),
                        updated: f64::from_bits(0x408f400000000000),
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("deliveryId"),
                                Value::Str(U16::from_utf8("d-1")),
                            ),
                            (
                                U16::from_utf8("revision"),
                                Value::Num(f64::from_bits(0x4008000000000000)),
                            ),
                            (
                                U16::from_utf8("status"),
                                Value::Str(U16::from_utf8("pending")),
                            ),
                            (U16::from_utf8("result"), Value::Null),
                            (U16::from_utf8("error"), Value::Null),
                            (
                                U16::from_utf8("contentRef"),
                                Value::Obj(Rc::new(vec![
                                    (
                                        U16::from_utf8("1"),
                                        Value::Num(f64::from_bits(0x7ff0000000000000)),
                                    ),
                                    (
                                        U16::from_utf8("2"),
                                        Value::Num(f64::from_bits(0xc415af1d78b58c40)),
                                    ),
                                    (
                                        U16::from_utf8("z"),
                                        Value::Arr(Rc::new(vec![
                                            Value::Num(f64::from_bits(0x4415af1d78b58c40)),
                                            Value::Num(f64::from_bits(0x7ff8000000000000)),
                                        ])),
                                    ),
                                ])),
                            ),
                            (U16::from_utf8("resultExpiresAtMs"), Value::Null),
                        ])),
                    },
                    id: None,
                },
            ],
        })
        .unwrap_err();
        assert_eq!(error.name, "StateError");
        assert_eq!(
            error.message,
            "Receipt join: work.receipt.contentRef must be a non-empty string or null."
        );
        assert_eq!(error.code, Some("validation".to_owned()));
    }
}

// Selected-call dispatch lives in decisions/call.rs; this conformance module
// reuses it so the native observer and the Wasm ABI execute one dispatch.
use crate::decisions::call as shared;

#[test]
#[ignore = "run by registered-differential.mjs with private original fixture inputs"]
fn shared_original_observer() {
    let path = std::env::var("CAN_WORK_SHARED_FIXTURE")
        .expect("finite differential fixture must be supplied");
    let fixture: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let observations: Vec<_> = fixture
        .as_array()
        .unwrap()
        .iter()
        .map(shared::observe)
        .collect();
    assert!(!observations.is_empty());
    println!(
        "CAN_WORK_SHARED={}",
        serde_json::to_string(&observations).unwrap()
    );
}
