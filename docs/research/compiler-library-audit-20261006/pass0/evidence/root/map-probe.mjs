import { SourceMap } from "node:module";
import { readFileSync } from "node:fs";
import { lookup } from "../../../../../../packages/cloudflare/dist/runtime/sourcemap.js";

const witness = JSON.parse(readFileSync(new URL("../../witnesses/serialization-maps.json", import.meta.url), "utf8")).cases.find(test => test.id === "map_unicode_byte_profile");
const raw = readFileSync(new URL("boundary-observations.txt", import.meta.url), "utf8").split("\n").find(line => line.startsWith("map="));
const produced = JSON.parse(raw.slice(4));
const fixtureMatches = Object.keys(witness.input.map).every(key => JSON.stringify(produced[key]) === JSON.stringify(witness.input.map[key]));
const independent = new SourceMap(produced).findEntry(0, 0);
const consumer = lookup(produced, 1, 0);
const expected = witness.expected;
const matches = fixtureMatches && independent.originalColumn === expected.original_column_0 && independent.originalLine === expected.original_line_0 && consumer.column === expected.can_runtime_column_1 && consumer.line === expected.can_runtime_line_1;
console.log(JSON.stringify({scope:"fresh compiler map builder/serializer -> independent Node decoder -> actual internal Can runtime lookup on authored Unicode fixture; not browser or installed-artifact navigation",node:process.version,produced,fixture_matches:fixtureMatches,independent,consumer,matches_expected:matches},null,2));
if (!matches) process.exitCode = 1;
