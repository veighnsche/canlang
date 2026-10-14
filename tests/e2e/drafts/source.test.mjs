import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readDraftSource } from "./source.ts";

test("lexical page states preserve canonical workflows and follow priority action bindings", t => {
  const directory = mkdtempSync(path.join(tmpdir(), "can-draft-source-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "ActionStates.can");
  writeFileSync(source, `app ActionStates uses=[actions]
package actions
 Then
  page /operations
   require members
   primary "Create" action=Record.create
   secondary "Delete" action=Record.delete arguments={record=row}
  page /inline
   form save display=inline
    primary "Save" submit=true
  page /primary-dialog
   primary "Open" opens=detail
  page /secondary-dialog
   secondary "Open" opens=detail
  page /navigation
   primary "Open file" target=row.file
  page /secondary-navigation
   secondary "Open file" target=row.file
  page /caption-only
   primary "Caption mentions action=save and opens=detail" target=row.file
  page /legacy
   edit
   delete
   form save
   modal "Detail" id=detail
    text "Content"
`);
  const inventory = readDraftSource(source);
  const states = Object.fromEntries(inventory.pages.map(page => [page.route, page.requiredStates]));
  assert.deepEqual(states, {
    "/operations": ["initial", "validation", "pending", "success", "menu-open", "denied"],
    "/inline": ["initial", "validation", "pending", "success"],
    "/primary-dialog": ["initial", "dialog-open"],
    "/secondary-dialog": ["initial", "menu-open", "dialog-open"],
    "/navigation": ["initial"],
    "/secondary-navigation": ["initial", "menu-open"],
    "/caption-only": ["initial"],
    "/legacy": ["initial", "validation", "pending", "success", "dialog-open"],
  });
  assert.deepEqual(inventory.pages[0].guards, ["members"]);
});
