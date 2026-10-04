import os
import django
from asgiref.sync import sync_to_async
from django.db import close_old_connections

django.setup()  # DJANGO_SETTINGS_MODULE is supplied by the standard project environment.
from mcp.server.fastmcp import FastMCP
from .chat_auth import token_user
from . import service

mcp = FastMCP("Department equipment requests")


@sync_to_async(thread_sensitive=True)
def call(operation, **args):
    close_old_connections()
    try:
        user = token_user(os.environ.get("EQUIPMENT_MCP_TOKEN", ""))
        return {"ok": True, "result": operation(user, **args)}
    except service.Failure as exc:
        return {"ok": False, "code": exc.code, "message": exc.message,
                "status": exc.status, "fields": exc.fields}
    finally:
        close_old_connections()


@mcp.tool()
async def requests(query: str = "", state: str = "", department: str = "") -> dict:
    """List only currently authorized requests, including versions and editable flags."""
    return await call(service.listing, query=query, state=state, department=department)


@mcp.tool()
async def request_change(action: str, title: str = "", details: str = "", private: bool = False, cost_centre: str = "",
                   request_id: int | None = None, version: int | None = None, reason: str = "") -> dict:
    """Request: create/update/archive. Archive requires a trimmed nonempty reason; update/archive need displayed version."""
    return await call(service.mutate, action=action, data={"title": title, "details": details, "private": private, "cost_centre": cost_centre},
                request_id=request_id, version=version, reason=reason)


@mcp.tool()
async def requests_csv(query: str = "", state: str = "", department: str = "") -> dict:
    """Export only the same currently authorized rows shown by requests."""
    return await call(service.export_csv, query=query, state=state, department=department)


@mcp.tool()
async def csv_preview(text: str) -> dict:
    """Preview create-only UTF-8 CSV; returns invalid/duplicate rows without creating requests."""
    return await call(service.intake_preview, text=text)


@mcp.tool()
async def csv_correct(batch_id: int, version: int, rows: list[dict]) -> dict:
    """Replace all preview rows with title/details/private/cost_centre/include. Review returned preview before commit."""
    return await call(service.intake_correct, batch_id=batch_id, version=version, rows=rows)


@mcp.tool()
async def csv_commit(batch_id: int, version: int) -> dict:
    """Explicitly commit selected ready rows; invalid/duplicate/excluded rows receive individual outcomes."""
    return await call(service.intake_commit, batch_id=batch_id, version=version)


if __name__ == "__main__":
    mcp.run(transport="stdio")
