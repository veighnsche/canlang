from django.contrib.auth import get_user_model
from django.core import signing
from django.utils.crypto import constant_time_compare
from .service import Failure, principal

SALT = "equipment.mcp.v1"


def issue_token(user):
    current, _ = principal(user)
    return signing.dumps({"user": current.pk, "auth": current.get_session_auth_hash()}, salt=SALT)


def token_user(token):
    try:
        payload = signing.loads(token, salt=SALT, max_age=8 * 3600)
        user = get_user_model().objects.get(pk=payload["user"], is_active=True)
        if not constant_time_compare(payload["auth"], user.get_session_auth_hash()):
            raise ValueError("Credential changed")
        principal(user)
        return user
    except (signing.BadSignature, get_user_model().DoesNotExist, KeyError, ValueError, TypeError):
        raise Failure("denied", "Chat token expired or invalid. Sign in to obtain another.", 403)
