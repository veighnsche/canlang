# Independent run accounting

The frozen suite log hashes to `f4a8c2d6a2bdf0019f7476599ba078c4d5f206ab56fd8b358c23495182a8f5d3`. Its 66 `Running` test-binary lines yielded 67 result summaries, including doc tests: 65 summaries contained tests and two were empty. The aggregate is 1,154 passed, 0 failed, 0 ignored. The only explicit body skip is `SKIP mode 4750: this host did not retain the requested fixture bits`.

The matching strict clippy receipt reports exit 0; its log SHA-256 is `518d5fe74679d9efcf335d7fac32ca33ae068213da6ea85ed0121a1b49866317`, and the selected source pins match current bytes.

Independent file discovery and hashing found no added, removed, or changed files in the 121 compiler inputs, 1,770 package dist/manifest inputs, or five frozen external `.can` fixtures. Manifest entry paths resolve from the repository root; receipt-relative paths resolve from the attempt directory named in the JSON record.

Git HEAD moved from `0134ebb01b978831e07e6428bd15512de75e610a` to `06bc25d1dd12fec6bd1f66502f93b09dddab1b06` during the run, while those frozen file inventories remained stable. The aggregate suite skipped its native mode-4750 fixture body. A separate completed unsandboxed qualification exercised all five modes, including 04750; it remains separate and is not added to the aggregate suite counters. This is finite run accounting, not a broader semantic-completion claim.
