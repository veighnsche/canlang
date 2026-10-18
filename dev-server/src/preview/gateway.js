export default {
  async fetch(request, env) {
    if (request.headers.get('x-can-local-dispatch') !== env.CAN_LOCAL_SECRET) return new Response(null, {status:403});
    const headers = new Headers(request.headers);
    headers.delete('x-can-local-dispatch');
    const url = headers.get('x-can-local-url') || request.url;
    headers.delete('x-can-local-url');
    return env.CAN_LOCAL_APP.fetch(new Request(new Request(url,request), {headers}));
  }
};
