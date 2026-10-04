# Actual context and commands for the later-change subject

Read entire pinned `../changes-brief.md` and `review-initial.md`; initial review requested no mandatory source repair. No C artifacts/findings, proposed remediation or live baseline source were read. AGENTS.md and pinned protocol plus initial documentation remained inherited context; they were not re-fetched to inflate supplied documentation. Source authoring reused only this subject's initial app.

Local reads: initial/equipment/service.py and views.py were printed in full; change2/equipment/service.py and mcp_server.py were printed in full after initial change2 generation, before final copied-outcome projection. Python AST self-check read every .py file structurally in each saved snapshot. All other source context was this subject's own previously authored draft and current edits. Metadata records resulting touched paths and hashes.

Official added documentation actually consumed (Django5.2, observed2026-10-04 UTC):

- https://docs.djangoproject.com/en/5.2/ref/migration-operations/ — rendered lines0–231 on initial open; selected AddField135–147, AlterField159–172. Follow-up find excerpt259–368; selected RunPython259–314 and SeparateDatabaseAndState315–323. AddField records an unbound model field; RenameField preserves the model/column identity rather than treating rename as drop/add. AlterField changes constraints. RunPython receives historical Apps and schema editor; models must use the selected DB alias. Separate data and schema migration stages avoid confusing historical state and PostgreSQL DDL/trigger issues. Only these returned excerpts were context, not all498 lines.
- https://docs.djangoproject.com/en/5.2/topics/migrations/ — initial open returned metadata only. Follow-up historical-model excerpt262–371; selected280–291 and324–369. Historical models must come from Apps, not current imports; data migrations are manually authored and graph dependencies must match actual preceding migrations. No entire588-line document was consumed.
- https://docs.djangoproject.com/en/5.2/topics/i18n/timezones/ — rendered excerpt18–288; selected52–93,161–173 and258–274. With USE_TZ Django uses aware datetimes and timezone.now; naive inputs can be ambiguous and should not define explicit expiry semantics. DateTime values include UTC offsets, compared strictly at admission. PostgreSQL UTC storage and aware values support that intended comparison. Only the returned excerpt was context, not all481 lines.

This file preserves selected-source paraphrases/ranges rather than claiming unread full documentation. Existing initial supplied-docs.json/context.md retain the auth/ORM/ModelForm/SDK contracts. Added lookup results were not downloaded as entire raw documents.

Commands actually used (all under the shared workspace; scripts wrote only D artifacts):

1. `cat design/evaluation/evidence/adoption/experiments/changes-brief.md design/evaluation/evidence/adoption/experiments/D/review-initial.md`
2. `cat .../D/initial/equipment/service.py .../D/initial/equipment/views.py`
3. `python3 /tmp/django_changes.py` (copy initial draft, implement change1).
4. `python3 /tmp/django_change2.py` (copy change1, implement change2 and prospective transitions).
5. `cat .../D/change-2/equipment/service.py .../D/change-2/equipment/mcp_server.py`
6. `python3 /tmp/django_change3.py` (copy change2, implement change3; align changed export-caption assertions).
7. Inline `python3 - <<'PY'` updated copied historic intake outcome projection and revoke-id validation; a second inline script parsed all Python sources, counted supplied test methods, hashed/verified the original initial manifest and checked dependency availability with importlib.util.find_spec. Output is preserved in changes-checks.json.
8. `python3 /tmp/django_changes_evidence.py` saved final context/notes/touched-source metadata/hashes.

Observed clock: change attempt first05:35:00; change1 first-written05:36:40; change2 first-written05:38:20; change3 first-written05:41:09; final source self-check05:42:22 UTC. First-written timings precede ordinary self-check edits, so they are not final per-stage duration estimates. Internal reasoning/usage and dispatch gaps are unavailable.
