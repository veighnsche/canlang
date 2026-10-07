#!/bin/zsh
set -eu
cd /Users/vince/Projects/canlang
rustc --edition=2021 /private/tmp/canlang-pass8-consumer/current-source-witness.rs --extern canlang_compiler=/private/tmp/canlang-pass8-consumer/pinned/compiler/target/debug/libcanlang_compiler.rlib --extern sha2=compiler/target/debug/deps/libsha2-e16ff241f1973b66.rlib -L dependency=compiler/target/debug/deps -o /private/tmp/canlang-pass8-consumer/current-source-witness 2> /private/tmp/canlang-pass8-consumer/rustc-current-source.log
/private/tmp/canlang-pass8-consumer/current-source-witness > /private/tmp/canlang-pass8-consumer/current-source-map.json 2> /private/tmp/canlang-pass8-consumer/current-source-locations.txt
cmp /private/tmp/canlang-pass8-consumer/current-source-map.json /private/tmp/canlang-pass8-consumer/compiler-map.json
bun /private/tmp/canlang-pass8-consumer/consumer.ts > /private/tmp/canlang-pass8-consumer/consumer-results.json
bun /private/tmp/canlang-pass8-consumer/raw-contract.ts > /private/tmp/canlang-pass8-consumer/raw-contract-results.json
