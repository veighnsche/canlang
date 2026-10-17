"""Draft exact Django operations; no Migration class or installed predecessor is asserted.
The operator must pin dependencies and schema before inserting these operation lists
into separately generated Django migration files, with writes stopped throughout.
"""
from django.db import migrations, models


def block_long_titles(apps, schema_editor):
    Request = apps.get_model("equipment", "Request")
    bad = [row.pk for row in Request.objects.using(schema_editor.connection.alias).all().iterator()
           if len(row.title) > 120]
    if bad:
        raise RuntimeError(f"Activation blocked: correct request ids under old 160-character contract: {bad}")


def transition_intake_rows(apps, schema_editor):
    Intake = apps.get_model("equipment", "Intake")
    for batch in Intake.objects.using(schema_editor.connection.alias).filter(committed=False).iterator():
        for row in batch.rows:
            if "note" in row and "details" in row:
                raise RuntimeError("Ambiguous intake field mapping; activation blocked.")
            if "note" in row:
                row["details"] = row.pop("note")  # Preserve value including None/empty exactly.
            row.setdefault("cost_centre", "")
        batch.version += 1  # Every old preview becomes stale and must be reviewed anew.
        batch.save(update_fields=["rows","version"])


# First migration: preflight and active-preview adaptation, using historical models.
# Immutable Evidence snapshots and committed Intake outcomes retain historical note keys.
preflight_operations = [migrations.RunPython(block_long_titles, reverse_code=migrations.RunPython.noop),
                        migrations.RunPython(transition_intake_rows)]
# Separate schema migration: preserve the prior column rather than remove/add it.
schema_operations = [
    migrations.RenameField(model_name="request",old_name="note",new_name="details"),
    migrations.AddField(model_name="request",name="cost_centre",field=models.CharField(max_length=40,blank=True,default="")),
    migrations.AlterField(model_name="request",name="title",field=models.CharField("Request",max_length=120)),
]
