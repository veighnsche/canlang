from django.contrib.auth.decorators import login_required
from django.http import HttpResponse
from django.shortcuts import redirect, render
from django.forms import formset_factory
from django.views.decorators.http import require_POST
from . import service
from .chat_auth import issue_token
from .forms import RequestForm, VersionForm, UploadForm, IntakeRowForm, ArchiveForm, ReviewGrantForm


def error(request, exc):
    return render(request, "equipment/error.html", {"error": exc}, status=exc.status)


@login_required
def index(request):
    filters = {k: request.GET.get(k, "") for k in ("query", "state", "department")}
    try:
        rows = service.listing(request.user, **filters)
    except service.Failure as exc:
        return error(request, exc)
    return render(request, "equipment/list.html", {"rows": rows, "filters": filters, "can_manage_reviews": service.can_manage_reviews(request.user)})


@login_required
def edit(request, request_id=None):
    try:
        item = service.visible(request.user, request_id) if request_id else None
        if item and (item.owner_id != request.user.pk or item.state != "open"):
            raise service.Failure("denied", "Only owners may edit open requests.", 403)
        form = RequestForm(request.POST or None, instance=item)
        version = VersionForm(request.POST or None, initial={"version": item.version if item else 1})
        if request.method == "POST" and form.is_valid() and version.is_valid():
            result = service.mutate(request.user, "update" if item else "create", form.cleaned_data,
                                    request_id, version.cleaned_data["version"])
            return redirect("equipment-list")
    except service.Failure as exc:
        return error(request, exc)
    return render(request, "equipment/form.html", {"form": form, "version": version})


@login_required
@require_POST
def archive(request, request_id):
    try:
        service.mutate(request.user, "archive", request_id=request_id, version=request.POST.get("version"), reason=request.POST.get("reason", ""))
    except service.Failure as exc:
        return error(request, exc)
    return redirect("equipment-list")


@login_required
def export(request):
    try:
        content = service.export_csv(request.user, **{k: request.GET.get(k, "") for k in ("query", "state", "department")})
    except service.Failure as exc:
        return error(request, exc)
    response = HttpResponse(content, content_type="text/csv; charset=utf-8")
    response["Content-Disposition"] = 'attachment; filename="equipment.csv"'
    response["Cache-Control"] = "no-store"
    return response


@login_required
def upload(request):
    form = UploadForm(request.POST or None, request.FILES or None)
    if request.method == "POST" and form.is_valid():
        try:
            file = form.cleaned_data["file"]
            if file.size > 1000000:
                raise service.Failure("invalid", "CSV exceeds 1 MB.")
            batch = service.intake_preview(request.user, file.read().decode("utf-8-sig"))
            return redirect("equipment-intake", batch_id=batch["id"])
        except UnicodeDecodeError:
            form.add_error("file", "CSV must be UTF-8.")
        except service.Failure as exc:
            form.add_error("file", exc.message)
    return render(request, "equipment/upload.html", {"form": form})


@login_required
def intake(request, batch_id):
    RowSet = formset_factory(IntakeRowForm, extra=0, max_num=500, validate_max=True, absolute_max=500)
    try:
        batch = service.own_batch(request.user, batch_id)
        preview = service.batch_result(request.user, batch)
        forms = RowSet(request.POST if request.method == "POST" and request.POST.get("action") == "correct" else None,
                       initial=batch.rows, prefix="rows")
        if request.method == "POST":
            if request.POST.get("action") == "correct":
                # Keep invalid fields editable. Shape/length are validated by service; invalid business rows remain previewable.
                forms.is_valid()
                if (forms.management_form.is_valid()
                        and forms.management_form.cleaned_data["TOTAL_FORMS"] == len(batch.rows)
                        and not forms.non_form_errors()):
                    rows = [{"title": f.data.get(f.add_prefix("title"), ""),
                             "details": f.data.get(f.add_prefix("details"), ""),
                             "cost_centre": f.data.get(f.add_prefix("cost_centre"), ""),
                             "private": f.data.get(f.add_prefix("private")) == "on",
                             "include": f.data.get(f.add_prefix("include")) == "on"} for f in forms]
                    service.intake_correct(request.user, batch_id, request.POST.get("version"), rows)
                    return redirect("equipment-intake", batch_id=batch_id)
            elif request.POST.get("action") == "commit":
                service.intake_commit(request.user, batch_id, request.POST.get("version"))
                return redirect("equipment-intake", batch_id=batch_id)
            else:
                raise service.Failure("invalid", "Unknown intake action.")
    except service.Failure as exc:
        return error(request, exc)
    return render(request, "equipment/intake.html", {"batch": preview, "forms": forms,
                                                    "paired": list(zip(forms, preview["rows"]))})


@login_required
@require_POST
def chat_token(request):
    try:
        token = issue_token(request.user)
    except service.Failure as exc:
        return error(request, exc)
    response = render(request, "equipment/token.html", {"token": token})
    response["Cache-Control"] = "no-store"
    return response


@login_required
def detail(request, request_id):
    try:
        row = service.read_request(request.user,request_id)
    except service.Failure as exc:
        return error(request,exc)
    return render(request,"equipment/detail.html",{"row":row})


@login_required
def reviews(request):
    try:
        _, company = service.company_authority(request.user)
        form = ReviewGrantForm(request.POST or None,company=company)
        if request.method == "POST":
            if request.POST.get("action") == "revoke":
                service.revoke_review(request.user,request.POST.get("grant_id"))
                return redirect("equipment-reviews")
            if request.POST.get("action") != "grant":
                raise service.Failure("invalid","Unknown review-access action.")
            if form.is_valid():
                service.grant_review(request.user,form.cleaned_data["member"].pk,form.cleaned_data["expires_at"])
                return redirect("equipment-reviews")
        grants = service.review_grants(request.user)
    except service.Failure as exc:
        return error(request,exc)
    return render(request,"equipment/reviews.html",{"form":form,"grants":grants})
