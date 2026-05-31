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
          const raw = await env.TRACKER_KV.get('tracker:' + key);
          if (!raw) {
            return json({ version: 0, data: null, updatedAt: null });
          }
          const parsed = JSON.parse(raw);
          // Backwards compat: legacy records were stored as the raw data blob.
          // Detect by presence of items/properties/movements at top level.
          if (parsed && parsed.items && !parsed.data) {
            return json({ version: 1, data: parsed, updatedAt: null });
          }
          return json({
            version: parsed.version || 0,
            data: parsed.data || null,
            updatedAt: parsed.updatedAt || null,
          });
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
          const baseVersion = body.baseVersion;
          const force = body.force === true;
          if (!key || key.length < 4) {
            return json({ error: 'Sync key must be at least 4 characters' }, 400);
          }
          if (!data || !data.properties || !data.items || !data.movements) {
            return json({ error: 'Invalid data format' }, 400);
          }

          // Optimistic concurrency: load current version, compare to baseVersion
          let currentVersion = 0;
          const existingRaw = await env.TRACKER_KV.get('tracker:' + key);
          if (existingRaw) {
            const existing = JSON.parse(existingRaw);
            if (existing && existing.items && !existing.data) {
              currentVersion = 1; // legacy record
            } else {
              currentVersion = existing.version || 0;
            }
          }

          if (!force && typeof baseVersion === 'number' && baseVersion !== currentVersion) {
            return json({
              error: 'Stale version — pull latest before pushing',
              conflict: true,
              currentVersion: currentVersion,
              baseVersion: baseVersion,
            }, 409);
          }

          const newVersion = currentVersion + 1;
          const record = {
            version: newVersion,
            data: data,
            updatedAt: new Date().toISOString(),
          };
          await env.TRACKER_KV.put('tracker:' + key, JSON.stringify(record));
          return json({ ok: true, version: newVersion, timestamp: record.updatedAt });
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

  // Cron-triggered alarm scanner — fires alarms even when no browser is open.
  // Runs every minute (configured in wrangler.toml). For each sync key,
  // finds items whose alarm time has passed (within the last 24h) and that
  // haven't been marked fired yet, and pushes email/SMS via bp/notify.
  // bp/notify dedupes per (taskId, alarm), so re-runs are safe.
  async scheduled(event, env, ctx) {
    if (!env.TRACKER_KV) return;
    const now = Date.now();
    const cutoff = now - 24 * 60 * 60 * 1000; // skip alarms older than 24h
    const NOTIFY_URL = 'https://bp.rbarvani.workers.dev/notify';
    const SMS_TO = '3156913000@vtext.com';
    const EMAIL_TO = 't@bporta.com';

    let cursor;
    do {
      const list = await env.TRACKER_KV.list({ prefix: 'tracker:', cursor });
      for (const k of list.keys) {
        const raw = await env.TRACKER_KV.get(k.name);
        if (!raw) continue;
        let parsed;
        try { parsed = JSON.parse(raw); } catch (e) { continue; }
        const data = (parsed && parsed.data) || (parsed && parsed.items ? parsed : null);
        if (!data || !Array.isArray(data.items)) continue;

        const propsById = {};
        if (Array.isArray(data.properties)) {
          for (const p of data.properties) propsById[p.id] = p;
        }

        for (const item of data.items) {
          if (!item || !item.alarm || item.alarmFired) continue;
          const alarmMs = Date.parse(item.alarm);
          if (isNaN(alarmMs)) continue;
          if (alarmMs > now) continue;     // not yet due
          if (alarmMs < cutoff) continue;  // too stale, skip

          const prop = propsById[item.propertyId];
          const propName = prop ? prop.name : '';

          if (item.notifyEmail !== false) {
            ctx.waitUntil(postNotify(NOTIFY_URL, buildEmailPayload(EMAIL_TO, item, propName)));
          }
          if (item.notifySms === true) {
            ctx.waitUntil(postNotify(NOTIFY_URL, buildSmsPayload(SMS_TO, item, propName)));
          }
        }
      }
      cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);
  },
};

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildSmsPayload(to, item, propName) {
  let msg = 'ALARM: ' + (item.name || '');
  if (item.phone) msg += ' | Tel:' + item.phone;
  if (propName) msg += ' | ' + propName;
  if (item.dueDate) msg += ' | Due:' + item.dueDate;
  if (item.alarm) msg += ' | Alarm:' + new Date(item.alarm).toLocaleString();
  if (item.notes) {
    const noteText = Array.isArray(item.notes)
      ? item.notes.map(n => (n && n.text) ? n.text : n).join(' ')
      : item.notes;
    msg += ' | ' + noteText;
  }
  if (msg.length > 160) msg = msg.substring(0, 157) + '...';
  return { to, subject: '', html: msg, taskId: item.id, alarm: item.alarm };
}

function buildEmailPayload(to, item, propName) {
  const r = (label, val) =>
    '<tr><td style="padding:8px;font-weight:bold;color:#555;border-bottom:1px solid #eee">'
    + label + '</td><td style="padding:8px;border-bottom:1px solid #eee">' + val + '</td></tr>';
  let dueStr = item.dueDate || '';
  if (dueStr && item.dueTime) dueStr += ' ' + item.dueTime;
  const urls = (item.urls && item.urls.length > 0) ? item.urls : (item.url ? [item.url] : []);
  const html = '<div style="font-family:sans-serif;max-width:500px">'
    + '<h2 style="color:#d93025;margin:0 0 12px">&#9200; Task Alarm</h2>'
    + '<table style="border-collapse:collapse;width:100%">'
    + r('Task', escHtml(item.name))
    + r('Category', escHtml(propName))
    + (item.phone ? r('Phone', '<a href="tel:' + escHtml(item.phone) + '" style="color:#27ae60;text-decoration:none">' + escHtml(item.phone) + '</a>') : '')
    + (item.email ? r('Email', '<a href="mailto:' + escHtml(item.email) + '" style="color:#8e44ad;text-decoration:none">' + escHtml(item.email) + '</a>') : '')
    + (item.address ? r('Address', '<a href="https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(item.address) + '" target="_blank" rel="noopener" title="Driving directions" style="color:#1a73e8;text-decoration:none">&#128205; ' + escHtml(item.address) + '</a>') : '')
    + (item.status ? r('Status', escHtml(item.status)) : '')
    + (dueStr ? r('Due', escHtml(dueStr)) : '')
    + (item.alarm ? r('Alarm', escHtml(new Date(item.alarm).toLocaleString())) : '')
    + (item.recurrence && item.recurrence !== 'none' ? r('Recurrence', escHtml(item.recurrence)) : '')
    + (item.description ? r('Details', escHtml(item.description)) : '')
    + (urls.length > 0 ? r('URLs', urls.map(u => '<a href="' + escHtml(u) + '" target="_blank">' + escHtml(u) + '</a>').join('<br>')) : '')
    + (item.assignee ? r('Assignee', escHtml(item.assignee)) : '')
    + (item.estimatedCost ? r('Est. Cost', '$' + escHtml(item.estimatedCost)) : '')
    + (item.actualCost ? r('Actual Cost', '$' + escHtml(item.actualCost)) : '')
    + (item.subtasks && item.subtasks.length > 0 ? r('Sub-Tasks', '<div style="margin:0;padding:0">' + item.subtasks.map(s => '<div style="padding:2px 0;' + (s.done ? 'color:#999;text-decoration:line-through' : '') + '">' + (s.done ? '&#9745;' : '&#9744;') + ' ' + escHtml(s.text) + '</div>').join('') + '<div style="margin-top:4px;font-size:11px;color:#888">' + item.subtasks.filter(s => s.done).length + ' of ' + item.subtasks.length + ' complete</div></div>') : '')
    + (item.notes && item.notes.length > 0 ? r('Notes', item.notes.map(n => escHtml((n && n.text) ? n.text : n)).join('<br>')) : '')
    + (item.createdAt ? r('Created', escHtml(item.createdAt)) : '')
    + '</table>'
    + '<p style="color:#888;font-size:12px;margin-top:16px">Sent by Property Task Tracker (cron)</p>'
    + '</div>';
  return { to, subject: 'Task Alarm: ' + (item.name || ''), html, taskId: item.id, alarm: item.alarm };
}

async function postNotify(url, payload) {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    // Best-effort; cron will retry next minute, dedupe protects against duplicates
  }
}

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
