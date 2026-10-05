# B4 DRAFT-DEFECT fix list — 49 drafts (read-only triage synthesis)

Sources: /tmp/b4-triage-{1,2,3,4}.md. Only D-verdict causes listed. Line refs are triage-cited exemplars, not exhaustive sites.

## Cross-file patterns (fix recipes)

**N1. Nullable receivers/args (~1000 diags: E3003 + nullable E3001/E3002/E3005).** `!=null`/`require x!=null` never narrows (DESIGN:171; CanCheck:68). Recipe: `?.` / `??` / `is`-guard before use; narrow before `set`/call/return. Ex: `row.assignee is user and active_member(row.assignee)`; `(row.due??now)<now`; `trim(x??"")`.
**N2. Bare enum cases (~700 E2001-DD/E3002).** Cases with no typed expectation, or shadowed by same-spelled scenarios/models (binding-first, DESIGN:281; GRAMMAR:486). Recipe: compare against a typed field (`state=confirmed` fixture form, CanEvent:54); rename shadower (`scenario money` CanEvent:378-410, CanRent:1070 `no_show`, CanRent:1404 `released`, CanTime:80 `manual`, `join` CanRefer, `refund/reconcile/receipt` CanInvoice).
**N3. Missing required fields (~350 E3001-miss/E3015-miss/E5001).** Recipe: add the key to the fixture/create literal (CanRefer supply available/earned/owed/paid/partner; CanTable add conflict=/overdue= example inputs).
**N4. `parent`/audit members in selectors (~240 E2013/E5002/E3015/E5008).** `parent` exists only on contained models (DESIGN:99,133,310); id/version/created_* aren't schema. Recipe: declare `Child in Parent` or drop the member; drop `parent` from `fields=`/`columns=` (keep `parent.location`-style leaves).
**N5. Decimal literals (~50 E3011/E3012).** Recipe: `min=0`→`min=0.0`; decimal bounds/defaults as decimals; drop bad `trim`; drop `min=` on arrays (CanLearn).
**N6. Read-only event targets (~35 E3009).** Recipe: only `set event.after`, never `event.before`/`event.after.parent`/`event.*` (CanLeave, CanOnboard, CanRent).
**N7. format/trim overloads (~70 E3005).** Recipe: `format(text,…)`→message descriptor or values obj; narrow `text?` first; `max(a,b)`→`max([a,b])`; `text+text`→`format()`/`join()`; unary `-datetime`→`durationBetween`.
**N8. Purity/roles/misc.** `active_member` in `when=`/derived→move into body `require`; undeclared roles (`billing`×14 CanInvoice, `administrator`, `booker`, `hr`)→declare `role`; `kind=tour`/`status=failed`→quote; `E5008 id/version`→drop override; `E5004 as`→drop; E2017 fixture cycles→break alias; `state=<Record>`→pass a case; mixed arrays→homogenize; `output` shorthand (CanGallery:35)→supply value; server-owned `owner=`→drop; `request`-as-observation (CanLeave, CanPurchase)→use declared observation names; wrong-model members→qualify via owning child (CanExpense:416, CanDiscover:376).

## Per-file fix list (file | D code:count | fix + exemplar)

- CanAffiliate (105): E3003:31 N1 `?.`; E3001:7 narrow `user?`→`user` before role predicates; E3009:4/E3011:1/E3012:2/E2013:2/E3015:1/E3005:1/E3002:1 N4/N5/N6/N8 per message; E2001:10↓ fallout of N1-N4.
- CanApprove (93): E3003:14 N1; E2001:4 `use` proof at :8 — merge Text*→llm `from=`; E3001:1/E2013:7 N3/N4 per message; E2001:3↓ cascade.
- CanBoard (7): E3015:1 N3 supply field; E2001:2↓/E2013:3↓ fallout.
- CanBook (222): E2005:1 `use` add `from=` (:10-11 pattern); E3003:7 N1; E2013:12 N4/N8 (drop phantom audit members from selectors); E3013:5 label cases→typed; E3011:1 N5; E2001:1↓/E3001:1↓ fallout.
- CanCRM (158): E3001:12 N3 narrow/supply; E2005:1/E3015:6/E2013:6/E5001:4/E3002:4/E3003:2/E3011:1/E3009:1 N1/N3-N6 per message; E2001:3↓ fallout.
- CanCatch (104): E3003:17 N1; E3001:9 N3; E2013:6 N4; E3015:4/E3010:1/E3002:1/E2005:1 N3/N8; E2001:3↓/E3001:2↓ fallout.
- CanChat (134): E3003:9 N1; E3001:30↓/E2013:28↓/E3015:10↓/E2001:42↓ N1-N3 cascades; E3013:2 label cases; E3010:1/E3012:1/E3011:1/E3002:1/E2005:1 N5/N8 per message.
- CanCheck (103): E3003:12 N1 (narrowing never fires, :68); E3001:14 N3; E2013:9 N4; E3015:2/E3011:2/E3009:2 N3/N5/N6; E2001:12↓/E3001:5↓/E3015:1↓ fallout.
- CanContract (72): E3001:17 N3; E2013:8 N4; E3015:5/E3011:1/E3009:1/E3003:1 N3-N6; E2001:1 per message.
- CanCreative (195): E2005:2 `from=`; E3003:14 N1; E3001:36↓/E2013:28↓/E3015:23↓ N1-N3 cascades; E3011:7↓ N5 cascade; E3010:2 purity→body `require`.
- CanCustomer (95): E3001:32 N3; E2005:1 `from=`; E3003:5/E3011:1/E3009:1/E2013:1 N1/N4-N6; E2001:7↓ fallout.
- CanDecide (60): E2005:1/E2004:1 `use ChangeReview from=` or local declare; E2001:11↓/E3015:17/E3001:13↓ N1-N3 fallout; E3003:2/E3012:1/E3010:1 N1/N5/N8.
- CanDesk (140): E2001:1 bind name; E2013:1 N4; E3001-miss:25/E3015-miss:10 N3; E3001:4 N3; E3002:4 rename shadower (`scenario note/reply`→`add_note`); E3003:2 N1; E3015:1 N3; E5008:1 drop `id` override.
- CanDiscover (158): E2013:4 N4 + wrong-model members→qualify (:376); E3001-miss:5/E3015-miss:7 N3; E3001:13 N3; E3002:4 N2/N8; E3003:24 N1; E3012:4 N5; E3015:2 N3.
- CanDo (56): E3001-miss:2/E3015-miss:3 N3; E3002:1 N2; E3005:2 N7; E3011:1 N5.
- CanEnrich (46): E2013:1 N4; E3001:3 N3; E3002:1 N2; E3003:13 N1; E3015:1 N3.
- CanEvent (465): E2001:23 rename `scenario money` (:378-410, clears `event` orphans); E2002:1 same; E2013:31 N4 (drop parent/metadata from `fields=`); E3001-miss:11/E3015-miss:19 N3; E3001:4 N3; E3002:1 N2; E3003:22 N1; E3009:9 N6; E3011:1 N5; E3016:5 bind message params; E5004:2 drop `as` in trusted-handler examples; rename `Change`/`expired` shadower.
- CanExpense (107): E2013:6 N4 + Expense→Decision/Reimbursement qualify (:416); E3003:5 N1; E3015:2 N3.
- CanFeedback (26): E3001:4 N3; E3003:7 N1; E3011:1 N5; E3015-miss:2 N3.
- CanField (116): E2013:2 N4; E3001:5 N3; E3003:7 N1; E3005:1 N7; E3011:1 N5; E3015-miss:2 N3.
- CanGallery (32): E2001:2 bind (`scenario approved`→`list_approved`); E2013:6 N4; E3001:5 N3; E3002:3 E3002 shadowing/order; E3005:1 N7; E3010:2 purity→body `require`; :35 `output` shorthand→supply value; :15 `person!=null and …`→`is`-guard.
- CanGrant (89): E2001:4 bind; E2017:1 break fixture cycle (clears `submitted`×4); E3001-miss:7/E3015-miss:8 N3; E3001:3 N3; E3003:6 N1; E3005:2 N7; E3011:1 N5; E3015:2 N3.
- CanHire (146): E3001-miss:4/E3015-miss:5 N3; E3001:4 N3; E3002:4 rename `scenario released`; E3005:1 N7; E3009:1 N6; E3011:1 N5.
- CanInbox (182): E2013:4 N4; E3001-miss:11/E3015-miss:7 N3; E3001:3 N3; E3003:17 N1; E3005:1 N7; E3012:2 N5; prefs-`location`→nullable/constant default.
- CanInvoice (615): E2001:38 declare `role billing` (×14), type bare `issued`/`collection`/`reversed`; E3001:132 N1/N3; E3003:107 N1; E2013:29 N4 (`Child in Parent` or drop); E3015:22 N3 incl. bad owner `history_user`; E3002:16 rename `refund`/`reconcile`/`receipt` collision + `text+text`→`format`; E3013:10 label cases; E3005:3 N7; E3011:2/E3012:1 N5; E5006:1 drop bare `as`.
- CanKnowledge (102): E2001:13 add bound import for bare `Handbook`; E3001:27 narrow `person: user?` (×12); E3015:19 N3; E2013:14 N4; E3003:9 N1; E3010:3 purity; E3011:1 N5.
- CanLearn (55): E3003:3 N1; E3001:5 narrow `account`, supply progress; E3012:2 drop `min=` on array; E3002:2 nullable date order, Lesson==Enrollment→same-type compare; E2013:2 read title/content via Lesson; E3015:1/E3013:1/E3011:1 N3/N5/N8 (static title, constant location).
- CanLeave (91): E2001:18 type bare succeeded/confirmed/released/failed; E2013:19 N4 (Calendar ×17, Allowance ×2); E5002:6 use declared observation names, drop `parent`; E3015:9 supply year/remaining, drop `parent=`; E3001:6/E3003:4 N1/N3; E3009:4 N6.
- CanLoyalty (121): E2001:9 bind completed/reversed/rewards/history; E3003:29 N1; E3001:11 N3; E2013:7 correct Account members + drop Redemption parent; E3015:6 N3; E3005:3 N7 narrow/scalar; E3013:2/E3011:1 N5/N8.
- CanMail (234): E2001:26 type bare succeeded/failed/unknown/skipped/received/notified/confirmed, declare `role administrator`; E3001:49 N3; E3003:45 N1; E2013:17 N4 (Service ×11) + correct names; E3005:11 N7 (`??`/narrow); E3015:5/E3013:5/E3011:1 N3/N5/N8; E2017:1 break parcel cycle.
- CanMaintain (178): E2001:28 type bare succeeded/failed/confirmed/pending/released; E3001:63 N3 per site; E3003:6 N1; E3013:5 label cases; E3015:4 N3; E3005:3 N7; E3011:1/E3002:1 N5/N2.
- CanMember (528): E2001:101 declare roles (administrator/booker/billing), type bare paid/hour/day/released/consumed/staged/reserved, drop invalid `row`; E3001:125 N3; E3003:81 N1; E3015:23 N3; E2013:17 N4 (Membership ×12); E3002:9 N2; E3011:3/E3013:1/E3012:1/E3009:1/E3005:1 N5-N7.
- CanOnboard (67): E2001:5 bind unfinished/overdue/induction/equipment/staff-case; E2013:9 N4 (Checklist); E3001:6/E3015:5 supply total_steps/progress/completed_steps, drop `parent=`; E3009:3 N6; E3013:1/E3011:1 N5/N8; E3010:1 purity.
- CanPropose (182): E2001:59 type bare succeeded/failed/confirmed/pending/hold/booking/releasing; E3001:45 N3; E3003:7 N1; E3015:7/E3011:5/E3012:1 N3/N5 (decimal literals); E3002:5 N2; E2013:5 N4 (Proposal); E5008:2 drop `version`; E3009:2/E3005:2 N6/N7.
- CanPurchase (196): E2001:21 type bare succeeded/failed/confirmed/pending/part_received; E3003:32 narrow Return?/Receipt?/Payable?; E3001:13 N3; E3015:7 N3; E5002:5 declared observation names; E2013:3 N4 (Line); E3011:2 N5; E3013:1 label case.
- CanReception (238): E2001:33 bind expected/invited/arrived/active, declare administrator/booker, type bare succeeded/…; E3001:58 N3; E2013:16 N4 (Visit ×10); E3003:14 N1; E3015:5/E3013:5/E3011:1 N3/N5/N8; E3002:3/E3009:2 N2/N6.
- CanRefer (132): E2001:10 type bare reversed/completed/program/cancellation_passed; E2002:1 rename `scenario join`→`join_program`; E3003:39 N1; E3001:14 drop `parent=` on Capture + mismatches; E3015:7 supply available/earned/owed/paid/partner; E2013:5 N4 (Advocate/Capture) + drop `value.*`-into-opaque; E3005:4 N7 narrow + closed Display obj.
- CanRent (932): E2001:210 type bare cases, rename `no_show` (:1070), `released` (:1404); E2002:1 rename `scenario money`; E3003:70 N1; E3001:295 `construct X {…}`, call derived fns, `text+text`→`format()`; E2013:16 N4 (drop parent ×5, reserved created/… ×10); E3002:17 `??`/narrow; E3005:15 N7 (`max([a,b])`, flatten, non-callable); E3009:12 N6; E3015:14 N3 + `parent=` only on contained; E3011:10/E3012:4 N5.
- CanReport (52): E2001:11 type bare fresh/succeeded/failed/`booked_minutes` or declare; E3003:14 N1; E3001:7 N3; E3015:3 supply rows, fix state/checkpoint; E5008:2 drop server-owned `parent=`; E3005:1 narrow `money?` before sum; E2017:1 break `unavailable` alias cycle.
- CanShift (4): no D causes (body unchecked — see proposals/GAPs).
- CanStats (82): E3003:33 N1; E3001:26 incl. set-on-nullable ×7→narrow first; E2001:12 bind bare cases, add `use` for WebJobs/WebDimensions/stats.WebEvent; E3012:6 N5; E3002:2 N2; E2013:2 drop `parent` from unique; E3010:1 declare WebJobs event or drop handler.
- CanStock (125): E2001:24 type bare failed/confirmed/pending; E3001:34 construct typed `value` (object-vs-opaque ×10); E3003:26 N1; E3015:4 supply total/low; E2013:4 add quantity/reason/location/source to Item.
- CanSuccess (107): E2001:3 declare `earlier`; E3001:39 schedule/cancel keys as text/datetime; E2013:9 N4 (drop parent ×4, reserved ×5); E3015:6 N3; E3005:4 N7 (`format(text,null)`→message descriptor; narrow `trim(text?)`).
- CanSync (75): E3003:33 N1; E2001:11 type bare cases, bind `value` in form arguments; E3001:11 N3; E3015:10 construct typed Observation/Values/Snapshot/delivery; E2013:4 drop `created` ×2 from `columns=`, let-bind then `set` parent ×2.
- CanTable (53): E3001:3 narrow Table?/datetime?; E3015:6 supply conflict/overdue; E3002:6 N2; E3003:4 N1; E5001:2 add conflict=/overdue= example inputs; E3005:1 narrow datetime? for `overlaps`.
- CanTime (147): E2001:13 type bare superseded/succeeded/…; E2013:22 N4 — `in Employee` rejected (E2008), use reference field; add derive Entry.location (project.location ×2); E3001:38 rename `scenario manual` (:80) shadowing case, drop Entry `parent=`, supply amount/duration; E3003:6 N1; E3015:10 N3; E3005:2 narrow `add_days(date?)`; E3002:4 N2.
- CanTrade (29): E3015:2 supply location/resolved; E3003:5/E3001:4 narrow user?/money?/account; E3002:2 rename case `public`→`open` (resolves as grant-bool); E2013:1 drop `parent` from `columns=`.
- CanVolunteer (3): no D causes (body unchecked — see proposals/GAPs).
- CanWorkbench (140): E2001:25 declare/import `prioritize` (×6), type bare answer/open/…; E3015:14 construct typed delivery_state/input/proposal; E3003:13 N1; E3001:16 N3 (Step[]→text[] persists); E2013:4 drop created/updated from `fields=`; E3005:4 `format(text,object)` persists.
