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

// Test-only observer. The dynamic original fixture is selected by the finite
// differential runner; no environment or filesystem authority enters a leaf.
mod shared {
    use crate::decisions::{every, lifecycle, linkage, receipt, recovery, retry, rows};
    use serde_json::{json, Value as J};
    use std::cell::Cell;
    use std::rc::Rc;

    pub fn text(v: &J) -> Vec<u16> {
        v.as_array()
            .or_else(|| v["$u16"].as_array())
            .expect("UTF16 channel")
            .iter()
            .map(|x| u16::try_from(x.as_u64().unwrap()).unwrap())
            .collect()
    }
    fn ascii(v: &J) -> String {
        String::from_utf16(&text(v)).unwrap()
    }
    fn field<'a>(v: &'a J, key: &str) -> &'a J {
        v["$entries"]
            .as_array()
            .expect("ordered entries channel")
            .iter()
            .find(|entry| text(&entry[0]) == key.encode_utf16().collect::<Vec<_>>())
            .map(|entry| &entry[1])
            .unwrap_or(&J::Null)
    }
    fn number(v: &J) -> f64 {
        f64::from_bits(
            u64::from_str_radix(v["$bits"].as_str().expect("f64 bit channel"), 16).unwrap(),
        )
    }
    fn string(v: &[u16]) -> J {
        json!({"$u16":v})
    }
    fn n(v: f64) -> J {
        json!({"$bits":format!("{:016x}",v.to_bits())})
    }
    fn object(v: Vec<(&str, J)>) -> J {
        json!({"$entries":v.into_iter().map(|(key,value)|json!([key.encode_utf16().collect::<Vec<_>>(),value])).collect::<Vec<_>>()})
    }
    fn ok(v: J) -> J {
        json!({"ok":v})
    }
    fn fault(name: &str, message: &str, code: Option<&str>, scope: Option<&[u16]>) -> J {
        json!({"throw": {"name":string(&name.encode_utf16().collect::<Vec<_>>()),
            "message":string(&(if name=="URIError" {"engine-variable"} else {message}).encode_utf16().collect::<Vec<_>>()),
            "codePresent":code.is_some(),"code":code.map(|x|string(&x.encode_utf16().collect::<Vec<_>>())).unwrap_or(json!({"$undefined":true})),
            "scopePresent":scope.is_some(),"scope":scope.map(string).unwrap_or(json!({"$undefined":true}))}})
    }
    // Finite data-only observer graph. Its wire parser rejects unsupported
    // channels instead of silently materializing exotic original objects.
    fn rows_value(v: &J) -> rows::Value {
        if v.is_null() {
            return rows::Value::Null;
        }
        if let Some(b) = v.as_bool() {
            return rows::Value::Bool(b);
        }
        if v.get("$bits").is_some() {
            return rows::Value::Num(number(v));
        }
        if v.get("$u16").is_some() {
            return rows::Value::Str(rows::U16(text(v)));
        }
        if let Some(a) = v.as_array() {
            return rows::Value::Arr(Rc::new(a.iter().map(rows_value).collect()));
        }
        rows::Value::Obj(Rc::new(
            v["$entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| (rows::U16(text(&e[0])), rows_value(&e[1])))
                .collect(),
        ))
    }
    fn receipt_value(v: &J) -> receipt::Value {
        if v.get("$undefined").is_some() {
            return receipt::Value::Undef;
        }
        if v.is_null() {
            return receipt::Value::Null;
        }
        if let Some(b) = v.as_bool() {
            return receipt::Value::Bool(b);
        }
        if v.get("$bits").is_some() {
            return receipt::Value::Num(number(v));
        }
        if v.get("$u16").is_some() {
            return receipt::Value::Str(receipt::U16(text(v)));
        }
        if let Some(a) = v.as_array() {
            return receipt::Value::Arr(Rc::new(a.iter().map(receipt_value).collect()));
        }
        receipt::Value::Obj(Rc::new(
            v["$entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| (receipt::U16(text(&e[0])), receipt_value(&e[1])))
                .collect(),
        ))
    }
    fn linkage_value(v: &J) -> linkage::Value {
        if v.is_null() {
            return linkage::Value::Null;
        }
        if let Some(b) = v.as_bool() {
            return linkage::Value::Bool(b);
        }
        if v.get("$bits").is_some() {
            return linkage::Value::Num(number(v));
        }
        if v.get("$u16").is_some() {
            return linkage::Value::Str(linkage::U16(text(v)));
        }
        if let Some(a) = v.as_array() {
            return linkage::Value::Arr(Rc::new(a.iter().map(linkage_value).collect()));
        }
        linkage::Value::Obj(Rc::new(
            v["$entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| (linkage::U16(text(&e[0])), linkage_value(&e[1])))
                .collect(),
        ))
    }
    fn lifecycle_value(v: &J) -> lifecycle::Value {
        if v.is_null() {
            return lifecycle::Value::Null;
        }
        if let Some(b) = v.as_bool() {
            return lifecycle::Value::Bool(b);
        }
        if v.get("$bits").is_some() {
            return lifecycle::Value::Num(number(v));
        }
        if v.get("$u16").is_some() {
            return lifecycle::Value::Str(lifecycle::U16(text(v)));
        }
        if let Some(a) = v.as_array() {
            return lifecycle::Value::Arr(a.iter().map(lifecycle_value).collect());
        }
        lifecycle::Value::Obj(
            v["$entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| (lifecycle::U16(text(&e[0])), lifecycle_value(&e[1])))
                .collect(),
        )
    }
    fn lifecycle_observe(v: &lifecycle::Value) -> J {
        match v {
            lifecycle::Value::Null => J::Null,
            lifecycle::Value::Bool(b) => json!(b),
            lifecycle::Value::Num(x) => n(*x),
            lifecycle::Value::Str(s) => string(&s.0),
            lifecycle::Value::Arr(a) => json!(a.iter().map(lifecycle_observe).collect::<Vec<_>>()),
            lifecycle::Value::Obj(o) => {
                json!({"$entries":o.iter().map(|(k,v)|json!([k.0,lifecycle_observe(v)])).collect::<Vec<_>>() })
            }
            lifecycle::Value::Map(_) | lifecycle::Value::Set(_) => {
                panic!("unsupported sample output channel")
            }
        }
    }
    fn lifecycle_item(v: &J) -> lifecycle::OutboxItem {
        lifecycle::OutboxItem {
            id: lifecycle::U16(text(field(v, "id"))),
            operation_id: lifecycle::U16(text(field(v, "operationId"))),
            source: lifecycle::U16(text(field(v, "source"))),
            occurrence_index: number(field(v, "occurrenceIndex")),
            request: lifecycle_value(field(v, "request")),
            origin_occurrence: (!field(v, "originOccurrence").is_null())
                .then(|| lifecycle::U16(text(field(v, "originOccurrence")))),
            attempts: number(field(v, "attempts")),
            state: lifecycle::U16(text(field(v, "state"))),
        }
    }
    fn item_observe(v: &lifecycle::OutboxItem) -> J {
        object(vec![
            ("id", string(&v.id.0)),
            ("operationId", string(&v.operation_id.0)),
            ("source", string(&v.source.0)),
            ("occurrenceIndex", n(v.occurrence_index)),
            ("request", lifecycle_observe(&v.request)),
            (
                "originOccurrence",
                v.origin_occurrence
                    .as_ref()
                    .map(|x| string(&x.0))
                    .unwrap_or(J::Null),
            ),
            ("attempts", n(v.attempts)),
            ("state", string(&v.state.0)),
        ])
    }
    fn error_observe(v: &Option<lifecycle::ReceiptError>) -> J {
        v.as_ref()
            .map(|x| {
                object(vec![
                    ("code", string(&x.code.0)),
                    ("message", string(&x.message.0)),
                ])
            })
            .unwrap_or(J::Null)
    }
    fn rows_row(v: &J) -> rows::StoredRow {
        rows::StoredRow {
            id: rows::U16(text(field(v, "id"))),
            version: number(field(v, "version")),
            created: number(field(v, "created")),
            updated: number(field(v, "updated")),
            created_by: rows::U16(text(field(v, "createdBy"))),
            updated_by: rows::U16(text(field(v, "updatedBy"))),
            archived_at: rows_value(field(v, "archivedAt")),
            parent: rows_value(field(v, "parent")),
            data: rows_value(field(v, "data")),
        }
    }
    fn linkage_row(v: &J) -> linkage::StoredRow {
        linkage::StoredRow {
            id: linkage::U16(text(field(v, "id"))),
            version: number(field(v, "version")),
            created: number(field(v, "created")),
            updated: number(field(v, "updated")),
            created_by: linkage::U16(text(field(v, "createdBy"))),
            updated_by: linkage::U16(text(field(v, "updatedBy"))),
            archived_at: linkage_value(field(v, "archivedAt")),
            parent: linkage_value(field(v, "parent")),
            data: linkage_value(field(v, "data")),
        }
    }
    struct Fixed {
        sample: f64,
        calls: Rc<Cell<u64>>,
    }
    impl retry::RandomPort for Fixed {
        fn next_unit(&self) -> f64 {
            self.calls.set(self.calls.get() + 1);
            self.sample
        }
    }

    pub fn observe(c: &J) -> J {
        let args = c["args"].as_array().unwrap();
        let calls = Rc::new(Cell::new(0));
        let outcome = match (c["leaf"].as_str().unwrap(), c["fn"].as_str().unwrap()) {
            ("rows", "readSupersessionRow") => {
                match rows::read_supersession_row(&rows_row(&args[0])) {
                    Ok(v) => ok(object(vec![
                        ("outboxId", string(&v.outbox_id.0)),
                        (
                            "byOccurrenceId",
                            v.by_occurrence_id
                                .as_ref()
                                .map(|s| string(&s.0))
                                .unwrap_or(J::Null),
                        ),
                        ("markedAtMs", n(v.marked_at_ms)),
                    ])),
                    Err(e) => fault(&e.name, &e.message, e.code.as_deref(), None),
                }
            }
            ("rows", "everySlotRowId") => match rows::every_slot_row_id(
                &rows::U16(text(&args[0])),
                &rows::U16(text(&args[1])),
                &rows::U16(text(&args[2])),
                &rows::U16(text(&args[3])),
            ) {
                Ok(v) => ok(string(&v.0)),
                Err(e) => fault(&e.name, &e.message, e.code.as_deref(), None),
            },
            ("retry", "computeBackoff") => {
                let v = &args[0];
                let policy = field(v, "policy");
                let input = retry::BackoffInput {
                    attempt: number(field(v, "attempt")),
                    first_attempt_at_ms: number(field(v, "firstAttemptAtMs")),
                    now_ms: number(field(v, "nowMs")),
                    policy: (!policy.is_null()).then(|| retry::RetryPolicy {
                        max_attempts: number(field(policy, "maxAttempts")),
                        horizon_ms: number(field(policy, "horizonMs")),
                    }),
                    random: Fixed {
                        sample: number(field(field(v, "random"), "$randomSample")),
                        calls: calls.clone(),
                    },
                };
                match retry::compute_backoff(&input) {
                    Ok(v) => ok(object(vec![
                        ("exhausted", json!(v.exhausted)),
                        ("delayMs", n(v.delay_ms)),
                        ("notBeforeMs", n(v.not_before_ms)),
                    ])),
                    Err(e) => fault(&e.name, &e.message, None, None),
                }
            }
            ("every", "computeEverySlot") => {
                match every::compute_every_slot(number(&args[0]), number(&args[1])) {
                    Ok(v) => ok(object(vec![
                        ("slot", n(v.slot)),
                        ("slotStartMs", n(v.slot_start_ms)),
                    ])),
                    Err(e) => fault(
                        &e.name,
                        &e.message,
                        e.code.as_deref(),
                        e.scope.as_ref().map(|s| s.0.as_slice()),
                    ),
                }
            }
            ("lifecycle", "reconcileUncertain") => {
                let item = lifecycle_item(&args[0]);
                let v = &args[1];
                let evidence = if v.is_null() {
                    None
                } else {
                    Some(match ascii(field(v, "kind")).as_str() {
                        "delivered" => lifecycle::ReconcileEvidence::Delivered {
                            result: lifecycle_value(field(v, "result")),
                        },
                        "failed" => lifecycle::ReconcileEvidence::Failed {
                            code: lifecycle::U16(text(field(v, "code"))),
                            message: lifecycle::U16(text(field(v, "message"))),
                        },
                        "not-found" => lifecycle::ReconcileEvidence::NotFound,
                        _ => panic!("unsupported fixture evidence"),
                    })
                };
                let v = lifecycle::reconcile_uncertain(&item, &evidence);
                ok(object(vec![
                    ("item", item_observe(&v.item)),
                    ("changed", json!(v.changed)),
                    (
                        "status",
                        v.status.as_ref().map(|s| string(&s.0)).unwrap_or(J::Null),
                    ),
                    ("result", lifecycle_observe(&v.result)),
                    ("error", error_observe(&v.error)),
                ]))
            }
            ("lifecycle", "recordOutcome") => {
                let v = &args[0];
                let raw = field(v, "outcome");
                let policy = field(v, "policy");
                let outcome = match ascii(field(raw, "kind")).as_str() {
                    "delivered" => lifecycle::ProviderOutcome::Delivered {
                        result: lifecycle_value(field(raw, "result")),
                    },
                    "uncertain" => lifecycle::ProviderOutcome::Uncertain,
                    "failed" => {
                        let cause = field(raw, "cause");
                        lifecycle::ProviderOutcome::Failed {
                            cause: match ascii(field(cause, "kind")).as_str() {
                                "handler-require-false" => {
                                    lifecycle::FailureCause::HandlerRequireFalse {
                                        require: lifecycle::U16(text(field(cause, "require"))),
                                    }
                                }
                                "permanent" => lifecycle::FailureCause::Permanent {
                                    code: lifecycle::U16(text(field(cause, "code"))),
                                    message: lifecycle::U16(text(field(cause, "message"))),
                                },
                                "transient" => lifecycle::FailureCause::Transient {
                                    code: lifecycle::U16(text(field(cause, "code"))),
                                    message: lifecycle::U16(text(field(cause, "message"))),
                                },
                                _ => panic!("unsupported cause"),
                            },
                        }
                    }
                    _ => panic!("unsupported outcome"),
                };
                let input = lifecycle::RecordOutcomeInput {
                    item: lifecycle_item(field(v, "item")),
                    outcome,
                    now_ms: number(field(v, "nowMs")),
                    first_attempt_at_ms: number(field(v, "firstAttemptAtMs")),
                    policy: (!policy.is_null()).then(|| lifecycle::RetryPolicy {
                        max_attempts: number(field(policy, "maxAttempts")),
                        horizon_ms: number(field(policy, "horizonMs")),
                    }),
                };
                match lifecycle::record_outcome(&input) {
                    Ok(v) => ok(object(vec![
                        ("item", item_observe(&v.item)),
                        ("status", string(&v.status.0)),
                        ("result", lifecycle_observe(&v.result)),
                        ("error", error_observe(&v.error)),
                        (
                            "retryClass",
                            v.retry_class
                                .as_ref()
                                .map(|s| string(&s.0))
                                .unwrap_or(J::Null),
                        ),
                        ("retryable", json!(v.retryable)),
                    ])),
                    Err(e) => fault(&e.name, &e.message, None, None),
                }
            }
            ("receipt", "isConsistentCompletion") => ok(json!(receipt::is_consistent_completion(
                &receipt_value(&args[0]),
                &receipt_value(&args[1]),
                &receipt_value(&args[2])
            ))),
            ("receipt", "isStoredReceiptPayload") => ok(json!(receipt::is_stored_receipt_payload(
                &receipt_value(&args[0]),
                &receipt_value(&args[1]),
                &receipt_value(&args[2])
            ))),
            ("receipt", "isTerminalReceiptStatus") => ok(json!(
                receipt::is_terminal_receipt_status(&receipt::U16(text(&args[0])))
            )),
            ("recovery", "isClaimStale") => {
                let v = &args[0];
                let claim = recovery::DispatchClaim {
                    outbox_id: recovery::U16(text(field(v, "outboxId"))),
                    claim_id: recovery::U16(text(field(v, "claimId"))),
                    claimed_at: number(field(v, "claimedAt")),
                };
                match recovery::is_claim_stale(&claim, number(&args[1]), number(&args[2])) {
                    Ok(v) => ok(json!(v)),
                    Err(e) => fault(&e.name, &e.message, None, None),
                }
            }
            ("linkage", "assertDispatchJoin") => {
                let v = &args[0];
                let batch = linkage::CommitBatch {
                    outbox: field(v, "outbox")
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|x| linkage::OutboxIntent {
                            intent_id: linkage::U16(text(field(x, "intentId"))),
                        })
                        .collect(),
                    writes: field(v, "writes")
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|x| linkage::DomainWrite {
                            kind: match ascii(field(x, "kind")).as_str() {
                                "insert" => linkage::WriteKind::Insert,
                                "update" => linkage::WriteKind::Update,
                                "remove" => linkage::WriteKind::Remove,
                                _ => panic!("unknown write kind"),
                            },
                            model: linkage::U16(text(field(x, "model"))),
                            row: linkage_row(field(x, "row")),
                            id: (!field(x, "id").is_null())
                                .then(|| linkage::U16(text(field(x, "id")))),
                        })
                        .collect(),
                };
                match linkage::assert_dispatch_join(&batch) {
                    Ok(()) => ok(json!({"$undefined":true})),
                    Err(e) => fault(&e.name, &e.message, e.code.as_deref(), None),
                }
            }
            _ => panic!("unregistered finite observer case"),
        };
        json!({"key":c["key"],"outcome":outcome,"randomCalls":calls.get()})
    }
}

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
