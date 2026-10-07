# Qualified raw fragments: accepted bounded choice

Three independently worded, equivalent verified-context consultations chose closed invariants (confidence 0.99, 1.00, 1.00). Requests and complete responses are saved beside this assessment. Advice is not a correctness oracle.

Keep existing String adapters for compiler-owned closed DTOs, expose serialization errors through Serialize/shared Result APIs, and validate pre-rendered fragments before embedding. Invalid manually constructed encoded literals fail serialization or the existing invariant/tool-error boundary; they are not successfully emitted as malformed JSON. No live valid production caller depends on emitting invalid fragments. Public API-wide fallibility and input representation changes are separate work.

RawValue validates JSON syntax and retains exact legal numeric lexemes; it accepts escaped lone surrogates. It is therefore not a Unicode admission validator. This release only embeds qualified compiler-owned fragments whose string producers start from Rust Unicode strings. The input parser, raw-number model/accessors, duplicate-member/depth policies remain unchanged. Permanent tests independently demonstrate these guarantees and their limit.
