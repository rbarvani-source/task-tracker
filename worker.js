const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      const url = new URL(request.url);

      if (!env.TRACKER_KV) {
        return json({ error: 'KV binding missing. Add a KV namespace named TRACKER_KV in Worker Settings > Bindings' }, 500);
      }

      if (url.pathname !== '/sync') {
        return json({ error: 'Not found. Use /sync endpoint' }, 404);
      }

      if (request.method === 'GET') {
        const key = url.searchParams.get('key');
        if (!key || key.length < 4) {
          return json({ error: 'Sync key must be at least 4 characters' }, 400);
        }
        const data = await env.TRACKER_KV.get('tracker:' + key);
        return json({ data: data ? JSON.parse(data) : null });
      }

      if (request.method === 'PUT') {
        let body;
        try {
          body = await request.json();
        } catch (e) {
          return json({ error: 'Invalid JSON body' }, 400);
        }
        const key = body.key;
        const data = body.data;
        if (!key || key.length < 4) {
          return json({ error: 'Sync key must be at least 4 characters' }, 400);
        }
        if (!data || !data.properties || !data.items || !data.movements) {
          return json({ error: 'Invalid data format' }, 400);
        }
        await env.TRACKER_KV.put('tracker:' + key, JSON.stringify(data));
        return json({ ok: true, timestamp: new Date().toISOString() });
      }

      return json({ error: 'Method not allowed' }, 405);

    } catch (err) {
      return json({ error: 'Worker error: ' + err.message }, 500);
    }
  },
};

function json(obj, status) {
  if (!status) status = 200;
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    },
  });
}
