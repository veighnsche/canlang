from django import forms
from django.contrib.auth.forms import AuthenticationForm
from .models import Request


class RequestForm(forms.ModelForm):
    class Meta:
        model = Request
        fields = ["title", "note", "private"]
        help_texts = {"private": "Only you can read a private request; department managers cannot."}


class VersionForm(forms.Form):
    version = forms.IntegerField(min_value=1, widget=forms.HiddenInput)


class UploadForm(forms.Form):
    file = forms.FileField(help_text="UTF-8 CSV: title,note,private (true or false). Up to 500 rows / 1 MB.")


class IntakeRowForm(RequestForm):
    include = forms.BooleanField(required=False, initial=True, label="Include this row")


class EmailAuthenticationForm(AuthenticationForm):
    username = forms.EmailField(label="Email", max_length=150)

    def clean_username(self):
        return self.cleaned_data["username"].strip().lower()
