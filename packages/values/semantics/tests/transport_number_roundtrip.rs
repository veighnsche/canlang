use values_semantics::transport::exact::handle_line;

#[test]
fn exact_transport_preserves_the_original_number_in_codec_error_text() {
    // This original JSON request formerly parsed as the neighboring f64,
    // even though the formatter itself passed the frozen number corpus.
    let response = handle_line(
        r#"{"v":1,"op":"decode-value","args":[{"t":"str","v":"int"},{"t":"num","v":8.01033661867104e+241}]}"#,
    );
    assert_eq!(response["ok"], false);
    assert_eq!(response["violations"][0]["code"], "type");
    assert_eq!(
        response["violations"][0]["actual"],
        "number 8.01033661867104e+241"
    );
}
