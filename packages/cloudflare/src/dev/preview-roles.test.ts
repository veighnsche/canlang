import assert from "node:assert/strict";
import test from "node:test";
import { parsePreviewRoles, resolvePreviewRoles } from "./preview-roles.js";

const definition = { policy: { roles: ["CanPromptLab.curator"] },
  packages: { CanPromptLab: { roles: { curator: { id: "CanPromptLab.curator" } } } } };

test("preview roles default to no grants and resolve only declared canonical roles", () => {
  assert.deepEqual(Object.keys(parsePreviewRoles({})), []);
  assert.deepEqual(Object.keys(resolvePreviewRoles(parsePreviewRoles({}), undefined)), []);
  assert.deepEqual(resolvePreviewRoles(parsePreviewRoles({ Ava: ["curator"] }), definition).Ava, ["CanPromptLab.curator"]);
  assert.deepEqual(resolvePreviewRoles(parsePreviewRoles({ Ben: ["CanPromptLab.curator"] }), definition).Ben, ["CanPromptLab.curator"]);
  for (const input of [null, [], { Unknown: ["curator"] }, { Ava: "curator" }, { Ava: ["curator", "curator"] }]) {
    assert.throws(() => parsePreviewRoles(input));
  }
  for (const role of ["owner", "missing", "Foreign.curator"]) {
    assert.throws(() => resolvePreviewRoles(parsePreviewRoles({ Ava: [role] }), definition));
  }
  assert.throws(() => resolvePreviewRoles(parsePreviewRoles({ Ava: ["curator", "CanPromptLab.curator"] }), definition));
  const ambiguous = { policy: { roles: ["One.curator", "Two.curator"] }, packages: {
    One: { roles: { curator: { id: "One.curator" } } }, Two: { roles: { curator: { id: "Two.curator" } } },
  } };
  assert.throws(() => resolvePreviewRoles(parsePreviewRoles({ Ava: ["curator"] }), ambiguous));
});
