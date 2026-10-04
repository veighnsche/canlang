// TEST-ONLY fixture Worker. Proves local serving + D1 binding wiring through
// startLocalDev. Never shipped, never a Can app: it contains no business logic.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ping") {
      return Response.json({ ok: true });
    }
    if (url.pathname === "/d1-roundtrip") {
      await env.DB.exec("CREATE TABLE IF NOT EXISTS smoke (id INTEGER PRIMARY KEY, v TEXT)");
      await env.DB.prepare("INSERT INTO smoke (v) VALUES (?)").bind("smoke-value").run();
      const row = await env.DB.prepare("SELECT v FROM smoke ORDER BY id DESC LIMIT 1").first();
      return Response.json({ v: row?.v ?? null });
    }
    return new Response("not found", { status: 404 });
  },
};
