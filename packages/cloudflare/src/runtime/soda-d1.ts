/** Private D1 backend for the built-in workerd D1 client.
 * Protocol/result adaptation derived from Miniflare's MIT-licensed D1 worker.
 * Copyright (c) Cloudflare, Inc. Retain the notice in runtime distributions.
 */
export const SODA_D1_SOURCE = String.raw`
const MAX_BODY = 32 * 1024 * 1024;
async function queries(request) {
  const parts = []; let length = 0;
  for await (const part of request.body ?? []) {
    length += part.byteLength;
    if (length > MAX_BODY) throw new Error('D1 request exceeds private provider bound');
    parts.push(part);
  }
  const body = JSON.parse(await new Blob(parts).text());
  const list = Array.isArray(body) ? body : [body];
  if (list.length === 0 || list.length > 16384) throw new Error('Invalid D1 statement count');
  for (const query of list) {
    if (!query || typeof query.sql !== 'string' || !query.sql.trim() ||
      (query.params != null && !Array.isArray(query.params))) throw new Error('Invalid D1 query');
    for (const value of query.params ?? []) {
      if (value !== null && typeof value !== 'string' &&
        !(typeof value === 'number' && Number.isFinite(value)) &&
        !(Array.isArray(value) && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)))
        throw new Error('Invalid D1 bound value');
    }
  }
  return list;
}
export class D1DatabaseObject {
  constructor(state) { this.state = state; this.sql = state.storage.sql; }
  query(query, format) {
    const before = this.sql.exec('SELECT total_changes() AS changes').one().changes;
    const started = performance.now();
    const cursor = this.sql.exec(query.sql, ...(query.params ?? []).map(value =>
      Array.isArray(value) ? new Uint8Array(value).buffer : value));
    const columns = cursor.columnNames;
    const rows = [...cursor.raw()].map(row => row.map(value =>
      value instanceof ArrayBuffer ? Array.from(new Uint8Array(value)) : value));
    const after = this.sql.exec('SELECT total_changes() AS changes, last_insert_rowid() AS lastRowId').one();
    const changes = after.changes - before;
    return {success:true, results:format === 'ROWS_AND_COLUMNS' ? {columns,rows} :
      rows.map(row => Object.fromEntries(columns.map((name,i) => [name,row[i]]))),
      meta:{served_by:'canlang.workerd',duration:performance.now()-started,changes,
        last_row_id:after.lastRowId,changed_db:changes !== 0,size_after:this.sql.databaseSize,
        rows_read:cursor.rowsRead,rows_written:cursor.rowsWritten}};
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || !['/query','/execute'].includes(url.pathname))
      return new Response(null,{status:404});
    try {
      const list = await queries(request);
      const results = this.state.storage.transactionSync(() => list.map(query =>
        this.query(query,url.searchParams.get('resultsFormat'))));
      // Savepoint release alone is not disk commit. Wait for durable storage
      // before acknowledging to the built-in client; transport loss is not replayed.
      await this.state.storage.sync();
      const bookmark = await this.state.storage.getCurrentBookmark();
      return Response.json(results,{headers:{'x-cf-d1-session-commit-token':bookmark}});
    } catch (error) {
      return Response.json({success:false,error:error instanceof Error ? error.message : 'D1 provider failed'});
    }
  }
}
export default {fetch(request,env){
  return env.DATABASE.get(env.DATABASE.idFromName(env.RESOURCE)).fetch(request);
}};
`;
