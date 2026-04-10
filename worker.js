const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      const url = new URL(request.url);

      // --- Sync API ---
      if (url.pathname === '/sync') {
        if (!env.TRACKER_KV) {
          return json({ error: 'KV binding missing. Add a KV namespace named TRACKER_KV in Worker Settings > Bindings' }, 500);
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
      }

      // --- Notify API (email/SMS via Resend) ---
      if (url.pathname === '/notify' && request.method === 'POST') {
        if (!env.RESEND_API_KEY) {
          return json({ error: 'RESEND_API_KEY secret not configured. Run: npx wrangler secret put RESEND_API_KEY' }, 500);
        }

        let body;
        try {
          body = await request.json();
        } catch (e) {
          return json({ error: 'Invalid JSON body' }, 400);
        }

        const { to, subject, html, taskId, alarm, photos } = body;
        if (!to || !html) {
          return json({ error: 'Missing required fields: to, html' }, 400);
        }

        // Deduplication: skip if already sent for this taskId+alarm combo
        if (taskId && alarm && env.TRACKER_KV) {
          const dedupeKey = 'notify:' + taskId + ':' + alarm;
          const existing = await env.TRACKER_KV.get(dedupeKey);
          if (existing) {
            return json({ skipped: true, message: 'Already sent' });
          }
        }

        // Build email HTML with embedded photos (inline base64 as data URIs in img tags)
        let finalHtml = html;
        let photoCount = 0;
        if (photos && photos.length > 0) {
          let photoHtml = '<div style="margin-top:16px">';
          for (const photo of photos) {
            if (photo && photo.startsWith('data:')) {
              photoHtml += '<div style="margin:8px 0"><img src="' + photo + '" style="max-width:100%;max-height:400px;border-radius:8px" /></div>';
              photoCount++;
            }
          }
          photoHtml += '</div>';
          // Insert photos before closing </div> of the email wrapper
          const lastDiv = finalHtml.lastIndexOf('</div>');
          if (lastDiv !== -1) {
            finalHtml = finalHtml.substring(0, lastDiv) + photoHtml + finalHtml.substring(lastDiv);
          } else {
            finalHtml += photoHtml;
          }
        }

        // Send via Resend API
        // Detect SMS gateway addresses — send plain text for carrier gateways
        const smsGateways = ['@vtext.com', '@tmomail.net', '@txt.att.net', '@messaging.sprintpcs.com', '@msg.fi.google.com'];
        const isSms = smsGateways.some(gw => to.toLowerCase().endsWith(gw));
        const fromAddress = env.RESEND_FROM || 'Task Tracker <notifications@resend.dev>';

        // Strip HTML tags for plain text version (used for SMS)
        const plainText = finalHtml.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

        const emailPayload = {
          from: fromAddress,
          to: [to],
          subject: subject || (isSms ? '' : '(no subject)'),
        };

        if (isSms) {
          // SMS gateways need plain text, no HTML — minimal subject
          emailPayload.text = plainText.substring(0, 160);
        } else {
          emailPayload.html = finalHtml;
        }

        const resendResp = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + env.RESEND_API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(emailPayload),
        });

        const resendResult = await resendResp.json();

        if (!resendResp.ok) {
          return json({ error: 'Resend API error', details: resendResult }, resendResp.status);
        }

        // Mark as sent for deduplication (expire after 7 days)
        if (taskId && alarm && env.TRACKER_KV) {
          const dedupeKey = 'notify:' + taskId + ':' + alarm;
          await env.TRACKER_KV.put(dedupeKey, JSON.stringify({
            emailId: resendResult.id,
            sentAt: new Date().toISOString(),
          }), { expirationTtl: 604800 });
        }

        return json({ ok: true, emailId: resendResult.id, photoCount });
      }

      // --- Static assets (served from KV via __STATIC_CONTENT or env.ASSETS) ---
      // If using Cloudflare Pages or Workers Sites, the static assets are served
      // by the platform automatically for non-API routes.
      // For a plain Worker with static HTML embedded, fall through to asset handler.

      // Try to serve from ASSETS binding (Workers Sites / Pages)
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      // Try __STATIC_CONTENT binding (wrangler sites)
      if (env.__STATIC_CONTENT) {
        // Let the default asset handler serve it
        return env.__STATIC_CONTENT.fetch(request);
      }

      return json({ error: 'Not found' }, 404);

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
      'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    },
  });
}
