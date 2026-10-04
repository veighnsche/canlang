import csv
import io
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.db.models import Q
from .forms import RequestForm, VersionForm
from .models import Membership, Request, Evidence, Intake


class Failure(Exception):
    def __init__(self, code, message, status=400, fields=None):
        self.code, self.message, self.status, self.fields = code, message, status, fields or {}
        super().__init__(message)


def principal(user, lock=False):
    if not user.is_authenticated:
        raise Failure("denied", "Sign in required.", 403)
    # Fresh database state for every browser request/tool call, with no staff/superuser bypass.
    users = get_user_model().objects
    memberships = Membership.objects.select_related("department")
    if lock:
        users = users.select_for_update()
        memberships = Membership.objects.select_for_update()
    current = users.filter(pk=user.pk, is_active=True).first()
    member = memberships.filter(user_id=user.pk, active=True).first()
    if current is None or member is None:
        raise Failure("denied", "Active company membership required.", 403)
    return current, member


def scoped(user):
    current, member = principal(user)
    return Request.objects.filter(department__company_id=member.department.company_id).filter(
        Q(owner=current) | Q(private=False, department__managers=current)
    ).distinct()


def visible(user, request_id):
    item = scoped(user).filter(pk=request_id).first()
    if item is None:
        raise Failure("not_found", "Request unavailable.", 404)
    return item


def disclose(item, user):
    return {"id": item.pk, "title": item.title, "note": item.note,
            "private": item.private, "state": item.state, "version": item.version,
            "department": item.department.code, "owner_id": item.owner_id,
            "can_edit": item.owner_id == user.pk and item.state == "open"}


def listing(user, query="", state="", department=""):
    if state not in ("", "open", "archived") or department not in ("", "A", "B", "C"):
        raise Failure("invalid", "Unknown state or department filter.")
    qs = scoped(user).select_related("department")
    if query:
        qs = qs.filter(Q(title__icontains=query) | Q(note__icontains=query))
    if state:
        qs = qs.filter(state=state)
    if department:
        qs = qs.filter(department__code=department)
    return [disclose(item, user) for item in qs]


def validated(data):
    if not isinstance(data, dict):
        raise Failure("invalid", "Expected request fields.")
    if set(data) - {"title", "note", "private"}:
        raise Failure("invalid", "Only title, note and private may be supplied.")
    if "private" in data and type(data["private"]) is not bool:
        raise Failure("invalid", "Private must be a boolean.")
    form = RequestForm(data)
    if not form.is_valid():
        raise Failure("invalid", "Correct the request fields.", fields=form.errors.get_json_data())
    return form.cleaned_data


def expected_version(value):
    form = VersionForm({"version": value})
    if not form.is_valid():
        raise Failure("invalid", "A positive version is required.")
    return form.cleaned_data["version"]


def evidence(item, user, action):
    Evidence.objects.create(request=item, actor=user, action=action, snapshot=disclose(item, user))


@transaction.atomic
def mutate(user, action, data=None, request_id=None, version=None):
    current, member = principal(user, lock=True)
    if action == "create":
        values = validated(data)
        item = Request.objects.create(owner=current, department=member.department, **values)
    elif action in ("update", "archive"):
        # Deliberately query only owned objects: manager visibility does not grant mutation.
        item = Request.objects.select_for_update().filter(pk=request_id, owner=current).first()
        if item is None:
            raise Failure("not_found", "Request unavailable.", 404)
        if item.version != expected_version(version):
            raise Failure("conflict", "Request changed. Reload before trying again.", 409)
        if item.state != "open":
            raise Failure("conflict", "Archived requests cannot be changed.", 409)
        if action == "update":
            for key, value in validated(data).items():
                setattr(item, key, value)
        else:
            item.state = "archived"
        item.version += 1
        item.save()
    else:
        raise Failure("invalid", "Unknown operation.")
    evidence(item, current, action)
    return disclose(item, current)


def spreadsheet_safe(value):
    value = str(value)
    return "'" + value if value.lstrip().startswith(("=", "+", "-", "@")) else value


def export_csv(user, **filters):
    out = io.StringIO(newline="")
    writer = csv.writer(out)
    writer.writerow(["id", "title", "note", "private", "state", "version", "department", "owner_id"])
    for row in listing(user, **filters):
        writer.writerow([spreadsheet_safe(row[k]) for k in
                         ("id", "title", "note", "private", "state", "version", "department", "owner_id")])
    return out.getvalue()


def parse_csv(text):
    if not isinstance(text, str) or len(text.encode("utf-8")) > 1000000:
        raise Failure("invalid", "CSV exceeds 1 MB.")
    reader = csv.DictReader(io.StringIO(text.lstrip("\ufeff")), strict=True)
    try:
        headers = reader.fieldnames
    except csv.Error as exc:
        raise Failure("invalid", "Malformed CSV header.") from exc
    if headers != ["title", "note", "private"]:
        raise Failure("invalid", "CSV header must be title,note,private.")
    rows = []
    try:
        for row in reader:
            if len(rows) == 500:
                raise Failure("invalid", "CSV exceeds 500 rows.")
            malformed = None in row or any(value is None for value in row.values())
            value = row.get("private", "")
            rows.append({"title": row.get("title") or "", "note": row.get("note") or "",
                         "private": value == "true", "include": True,
                         "parse_error": "Malformed row or private must be true/false." if malformed or value not in ("true", "false") else ""})
    except csv.Error as exc:
        raise Failure("invalid", "Malformed CSV.") from exc
    if not rows:
        raise Failure("invalid", "CSV has no rows.")
    return rows


def preview_rows(user, rows):
    principal(user)
    seen = set()
    results = []
    for number, row in enumerate(rows, 1):
        result = {**row, "row": number, "status": "ready", "errors": {}}
        try:
            if row.get("parse_error"):
                raise Failure("invalid", row["parse_error"])
            values = validated({k: row[k] for k in ("title", "note", "private")})
            result.update(values)
            key = (values["title"], values["note"], values["private"])
            if key in seen or Request.objects.filter(owner=user, **values).exists():
                result["status"] = "duplicate"
            if row["include"]:
                seen.add(key)
        except Failure as exc:
            result.update(status="invalid", errors=exc.fields or {"row": exc.message})
        results.append(result)
    return results


def own_batch(user, batch_id, lock=False):
    principal(user)
    qs = Intake.objects.select_for_update() if lock else Intake.objects
    batch = qs.filter(pk=batch_id, owner=user).first()
    if batch is None:
        raise Failure("not_found", "Intake unavailable.", 404)
    return batch


def batch_result(user, batch):
    return {"id": batch.pk, "version": batch.version, "committed": batch.committed,
            "rows": preview_rows(user, batch.rows) if not batch.committed else [], "outcomes": batch.outcomes}


def intake_preview(user, text):
    principal(user)
    batch = Intake.objects.create(owner=user, rows=parse_csv(text))
    return batch_result(user, batch)


@transaction.atomic
def intake_correct(user, batch_id, version, rows):
    principal(user, lock=True)
    batch = own_batch(user, batch_id, lock=True)
    if batch.committed or batch.version != expected_version(version):
        raise Failure("conflict", "Intake changed or already committed.", 409)
    if not isinstance(rows, list) or len(rows) != len(batch.rows):
        raise Failure("invalid", "Correct/exclude the existing rows; do not add/remove rows.")
    clean_rows = []
    for row in rows:
        if not isinstance(row, dict) or set(row) != {"title", "note", "private", "include"}:
            raise Failure("invalid", "Each row needs title,note,private,include.")
        if type(row["include"]) is not bool or type(row["private"]) is not bool:
            raise Failure("invalid", "Include and private must be boolean.")
        if not isinstance(row["title"], str) or not isinstance(row["note"], str):
            raise Failure("invalid", "Title and note must be text.")
        if len(row["title"]) > 1000 or len(row["note"]) > 10000:
            raise Failure("invalid", "Correction input too large.")
        clean_rows.append({**row, "parse_error": ""})
    batch.rows = clean_rows
    batch.version += 1
    batch.save()
    return batch_result(user, batch)


@transaction.atomic
def intake_commit(user, batch_id, version):
    # The same membership/user locks serialize creates/intake by this owner.
    principal(user, lock=True)
    batch = own_batch(user, batch_id, lock=True)
    if batch.committed or batch.version != expected_version(version):
        raise Failure("conflict", "Intake changed or already committed.", 409)
    outcomes = []
    for row in preview_rows(user, batch.rows):
        status = "excluded" if not row["include"] else row["status"]
        result = {"row": row["row"], "status": status, "errors": row["errors"]}
        if status == "ready":
            try:
                created = mutate(user, "create", {k: row[k] for k in ("title", "note", "private")})
                result.update(status="created", request=created)
            except Failure as exc:
                result.update(status=exc.code, errors=exc.fields or {"row": exc.message})
            except IntegrityError:
                result.update(status="failed", errors={"row": "Database rejected row; retry in a new intake."})
        outcomes.append(result)
    batch.committed, batch.outcomes = True, outcomes
    batch.version += 1
    batch.save()
    return batch_result(user, batch)
