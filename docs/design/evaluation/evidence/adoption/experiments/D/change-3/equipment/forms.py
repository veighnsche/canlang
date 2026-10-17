from django import forms
from django.contrib.auth.forms import AuthenticationForm
from .models import Request


class RequestForm(forms.ModelForm):
    class Meta:
        model = Request
        fields = ["title", "details", "private", "cost_centre"]
        help_texts = {"private": "Only you can read a private request; department managers cannot."}


class VersionForm(forms.Form):
    version = forms.IntegerField(min_value=1, widget=forms.HiddenInput)


class ArchiveForm(VersionForm):
    reason = forms.CharField(label="Archive reason", widget=forms.Textarea, strip=True)


class UploadForm(forms.Form):
    file = forms.FileField(help_text="UTF-8 CSV: title,details,private,cost_centre (private true or false). Up to 500 rows / 1 MB.")


class IntakeRowForm(RequestForm):
    include = forms.BooleanField(required=False, initial=True, label="Include this row")


class EmailAuthenticationForm(AuthenticationForm):
    username = forms.EmailField(label="Email", max_length=150)

    def clean_username(self):
        return self.cleaned_data["username"].strip().lower()


class ReviewGrantForm(forms.Form):
    member = forms.ModelChoiceField(queryset=None, label="Current member")
    expires_at = forms.CharField(label="Expiry timestamp", help_text="ISO timestamp with explicit offset, e.g. 2026-10-05T17:00:00+02:00")

    def __init__(self, *args, company, **kwargs):
        from django.contrib.auth import get_user_model
        super().__init__(*args, **kwargs)
        self.fields["member"].queryset = get_user_model().objects.filter(
            is_active=True,membership__active=True,membership__department__company=company).order_by("username")
