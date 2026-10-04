from django.urls import path
from django.contrib.auth import views as auth
from . import views
from .forms import EmailAuthenticationForm

urlpatterns = [
    path("", views.index, name="equipment-list"),
    path("reviews/", views.reviews, name="equipment-reviews"),
    path("<int:request_id>/", views.detail, name="equipment-detail"),
    path("new/", views.edit, name="equipment-create"),
    path("<int:request_id>/edit/", views.edit, name="equipment-edit"),
    path("<int:request_id>/archive/", views.archive, name="equipment-archive"),
    path("export/", views.export, name="equipment-export"),
    path("intake/", views.upload, name="equipment-upload"),
    path("intake/<int:batch_id>/", views.intake, name="equipment-intake"),
    path("chat-token/", views.chat_token, name="equipment-chat-token"),
    path("accounts/login/", auth.LoginView.as_view(authentication_form=EmailAuthenticationForm), name="login"),
    path("accounts/logout/", auth.LogoutView.as_view(), name="logout"),
]
