from django.conf import settings
from django.db import models
from django.db.models import Q


class Company(models.Model):
    id = models.PositiveSmallIntegerField(primary_key=True, default=1, editable=False)
    name = models.CharField(max_length=100)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(id=1), name="one_company")]


class Department(models.Model):
    company = models.ForeignKey(Company, on_delete=models.PROTECT)
    code = models.CharField(max_length=1, choices=[(x, x) for x in "ABC"], unique=True)
    managers = models.ManyToManyField(settings.AUTH_USER_MODEL, blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(code__in=list("ABC")), name="three_department_codes")]


class Membership(models.Model):
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    department = models.ForeignKey(Department, on_delete=models.PROTECT)
    active = models.BooleanField(default=True)


class Request(models.Model):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    department = models.ForeignKey(Department, on_delete=models.PROTECT)
    title = models.CharField("Request", max_length=120)
    details = models.TextField(blank=True, max_length=4000)
    cost_centre = models.CharField(max_length=40, blank=True, default="")
    private = models.BooleanField(default=False)
    state = models.CharField(max_length=8, default="open", choices=[("open", "Open"), ("archived", "Archived")])
    archive_reason = models.TextField(blank=True, default="", editable=False)
    version = models.PositiveIntegerField(default=1)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-id"]
        constraints = [models.CheckConstraint(condition=Q(state__in=["open", "archived"]), name="request_state")]


class Evidence(models.Model):
    request = models.ForeignKey(Request, on_delete=models.PROTECT)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    action = models.CharField(max_length=16)
    snapshot = models.JSONField()
    at = models.DateTimeField(auto_now_add=True)


class Intake(models.Model):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    rows = models.JSONField()
    version = models.PositiveIntegerField(default=1)
    committed = models.BooleanField(default=False)
    outcomes = models.JSONField(default=list)
    created_at = models.DateTimeField(auto_now_add=True)
