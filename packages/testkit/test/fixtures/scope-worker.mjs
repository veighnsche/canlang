// TEST-ONLY fixture Worker. Key/value cells over D1 for row-isolation proof.
// Never shipped, never a Can app: it contains no business logic.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    await env.DB.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)");
    if (url.pathname === "/write") {
      const key = url.searchParams.get("k") ?? "k";
      const value = url.searchParams.get("v") ?? "";
      await env.DB.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)").bind(key, value).run();
      return Response.json({ wrote: key });
    }
    if (url.pathname === "/read") {
      const key = url.searchParams.get("k") ?? "k";
      const row = await env.DB.prepare("SELECT v FROM kv WHERE k = ?").bind(key).first();
      return Response.json({ v: row?.v ?? null });
    }
    return new Response("not found", { status: 404 });
  },
};
