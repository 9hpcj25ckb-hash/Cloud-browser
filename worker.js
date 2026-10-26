// =====================================================================
// Hyperbeam Cloud Browser Pro — single-file Cloudflare Worker
// Backend API + frontend. Frontend JS is served as a classic script at
// /client.js (no inline onclick, no module imports, SDK loaded on demand).
// =====================================================================

const HB_BASE = "https://engine.hyperbeam.com/v0/vm";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

function hbHeaders(apiKey) {
  return { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" };
}

function listSessions(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.results)) return data.results;     // documented shape: { results: [{ id, creation_date }], next }
  if (data && Array.isArray(data.sessions)) return data.sessions;
  return [];
}

function baseVmPayload(offlineSecs) {
  return {
    tag: "my-cloud-browser-main",
    start_url: "https://duckduckgo.com",
    timeout: { offline: offlineSecs || 300 },
    adblock: false,
    ublock: false
  };
}

function normalizeSession(s) {
  return {
    session_id: s.session_id || s.id,
    embed_url: s.embed_url,
    admin_token: s.admin_token,
    creation_date: s.creation_date
  };
}

// The "profile head" is the session id holding the newest saved browser profile
// (cookies, logins). Each new session loads the head and saves into itself,
// then becomes the new head, so logins carry forward forever.
async function getHead(env) {
  if (env.SAVES_KV) {
    try { const v = await env.SAVES_KV.get("profile_id_v2"); if (v) return v; } catch (e) {}
  }
  return globalThis.WORKER_PROFILE_ID_V2 || null;
}
async function setHead(env, id) {
  globalThis.WORKER_PROFILE_ID_V2 = id;
  if (env.SAVES_KV) {
    try { await env.SAVES_KV.put("profile_id_v2", id); } catch (e) {}
  }
}

async function hbCreate(apiKey, payload, zipBytes) {
  let resp;
  if (zipBytes) {
    // Custom extension upload: multipart form with `body` (JSON) + `ex` (zip). Don't set Content-Type manually.
    const form = new FormData();
    form.append("body", JSON.stringify(payload));
    form.append("ex", new Blob([zipBytes], { type: "application/zip" }), "ext.zip");
    resp = await fetch(HB_BASE, {
      method: "POST",
      headers: { "Authorization": "Bearer " + apiKey },
      body: form
    });
  } else {
    resp = await fetch(HB_BASE, {
      method: "POST",
      headers: hbHeaders(apiKey),
      body: JSON.stringify(payload)
    });
  }
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

// Simple KV-or-memory helpers (cookie sync)
async function kvGet(env, k) {
  if (env.SAVES_KV) {
    try { const v = await env.SAVES_KV.get(k); if (v) return v; } catch (e) {}
  }
  return globalThis["MEM_" + k] || null;
}
async function kvPut(env, k, v) {
  globalThis["MEM_" + k] = v;
  if (env.SAVES_KV) {
    try { await env.SAVES_KV.put(k, v); } catch (e) {}
  }
}

// GET /v0/vm only lists { id, creation_date }, so fetch each session for its embed_url / admin_token.
async function getSessionFull(apiKey, id) {
  const r = await fetch(HB_BASE + "/" + encodeURIComponent(id), { headers: { "Authorization": "Bearer " + apiKey } });
  if (!r.ok) return null;
  const d = await r.json().catch(() => null);
  return d ? Object.assign({ session_id: id }, d) : null;
}

async function getRunning(apiKey) {
  const r = await fetch(HB_BASE, { headers: { "Authorization": "Bearer " + apiKey } });
  const d = await r.json().catch(() => ({}));
  const items = listSessions(d).slice(0, 5);
  const full = await Promise.all(items.map(async (it) => {
    if (it.embed_url) return it;
    const f = await getSessionFull(apiKey, it.id || it.session_id);
    return f ? Object.assign({ creation_date: it.creation_date }, f) : null;
  }));
  return full.filter(f => f && f.embed_url && !f.termination_date).map(normalizeSession);
}

function humanDuration(secs) {
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600);
  if (d >= 1) return d + (d === 1 ? " day" : " days") + (h ? " " + h + " h" : "");
  const h2 = Math.floor(secs / 3600);
  return h2 >= 1 ? h2 + " h" : Math.max(1, Math.round(secs / 60)) + " min";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "*"
        }
      });
    }

    if (!globalThis.WORKER_SAVES) globalThis.WORKER_SAVES = [];
    if (!globalThis.WORKER_CLIPS) globalThis.WORKER_CLIPS = new Map();

    const apiKey = (env.HB_API_KEY || "").trim();
    const needsKey = path === "/api/launch" || path === "/api/active" || path === "/api/terminate";
    if (needsKey && !apiKey) {
      return json({ error: "HB_API_KEY secret is missing in Cloudflare settings" }, 500);
    }

    // ---------- Health ping ----------
    if (path === "/api/ping") return json({ ok: true, t: Date.now() });

    // ---------- Clipboard Bridge ----------
    if (path === "/api/clip" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => ({}));
        const text = String(body.text || "");
        if (!text) return json({ status: "error", error: "Empty text" }, 400);

        let rawUrl = "";
        let viewUrl = "";

        try {
          if (body.private) throw new Error("private clip: never send to a public paste site");
          const form = new URLSearchParams();
          form.append("content", text);
          form.append("format", "url");
          form.append("expiry_days", "1");
          const dpResp = await fetch("https://dpaste.org/api/", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: form.toString()
          });
          if (dpResp.ok) {
            const dpUrl = (await dpResp.text()).trim().replace(/"/g, "");
            if (dpUrl.startsWith("http")) {
              rawUrl = dpUrl.endsWith("/") ? dpUrl + "raw" : dpUrl + "/raw";
              viewUrl = dpUrl;
            }
          }
        } catch (e) {}

        if (!rawUrl) {
          const clipId = "clip_" + Date.now().toString(36);
          globalThis.WORKER_CLIPS.set(clipId, text);
          if (env.SAVES_KV) {
            try { await env.SAVES_KV.put("clip:" + clipId, text, { expirationTtl: 3600 }); } catch (e) {}
          }
          rawUrl = url.origin + "/api/clip-raw?id=" + clipId;
          viewUrl = url.origin + "/clip?id=" + clipId;
        }
        return json({ status: "ok", rawUrl, viewUrl, kv: !!env.SAVES_KV });
      } catch (e) {
        return json({ status: "error", error: e.message }, 500);
      }
    }

    if (path === "/api/clip-raw") {
      const cors = { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" };
      const src = url.searchParams.get("src");
      if (src) {
        // Proxy dpaste server-side (dpaste sends no CORS headers, so the VM's browser can't fetch it directly).
        try {
          const u = new URL(src);
          if (u.protocol !== "https:" || !/(^|\.)dpaste\.org$/.test(u.hostname)) {
            return new Response("Blocked host", { status: 400, headers: cors });
          }
          const r = await fetch(u.toString());
          const t = await r.text();
          return new Response(r.ok ? t : "Upstream error " + r.status, { status: r.ok ? 200 : 502, headers: cors });
        } catch (e) {
          return new Response("Proxy error: " + e.message, { status: 502, headers: cors });
        }
      }
      const clipId = url.searchParams.get("id");
      let text = globalThis.WORKER_CLIPS.get(clipId);
      if (!text && env.SAVES_KV && clipId) {
        try { text = await env.SAVES_KV.get("clip:" + clipId); } catch (e) {}
      }
      return new Response(text || "Clip expired or not found.", { headers: cors });
    }

    // VM -> iPad clipboard bridge: a helper page opened inside the VM; you "paste" into it and it posts the text here.
    if (path === "/clip-out") {
      return new Response(CLIPOUT_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (path === "/api/clipout") {
      const cid = url.searchParams.get("cid") || "";
      const okId = /^[a-z0-9]{8,40}$/i.test(cid);
      if (request.method === "POST") {
        const b = await request.json().catch(() => ({}));
        const id = String(b.cid || "");
        if (!/^[a-z0-9]{8,40}$/i.test(id)) return json({ error: "Bad id" }, 400);
        const text = String(b.text || "");
        if (!text || text.length > 2000000) return json({ error: "Empty or too large" }, 400);
        globalThis.WORKER_CLIPS.set("out_" + id, text);
        if (env.SAVES_KV) {
          try { await env.SAVES_KV.put("clipout:" + id, text, { expirationTtl: 120 }); } catch (e) {}
        }
        return json({ ok: true });
      }
      if (request.method === "GET") {
        if (!okId) return json({ error: "Bad id" }, 400);
        let text = globalThis.WORKER_CLIPS.get("out_" + cid);
        if (!text && env.SAVES_KV) {
          try { text = await env.SAVES_KV.get("clipout:" + cid); } catch (e) {}
        }
        if (!text) return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
        globalThis.WORKER_CLIPS.delete("out_" + cid);                        // one-time read
        if (env.SAVES_KV) { try { await env.SAVES_KV.delete("clipout:" + cid); } catch (e) {} }
        return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
      }
      return json({ error: "Method not allowed" }, 405);
    }

    if (path === "/clip") {
      return new Response(CLIP_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // ---------- Cobalt ----------
    if (path === "/api/cobalt" && request.method === "POST") {
      try {
        const { targetUrl } = await request.json();
        const cobResp = await fetch("https://api.cobalt.tools/", {
          method: "POST",
          headers: {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
          },
          body: JSON.stringify({ url: targetUrl })
        });
        const data = await cobResp.json();
        return json(data);
      } catch (e) {
        return json({ status: "error", error: e.message }, 500);
      }
    }

    // ---------- Media proxy ----------
    if (path === "/api/proxy-video") {
      const targetUrl = url.searchParams.get("url");
      const referer = url.searchParams.get("ref") || targetUrl;
      if (!targetUrl) return new Response("Missing URL", { status: 400 });
      try {
        const fh = new Headers();
        fh.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
        if (referer) {
          try {
            fh.set("Referer", referer);
            fh.set("Origin", new URL(referer).origin);
          } catch (e) {}
        }
        const clientRange = request.headers.get("Range");
        if (clientRange) fh.set("Range", clientRange);

        const videoResp = await fetch(targetUrl, { headers: fh });
        const out = new Headers(videoResp.headers);
        out.set("Access-Control-Allow-Origin", "*");
        out.set("Access-Control-Allow-Headers", "*");
        out.set("Accept-Ranges", "bytes");
        return new Response(videoResp.body, { status: videoResp.status, headers: out });
      } catch (e) {
        return new Response("Proxy error: " + e.message, { status: 500 });
      }
    }

    // ---------- Saves ----------
    if (path === "/api/saves") {
      let saves = globalThis.WORKER_SAVES || [];
      if (env.SAVES_KV) {
        try {
          const kvData = await env.SAVES_KV.get("user_saves");
          if (kvData) saves = JSON.parse(kvData);
        } catch (e) {}
      }
      const persist = async () => {
        globalThis.WORKER_SAVES = saves;
        if (env.SAVES_KV) {
          try { await env.SAVES_KV.put("user_saves", JSON.stringify(saves)); } catch (e) {}
        }
      };

      if (request.method === "GET") return json(saves);

      if (request.method === "POST") {
        const newSave = await request.json().catch(() => null);
        if (!newSave || !newSave.id) return json({ error: "Invalid save" }, 400);
        const idx = saves.findIndex(s => s.id === newSave.id);
        if (idx >= 0) saves[idx] = newSave; else saves.unshift(newSave);
        await persist();
        return json(saves);
      }

      if (request.method === "DELETE") {
        const { id } = await request.json().catch(() => ({}));
        saves = saves.filter(s => s.id !== id);
        await persist();
        return json(saves);
      }
    }

    // ---------- Active sessions ----------
    if (path === "/api/active" && request.method === "GET") {
      try {
        const running = await getRunning(apiKey);
        return json(running.map(normalizeSession));
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // ---------- Sleep / wake: change how long the VM survives with nobody connected ----------
    if (path === "/api/sleep" && request.method === "POST") {
      try {
        const b = await request.json().catch(() => ({}));
        if (!b.sessionId) return json({ error: "Missing sessionId" }, 400);
        const full = await getSessionFull(apiKey, b.sessionId);
        if (!full || !full.embed_url || full.termination_date) return json({ error: "That VM is not running any more" }, 404);

        const base = full.embed_url.split("?")[0];
        const normal = parseInt(env.HB_OFFLINE_SECS || "300", 10) || 300;
        const ladder = b.mode === "wake"
          ? [normal]
          : (env.HB_SLEEP_SECS ? [parseInt(env.HB_SLEEP_SECS, 10)] : [604800, 172800, 86400, 43200, 21600, 7200]);
        const tokens = [full.admin_token, apiKey].filter(Boolean);

        let lastErr = "";
        for (const secs of ladder) {
          let authFails = 0;
          for (const tok of tokens) {
            let authFailed = false;
            for (const shape of [{ offline: secs, reset: true }, { offline: secs }]) {
              const r = await fetch(base + "/timeout", {
                method: "POST",
                headers: { "Authorization": "Bearer " + tok, "Content-Type": "application/json" },
                body: JSON.stringify(shape)
              });
              if (r.ok) return json({ ok: true, mode: b.mode || "sleep", offline: secs, label: humanDuration(secs) });
              lastErr = "HTTP " + r.status + " " + (await r.text().catch(() => "")).slice(0, 160);
              if (r.status === 401 || r.status === 403) { authFailed = true; break; }
            }
            if (authFailed) { authFails++; continue; }
            break;                                   // value/shape rejected: try the next smaller value
          }
          if (authFails >= tokens.length) break;      // neither token is accepted: smaller values won't help
        }
        return json({ error: "Hyperbeam refused the timeout change (" + lastErr + ")" }, 502);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // ---------- Terminate ----------
    if (path === "/api/terminate" && request.method === "POST") {
      try {
        const { sessionId } = await request.json();
        if (!sessionId) return json({ error: "Missing sessionId" }, 400);
        const resp = await fetch(HB_BASE + "/" + encodeURIComponent(sessionId), {
          method: "DELETE",
          headers: { "Authorization": "Bearer " + apiKey }
        });
        const data = await resp.json().catch(() => ({ status: "ok" }));
        return json(data);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // ---------- Launch ----------
    if (path === "/api/launch" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => ({}));
        const profileId = body.lastSessionId || null;

        // Already running somewhere (this or another device)? Hand it back instead of creating another.
        try {
          const already = await getRunning(apiKey);
          if (already.length > 0) return json(Object.assign({}, already[0], { profile_note: "already-running" }));
        } catch (e) {}

        const isLimit = (d) => d && (d.code === "err_max_sessions" || d.code === "err_rate_limited");
        const recover = async () => {
          const running = await getRunning(apiKey);
          if (running.length > 0) return normalizeSession(running[0]);
          return null;
        };

        // Prefer the newest profile in the chain; fall back to the save's id.
        const head = (await getHead(env)) || profileId;

        // Hyperbeam's documented formats (docs.hyperbeam.com/guides/persist-session-state):
        //   profile: true         -> create a NEW saved profile (tied to the returned session_id)
        //   profile: "<id>"       -> load that profile AND update it when this session ends
        // The profile id stays the ORIGINAL session_id forever. { save: true } is not valid:
        // in the object form, save/load take session ids, not booleans.
        // Optional: set HB_OFFLINE_SECS in Worker variables to keep a VM alive longer after you leave
        // (lets you reconnect to the SAME logged-in VM; costs free minutes while idle).
        const normalOffline = parseInt(env.HB_OFFLINE_SECS || "300", 10) || 300;
        const sleepSecs = parseInt(env.HB_SLEEP_SECS || "86400", 10) || 86400;
        // Sleep-proof (default): the VM is CREATED with a long offline timeout, so it survives closing the page
        // even if changing the timeout later (the Sleep button) ever fails.
        const sleepProof = body.sleepProof !== false;
        const offline = sleepProof ? sleepSecs : normalOffline;
        const meta = (att) => ({
          sleep_proof: !!(att.payload.timeout && att.payload.timeout.offline > normalOffline),
          offline_secs: att.payload.timeout && att.payload.timeout.offline
        });
        // Cookie-sync extension: only used when saved profiles are unavailable.
        const wantSync = body.cookieSync !== false;
        const zip = wantSync ? makeZip(extensionFiles(url.origin, await syncToken(apiKey))) : null;

        let attempts = [];
        if (head) attempts.push({ kind: "profile", payload: Object.assign(baseVmPayload(offline), { profile: head }), newProfile: false });
        attempts.push({ kind: "profile", payload: Object.assign(baseVmPayload(offline), { profile: true }), newProfile: true });
        if (zip) attempts.push({ kind: "ext", payload: Object.assign(baseVmPayload(offline), { extension: { field: "ex" } }), zip });
        attempts.push({ kind: "plain", payload: baseVmPayload(offline) });
        let profileErr = "", extErr = "";

        let last = null;
        for (const att of attempts) {
          if (att.kind === "profile" && /restricted/i.test(profileErr)) continue;   // don't keep hammering a gated feature
          let r = await hbCreate(apiKey, att.payload, att.zip);
          const errTxt = JSON.stringify(r.data || {});
          if (!(r.data && r.data.embed_url) && att.payload.timeout && att.payload.timeout.offline > 3600 &&
              !/restricted/i.test(errTxt) && /timeout|offline|invalid|argument/i.test(errTxt)) {
            att.payload.timeout.offline = 3600;          // Hyperbeam didn't like the long value: retry with its default
            r = await hbCreate(apiKey, att.payload, att.zip);
          }
          last = r;
          if (r.data && r.data.embed_url) {
            if (att.kind === "ext") {
              return json(Object.assign(Object.assign(normalizeSession(r.data), meta(att)), {
                profile_note: "cookie-sync",
                kv: !!env.SAVES_KV
              }));
            }
            if (att.kind === "plain") {
              return json(Object.assign(Object.assign(normalizeSession(r.data), meta(att)), {
                profile_note: extErr ? "extension-failed" : (/restricted/i.test(profileErr) ? "profiles-restricted" : "profile-failed"),
                profile_error: extErr || profileErr
              }));
            }
            // New profile => its id is this session_id. Loaded profile => id unchanged.
            const profileUsed = att.newProfile ? r.data.session_id : att.payload.profile;
            if (att.newProfile) await setHead(env, r.data.session_id);
            return json(Object.assign(Object.assign(normalizeSession(r.data), meta(att)), {
              profile_id: profileUsed,
              profile_note: (!att.newProfile ? "loaded" : (head ? "stale-profile-recreated" : "created"))
            }));
          }
          if (isLimit(r.data)) {
            const existing = await recover();
            if (existing) return json(existing);
            break;
          }
          const msg = (r.data && (r.data.message || r.data.code)) || ("HTTP " + r.status);
          if (att.kind === "profile") profileErr = msg;
          else if (att.kind === "ext") extErr = msg;
        }

        const d = (last && last.data) || {};
        throw new Error(d.message || d.code || ("Hyperbeam returned HTTP " + (last ? last.status : "?")));
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // ---------- Cookie sync (called by the extension running inside the VM) ----------
    if (path === "/api/cookies-status") {
      let meta = null;
      try { meta = JSON.parse((await kvGet(env, "cookies_meta_v1")) || "null"); } catch (e) {}
      return json({ count: meta ? meta.count : 0, updated: meta ? meta.updated : null, kv: !!env.SAVES_KV });
    }

    if (path === "/api/cookies") {
      if (!apiKey) return json({ error: "HB_API_KEY missing" }, 500);
      const tok = await syncToken(apiKey);
      if ((request.headers.get("X-Sync-Token") || "") !== tok) return json({ error: "Unauthorized" }, 401);

      if (request.method === "GET") {
        const blob = await kvGet(env, "cookies_v1");
        if (!blob) return json({ cookies: [] });
        try {
          const text = await decryptCookies(apiKey, blob);
          return new Response(text, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
        } catch (e) {
          return json({ cookies: [], error: "decrypt failed" });
        }
      }

      if (request.method === "PUT" || request.method === "POST") {
        const body = await request.json().catch(() => null);
        if (!body || !Array.isArray(body.cookies)) return json({ error: "Bad payload" }, 400);
        const text = JSON.stringify({ cookies: body.cookies.slice(0, 6000) });
        if (text.length > 4000000) return json({ error: "Too large" }, 413);

        const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
        const hash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
        let meta = null;
        try { meta = JSON.parse((await kvGet(env, "cookies_meta_v1")) || "null"); } catch (e) {}
        if (meta && meta.hash === hash) return json({ ok: true, unchanged: true });   // spare KV writes

        await kvPut(env, "cookies_v1", await encryptCookies(apiKey, text));
        await kvPut(env, "cookies_meta_v1", JSON.stringify({ count: body.cookies.length, updated: Date.now(), hash }));
        return json({ ok: true, count: body.cookies.length, persistent: !!env.SAVES_KV });
      }
      return json({ error: "Method not allowed" }, 405);
    }

    // ---------- Vault (end-to-end encrypted blob; server never sees the passphrase or plaintext) ----------
    if (path === "/api/vault") {
      const BLOB_KEY = "vault_v1", AUTH_KEY = "vault_auth_v1";
      const load = async (k) => {
        if (env.SAVES_KV) {
          try { const v = await env.SAVES_KV.get(k); if (v) return v; } catch (e) {}
        }
        return globalThis["MEM_" + k] || null;
      };
      const store = async (k, v) => {
        globalThis["MEM_" + k] = v;
        if (env.SAVES_KV) {
          try { await env.SAVES_KV.put(k, v); } catch (e) {}
        }
      };
      const sha256hex = async (str) => {
        const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
      };

      if (request.method === "GET") {
        const v = await load(BLOB_KEY);
        return new Response(v || JSON.stringify({ empty: true }), {
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
        });
      }

      if (request.method === "PUT" || request.method === "POST") {
        const token = request.headers.get("X-Vault-Auth") || "";
        if (token.length < 20) return json({ error: "Missing vault credentials" }, 400);
        const hash = await sha256hex(token);
        const existing = await load(AUTH_KEY);
        if (existing && existing !== hash) return json({ error: "Wrong vault credentials" }, 403);

        const body = await request.json().catch(() => null);
        if (!body || typeof body.salt !== "string" || typeof body.iv !== "string" || typeof body.data !== "string") {
          return json({ error: "Bad vault payload" }, 400);
        }
        if (body.data.length > 200000) return json({ error: "Vault too large" }, 413);

        if (!existing) await store(AUTH_KEY, hash);
        await store(BLOB_KEY, JSON.stringify({ salt: body.salt, iv: body.iv, data: body.data }));
        return json({ ok: true, persistent: !!env.SAVES_KV });
      }

      return json({ error: "Method not allowed" }, 405);
    }

    // ---------- Client JS ----------
    if (path === "/client.js") {
      return new Response(CLIENT_JS, {
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "no-cache, no-store, must-revalidate"
        }
      });
    }

    // ---------- Frontend ----------
    return new Response(INDEX_HTML, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate"
      }
    });
  }
};

// =====================================================================
// Clipboard bridge page
// =====================================================================
const CLIP_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VM Clipboard Bridge</title>
  <style>
    body { background: #0c0a14; color: #f4f4f7; font-family: monospace; padding: 24px; text-align: center; }
    h2 { color: #c4b5fd; margin-bottom: 8px; font-size: 20px; }
    p { font-size: 13px; color: #a1a1aa; margin-bottom: 14px; }
    button { background: linear-gradient(135deg, #8b5cf6, #6d28d9); color: white; border: none; padding: 14px 28px; font-size: 15px; font-weight: bold; border-radius: 10px; cursor: pointer; margin-bottom: 12px; }
    button:active { transform: scale(0.98); }
    textarea { width: 100%; height: 62vh; background: #161421; color: #7dd3fc; border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; padding: 14px; font-family: monospace; font-size: 13px; outline: none; }
    #toast { display: none; color: #34d399; font-weight: bold; font-size: 15px; margin-bottom: 10px; }
  </style>
</head>
<body>
  <h2>📋 VM Clipboard Bridge</h2>
  <p>Text loaded across global servers. Tap copy below, then switch to your Cloudflare tab and press <strong>Ctrl+V</strong>.</p>
  <div id="toast">✅ COPIED TO VM CLIPBOARD! Switch to your Cloudflare tab and press Ctrl+V!</div>
  <button id="copyBtn">📋 COPY ALL CODE TO VM CLIPBOARD</button>
  <textarea id="box" placeholder="Loading content..."></textarea>
  <script>
    document.addEventListener("DOMContentLoaded", function () {
      var params = new URLSearchParams(window.location.search);
      var srcUrl = params.get("src") ? "/api/clip-raw?src=" + encodeURIComponent(params.get("src")) : (params.get("id") ? "/api/clip-raw?id=" + encodeURIComponent(params.get("id")) : "");
      var box = document.getElementById("box");
      var toast = document.getElementById("toast");

      var hash = location.hash.slice(1);
      if (params.get("inline") && hash) {
        // Inline clip: the text travels inside the URL fragment, so no server storage is needed
        try {
          var bin = atob(hash.replace(/-/g, "+").replace(/_/g, "/"));
          var bytes = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          box.value = new TextDecoder().decode(bytes);
          box.focus();
          box.select();
        } catch (e) { box.value = "Failed to decode clip: " + e.message; }
      } else if (srcUrl) {
        fetch(srcUrl).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); }).then(function (txt) {
          box.value = txt;
          box.focus();
          box.select();
        }).catch(function (err) {
          box.value = "Failed to load: " + err.message;
        });
      }

      document.getElementById("copyBtn").addEventListener("click", function () {
        box.focus();
        box.select();
        box.setSelectionRange(0, 99999999);
        var copied = false;
        try { copied = document.execCommand("copy"); } catch (e) {}
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(box.value).then(function () {
            toast.style.display = "block";
          }).catch(function () {
            if (copied) toast.style.display = "block";
          });
        } else if (copied) {
          toast.style.display = "block";
        }
      });
    });
  </script>
</body>
</html>`;

const CLIPOUT_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>VM Copy-Back Helper</title>
  <style>
    body { background: #0c0a14; color: #f4f4f7; font-family: monospace; padding: 16px; }
    h3 { color: #c4b5fd; margin-bottom: 6px; }
    #st { color: #a1a1aa; font-size: 13px; margin-bottom: 8px; }
    textarea { width: 100%; height: 70vh; background: #161421; color: #7dd3fc; border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; padding: 12px; font-size: 13px; outline: none; }
  </style>
</head>
<body>
  <h3>📥 VM Copy-Back Helper</h3>
  <div id="st">Waiting for paste (Ctrl+V)...</div>
  <textarea id="b" placeholder="Paste here with Ctrl+V"></textarea>
  <script>
    document.addEventListener("DOMContentLoaded", function () {
      var cid = new URLSearchParams(location.search).get("cid") || "";
      var b = document.getElementById("b"), st = document.getElementById("st"), tmr = null;
      b.focus();
      function send() {
        var t = b.value;
        if (!t) return;
        fetch("/api/clipout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cid: cid, text: t }) })
          .then(function (r) { st.textContent = r.ok ? "✅ Sent (" + t.length + " chars). You can close this tab." : "❌ Failed: HTTP " + r.status; })
          .catch(function (e) { st.textContent = "❌ Failed: " + e.message; });
      }
      function schedule() { clearTimeout(tmr); tmr = setTimeout(send, 250); }
      b.addEventListener("input", schedule);
      b.addEventListener("paste", schedule);
    });
  </script>
</body>
</html>`;

// =====================================================================
// Main page (HTML + CSS only; behaviour lives in /client.js)
// =====================================================================
const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <title>Hyperbeam Cloud Browser Pro</title>
  <style>
    :root {
      --bg-dark: #0a0a0f;
      --bg-surface: rgba(18, 18, 26, 0.92);
      --border-subtle: rgba(255, 255, 255, 0.08);
      --accent: #8b5cf6;
      --text-main: #f4f4f7;
      --text-muted: #a1a1aa;
      --topbar-height: 44px;
      --sidebar-width: 240px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent; }
    body, html { width: 100%; height: 100%; background: var(--bg-dark); color: var(--text-main); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; overflow: hidden; }

    #topbar { height: var(--topbar-height); background: var(--bg-surface); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); display: flex; align-items: center; justify-content: space-between; padding: 0 10px; border-bottom: 1px solid var(--border-subtle); z-index: 100; position: relative; }
    .brand-group { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--text-muted); }
    .session-stats { display: flex; gap: 8px; }
    .badge-green { background: #14532d; color: #4ade80; padding: 2px 6px; border-radius: 4px; font-weight: 600; }
    .ping-text { color: #34d399; font-weight: 600; }
    .nav-buttons { display: flex; align-items: center; gap: 5px; flex-wrap: nowrap; overflow-x: auto; }

    .btn { background: rgba(255,255,255,0.08); color: var(--text-main); border: 1px solid var(--border-subtle); padding: 5px 9px; border-radius: 6px; font-size: 11px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; touch-action: manipulation; }
    .btn:active { transform: scale(0.97); }
    .btn:disabled { opacity: 0.6; cursor: wait; }
    .btn-primary { background: linear-gradient(135deg, #8b5cf6, #7c3aed); color: white; border: none; }
    .btn-save { background: rgba(59,130,246,0.15); color: #93c5fd; border-color: rgba(59,130,246,0.3); }
    .btn-restore { background: rgba(16,185,129,0.15); color: #6ee7b7; border-color: rgba(16,185,129,0.3); }
    .btn-media { background: rgba(168,85,247,0.15); color: #d8b4fe; border-color: rgba(168,85,247,0.3); }
    .btn-danger { background: rgba(239,68,68,0.15); color: #fca5a5; border-color: rgba(239,68,68,0.3); }
    .btn.active-toggle { background: rgba(139,92,246,0.35); border-color: rgba(139,92,246,0.7); }

    .dropdown { background: rgba(255,255,255,0.08); color: var(--text-main); border: 1px solid var(--border-subtle); border-radius: 6px; padding: 4px 6px; font-size: 11px; outline: none; }
    .dropdown option { background: #161421; color: white; }

    #workspace { display: flex; width: 100%; height: calc(100% - var(--topbar-height)); position: relative; overflow: hidden; }
    #stream-wrapper { flex: 1; height: 100%; position: relative; background: #000; overflow: hidden; display: flex; align-items: center; justify-content: center; }
    #stream-container { width: 100%; height: 100%; position: relative; display: flex; align-items: center; justify-content: center; cursor: crosshair; }
    #stream-container video, #stream-container iframe { width: 100%; height: 100%; object-fit: contain; }
    body.cursor-hidden #stream-container { cursor: none; }

    #hardware-cursor { position: absolute; top: 0; left: 0; width: 20px; height: 20px; pointer-events: none; z-index: 400; transform: translate3d(-100px,-100px,0); transition: opacity 0.3s ease; opacity: 0; display: none; }
    #hardware-cursor svg { width: 100%; height: 100%; filter: drop-shadow(0 2px 3px rgba(0,0,0,0.85)); }

    /* Trackpad sidebar: hidden by default, JS adds .show-trackpad (touch devices on load, or via toggle) */
    #trackpad-sidebar { width: var(--sidebar-width); height: 100%; background: #14121d; border-left: 1px solid var(--border-subtle); display: none; flex-direction: column; padding: 10px; gap: 8px; }
    body.show-trackpad #trackpad-sidebar { display: flex; }

    .slider-box { display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: var(--text-muted); }
    .slider-box input { width: 105px; accent-color: var(--accent); }

    #trackpad-surface { flex: 1; background: #0d0b14; border: 1px solid var(--border-subtle); border-radius: 12px; position: relative; display: flex; align-items: center; justify-content: center; touch-action: none; }
    #trackpad-surface > svg { width: 40px; height: 40px; fill: #48435c; pointer-events: none; }
    .scroll-controls { position: absolute; right: 6px; top: 8px; bottom: 8px; display: flex; flex-direction: column; justify-content: space-between; }
    .scroll-btn { width: 34px; height: 44px; background: #232034; border: 1px solid #332e4a; border-radius: 6px; color: #a1a1aa; display: flex; align-items: center; justify-content: center; font-size: 13px; cursor: pointer; touch-action: none; }
    .scroll-btn:active { background: #35304f; }

    .btn-row { display: flex; gap: 6px; height: 42px; }
    .tp-btn { flex: 1; background: #7c65c1; color: white; border: none; border-radius: 8px; display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 12px; font-weight: 600; cursor: pointer; touch-action: manipulation; }
    .tp-btn:active { background: #644fa6; transform: scale(0.97); }

    .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.75); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); z-index: 800; display: none; align-items: center; justify-content: center; padding: 16px; }
    .modal-box { background: #181624; border: 1px solid rgba(255,255,255,0.15); border-radius: 14px; max-width: 500px; width: 100%; max-height: 80vh; display: flex; flex-direction: column; padding: 18px; color: var(--text-main); }
    .modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .modal-body { flex: 1; overflow-y: auto; margin-bottom: 12px; display: flex; flex-direction: column; gap: 8px; }

    .save-card { background: #201e2e; border: 1px solid #2e2a42; border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 6px; }
    .save-card-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .tab-pill { display: block; background: #12101b; color: #a78bfa; padding: 2px 8px; border-radius: 4px; font-size: 11px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin: 2px 0; }
    .empty-note { text-align: center; color: #a1a1aa; padding: 20px; font-size: 13px; }

    #clipTextArea { width: 100%; height: 180px; background: #100e1a; color: #a5f3fc; border: 1px solid #332f48; border-radius: 8px; padding: 10px; font-family: monospace; font-size: 16px; outline: none; user-select: auto; -webkit-user-select: auto; }

    #video-theater { position: absolute; inset: 0; background: #000; z-index: 500; display: none; flex-direction: column; }
    #theater-bar { height: 44px; background: #161421; display: flex; align-items: center; justify-content: space-between; padding: 0 12px; border-bottom: 1px solid #282438; color: #e4e4e7; font-size: 13px; }
    #theater-view { flex: 1; width: 100%; height: calc(100% - 44px); display: flex; align-items: center; justify-content: center; background: #000; }

    #splash { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; color: white; background: radial-gradient(circle at center, #181528 0%, #0a0a0f 100%); z-index: 50; padding: 20px; text-align: center; }
    .splash-logo { width: 60px; height: 60px; border-radius: 16px; background: linear-gradient(135deg, #8b5cf6, #4f46e5); display: flex; align-items: center; justify-content: center; margin-bottom: 14px; }
    .splash-logo svg { width: 32px; height: 32px; fill: white; }
    .splash-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }

    #boot-overlay { position: absolute; inset: 0; z-index: 60; display: none; flex-direction: column; align-items: center; justify-content: center; background: rgba(10,10,15,0.88); color: #c4b5fd; font-size: 15px; font-weight: 600; gap: 12px; }
    .spinner { width: 28px; height: 28px; border: 3px solid rgba(196,181,253,0.25); border-top-color: #c4b5fd; border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    #toast-host { position: fixed; top: 52px; left: 50%; transform: translateX(-50%); z-index: 2000; display: flex; flex-direction: column; gap: 8px; align-items: center; width: calc(100% - 24px); max-width: 460px; pointer-events: none; }
    .toast { pointer-events: auto; width: 100%; padding: 10px 14px; border-radius: 10px; font-size: 13px; font-weight: 600; line-height: 1.35; color: #fff; background: #27243a; border: 1px solid rgba(255,255,255,0.18); box-shadow: 0 8px 24px rgba(0,0,0,0.5); opacity: 0; transform: translateY(-8px); transition: opacity 0.25s ease, transform 0.25s ease; user-select: text; -webkit-user-select: text; word-break: break-word; }
    .toast.show { opacity: 1; transform: translateY(0); }
    .toast.success { background: #064e3b; border-color: #10b981; }
    .toast.error { background: #7f1d1d; border-color: #ef4444; }
    .toast.info { background: #1e1b4b; border-color: #6366f1; }

    #hiddenKeyboardInput { position: fixed; top: 0; left: 0; width: 1px; height: 1px; opacity: 0.01; border: none; outline: none; background: transparent; color: transparent; font-size: 16px; pointer-events: auto; z-index: 1; }

    #loginPanel { position: absolute; top: 8px; right: 8px; width: 290px; max-height: calc(100% - 16px); overflow-y: auto; background: #181624; border: 1px solid rgba(255,255,255,0.18); border-radius: 12px; padding: 12px; z-index: 450; display: none; box-shadow: 0 10px 30px rgba(0,0,0,0.6); user-select: auto; -webkit-user-select: auto; }
    body.show-trackpad #loginPanel { right: calc(var(--sidebar-width) + 8px); }
    #clipPanel { position: absolute; top: 8px; right: 8px; width: 300px; max-height: calc(100% - 16px); overflow-y: auto; background: #181624; border: 1px solid rgba(255,255,255,0.18); border-radius: 12px; padding: 12px; z-index: 460; display: none; box-shadow: 0 10px 30px rgba(0,0,0,0.6); user-select: auto; -webkit-user-select: auto; }
    body.show-trackpad #clipPanel { right: calc(var(--sidebar-width) + 8px); }
    #miniMenu { position: fixed; z-index: 900; display: none; gap: 6px; flex-wrap: wrap; max-width: 330px; padding: 8px; background: #1d1a2e; border: 1px solid rgba(255,255,255,0.22); border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.65); }
    .mm-btn { background: #2b2745; color: #fff; border: 1px solid #3d3860; border-radius: 8px; padding: 10px 12px; font-size: 13px; font-weight: 700; cursor: pointer; touch-action: manipulation; }
    .mm-btn:active { background: #433d70; transform: scale(0.97); }
    .mm-accent { background: #5b3fd0; border-color: #7c65c1; }
    #selectAllBtn { -webkit-touch-callout: none; }
    .lp-note { font-size: 11.5px; color: #a1a1aa; margin-bottom: 8px; }
    .lp-input { width: 100%; background: #100e1a; color: #e4e4e7; border: 1px solid #332f48; border-radius: 8px; padding: 9px; font-size: 16px; margin-bottom: 8px; outline: none; user-select: text; -webkit-user-select: text; }
    .acct-card { background: #201e2e; border: 1px solid #2e2a42; border-radius: 8px; padding: 8px; margin-bottom: 6px; }
    .acct-title { font-size: 13px; font-weight: 700; color: #c4b5fd; }
    .acct-sub { font-size: 11px; color: #a1a1aa; margin-bottom: 6px; word-break: break-all; }
    .acct-row { display: flex; gap: 5px; }
    .acct-row .btn { flex: 1; justify-content: center; padding: 8px 4px; font-size: 12px; }

    @media (max-width: 860px) { .session-stats { display: none; } }
  </style>
</head>
<body>
  <input type="text" id="hiddenKeyboardInput" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
  <div id="toast-host"></div>

  <div id="topbar">
    <div class="brand-group">
      <span class="badge-green">AFK Guard</span>
      <span class="ping-text" id="pingBadge">⚡ --ms</span>
      <div class="session-stats">
        <span>Session: <strong id="sessionTimer" style="color:white">00:00:00</strong></span>
        <span>Used: <strong id="usedMins" style="color:white">0</strong>/10k m</span>
      </div>
    </div>

    <div class="nav-buttons">
      <select class="dropdown" id="resSelect">
        <option value="540p">540p</option>
        <option value="720p" selected>720p</option>
        <option value="900p">900p</option>
        <option value="1080p">1080p</option>
      </select>
      <select class="dropdown" id="audioBoostSelect">
        <option value="1.0">🔊 100%</option>
        <option value="1.5">🔊 150%</option>
        <option value="2.0">🔊 200%</option>
        <option value="3.0">🔊 300%</option>
      </select>
      <button class="btn btn-save" id="saveBtn" type="button">💾 Save</button>
      <button class="btn btn-restore" id="restoreBtn" type="button">⚡ Restore</button>
      <button class="btn btn-media" id="fetchMediaBtn" type="button">🎬 Video</button>
      <button class="btn" id="pasteBtn" type="button">📋 Paste</button>
      <button class="btn" id="trackpadToggleBtn" type="button">🖲️ Trackpad</button>
      <button class="btn" id="reconnectBtn" type="button">🔄 Reconnect</button>
      <button class="btn" id="loginBtn" type="button">🔐 Login</button>
      <button class="btn" id="clipsBtn" type="button">📚 Clips</button>
      <button class="btn" id="sleepBtn" type="button">😴 Sleep</button>
      <button class="btn btn-danger" id="stopBtn" type="button">🛑 Stop</button>
    </div>
  </div>

  <div id="workspace">
    <div id="stream-wrapper">
      <div id="stream-container"></div>

      <div id="hardware-cursor">
        <svg viewBox="0 0 24 24">
          <path d="M0 0 L15 12 L8 13 L12 21 L9 22 L5 14 L0 18 Z" fill="#ffffff" stroke="#000000" stroke-width="1.3" stroke-linejoin="round"/>
        </svg>
      </div>

      <div id="video-theater">
        <div id="theater-bar">
          <span id="theater-title">🎬 Native 60 FPS Player</span>
          <button class="btn btn-danger" id="theaterCloseBtn" type="button">✕ Close</button>
        </div>
        <div id="theater-view"></div>
      </div>

      <div id="boot-overlay"><div class="spinner"></div><div id="bootText">⏳ Booting VM...</div></div>

      <div id="splash">
        <div class="splash-logo">
          <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14.5v-9l6 4.5-6 4.5z"/></svg>
        </div>
        <h2 style="font-size:22px;margin-bottom:6px;">Hyperbeam Cloud Browser</h2>
        <p style="color:#a1a1aa;font-size:13px;max-width:340px;margin-bottom:20px;">
          High-performance isolated Chromium instance with zero-lag input piping and universal device support.
        </p>
        <div class="splash-actions">
          <button class="btn btn-restore" id="splashRestoreBtn" type="button" style="padding:10px 18px;font-size:13px;">⚡ Restore Workspace</button>
          <button class="btn btn-primary" id="splashLaunchBtn" type="button" style="padding:10px 22px;font-size:13px;">🚀 Launch Session</button>
        </div>
        <div id="reconnectRow" style="display:none;margin-top:14px;">
          <div id="runningInfo" style="font-size:13px;color:#6ee7b7;margin-bottom:8px;max-width:340px;"></div>
          <div class="splash-actions">
            <button class="btn" id="splashReconnectBtn" type="button" style="padding:10px 18px;font-size:13px;">🔗 Reconnect</button>
            <button class="btn btn-restore" id="splashWakeBtn" type="button" style="padding:10px 18px;font-size:13px;">☀️ Wake &amp; reconnect</button>
          </div>
        </div>
      </div>
    </div>

    <div id="clipPanel">
      <div class="modal-header" style="margin-bottom:8px;">
        <strong style="color:#c4b5fd;">📚 Clipboards</strong>
        <button class="btn" id="clipPanelClose" type="button">✕</button>
      </div>
      <div class="acct-row" style="margin-bottom:8px;">
        <button class="btn" id="cpCopy" type="button">Ctrl+C</button>
        <button class="btn" id="cpPaste" type="button">Ctrl+V</button>
        <button class="btn btn-primary" id="cpGrab" type="button">📥 Grab</button>
      </div>
      <p class="lp-note">📥 Grab = copy in the VM first, then tap Grab: it lands on your iPad clipboard and is saved here.</p>
      <textarea class="lp-input" id="clipAddBox" placeholder="Or type/paste text to save..." style="height:56px;resize:none;"></textarea>
      <button class="btn" id="clipAddBtn" type="button" style="width:100%;justify-content:center;margin-bottom:8px;">💾 Save to Clips</button>
      <div id="clipList"></div>
    </div>

    <div id="loginPanel">
      <div class="modal-header" style="margin-bottom:8px;">
        <strong style="color:#c4b5fd;">🔐 Quick Login</strong>
        <button class="btn" id="loginCloseBtn" type="button">✕</button>
      </div>

      <div class="acct-card" style="margin-bottom:10px;">
        <label class="lp-note" style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">
          <input type="checkbox" id="sleepProofChk" checked> 🛡️ Sleep-proof launch (VM survives closing the page)
        </label>
        <label class="lp-note" style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">
          <input type="checkbox" id="cookieSyncChk" checked> 🍪 Cookie sync on launch (non-Google sites)
        </label>
        <button class="btn" id="cookieStatusBtn" type="button" style="width:100%;justify-content:center;">🔍 Check sync status</button>
        <div class="lp-note" id="cookieStatusText" style="margin:6px 0 0;"></div>
      </div>

      <div id="loginLocked">
        <p class="lp-note" id="vaultHint">Create a passphrase to encrypt your logins on this device.</p>
        <input class="lp-input" type="password" id="vaultPass" placeholder="Vault passphrase" autocomplete="off">
        <button class="btn btn-primary" id="vaultUnlockBtn" type="button" style="width:100%;justify-content:center;padding:9px;">🔓 Unlock</button>
      </div>

      <div id="loginUnlocked" style="display:none;">
        <p class="lp-note">1) Tap the field inside the VM &nbsp; 2) Tap a button below.</p>
        <label class="lp-note" style="display:flex;gap:6px;align-items:center;margin-bottom:8px;">
          <input type="checkbox" id="vaultEnter" checked> Press Enter after typing
        </label>
        <div id="vaultAccounts"></div>
        <button class="btn" id="addAcctToggle" type="button" style="width:100%;justify-content:center;margin-top:6px;">➕ Add account</button>
        <div id="addAcctForm" style="display:none;margin-top:8px;">
          <input class="lp-input" type="text" id="acctLabel" placeholder="Label (e.g. Main)" autocomplete="off">
          <input class="lp-input" type="text" id="acctEmail" placeholder="Email" autocomplete="off" autocapitalize="off">
          <input class="lp-input" type="password" id="acctPass" placeholder="Password" autocomplete="off">
          <input class="lp-input" type="text" id="acctTotp" placeholder="Authenticator key (optional)" autocomplete="off" autocapitalize="off">
          <button class="btn btn-primary" id="acctSaveBtn" type="button" style="width:100%;justify-content:center;padding:9px;">💾 Save account</button>
        </div>
        <button class="btn btn-danger" id="vaultLockBtn" type="button" style="width:100%;justify-content:center;margin-top:8px;">🔒 Lock</button>
      </div>
    </div>

    <div id="trackpad-sidebar">
      <div class="slider-box">
        <span>Speed: <strong id="sensValue" style="color:white">2.0x</strong></span>
        <input type="range" id="sensSlider" min="0.8" max="4.5" step="0.2" value="2.0">
      </div>

      <div id="trackpad-surface">
        <svg viewBox="0 0 24 24"><path d="M12 2l4 4h-3v4h4V7l4 4-4 4v-3h-4v4h3l-4 4-4-4h3v-4H7v3l-4-4 4-4v3h4V6H8z"/></svg>
        <div class="scroll-controls">
          <div class="scroll-btn" id="scrollUpBtn">▲</div>
          <div class="scroll-btn" id="scrollDownBtn">▼</div>
        </div>
      </div>

      <div class="btn-row">
        <button class="tp-btn" id="leftClickBtn" type="button">Left Click</button>
        <button class="tp-btn" id="rightClickBtn" type="button">Right Click</button>
      </div>

      <div class="btn-row">
        <button class="tp-btn" id="kbBtn" type="button">
          <svg style="width:16px;height:16px;fill:white;" viewBox="0 0 24 24"><path d="M20 5H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-9 3h2v2h-2V8zm0 3h2v2h-2v-2zM8 8h2v2H8V8zm0 3h2v2H8v-2zm-1 2H5v-2h2v2zm0-3H5V8h2v2zm9 7H8v-2h8v2zm0-4h-2v-2h2v2zm0-3h-2V8h2v2zm3 3h-2v-2h2v2zm0-3h-2V8h2v2z"/></svg>
          Keyboard
        </button>
        <button class="tp-btn" id="selectAllBtn" type="button">Select All</button>
      </div>
    </div>
  </div>

  <div id="miniMenu">
    <button class="mm-btn" id="mmCopy" type="button">Ctrl+C</button>
    <button class="mm-btn" id="mmPaste" type="button">Ctrl+V</button>
    <button class="mm-btn" id="mmCut" type="button">Ctrl+X</button>
    <button class="mm-btn mm-accent" id="mmGrab" type="button">📥 Copy back</button>
    <button class="mm-btn" id="mmClips" type="button">📚 Clips</button>
  </div>

  <div id="restoreModal" class="modal-overlay">
    <div class="modal-box">
      <div class="modal-header">
        <h3>⚡ Restore Saved Session</h3>
        <button class="btn" id="restoreCloseBtn" type="button">✕</button>
      </div>
      <div class="modal-body" id="savesListContainer"></div>
    </div>
  </div>

  <div id="clipboardModal" class="modal-overlay">
    <div class="modal-box">
      <div class="modal-header">
        <h3>📋 Paste to VM (Any Length / 15,000+ Words)</h3>
        <button class="btn" id="clipCloseBtn" type="button">✕</button>
      </div>
      <textarea id="clipTextArea" placeholder="Paste your text or code here..."></textarea>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:10px;">
        <button class="btn" id="clipCancelBtn" type="button">Cancel</button>
        <button class="btn btn-primary" id="transferClipBtn" type="button">🚀 Transfer to VM</button>
      </div>
    </div>
  </div>

  <!-- Tiny inline guard: surfaces ANY script error on screen, even if client.js fails to load/parse. -->
  <script>
    (function () {
      function show(msg) {
        var host = document.getElementById("toast-host");
        if (!host) return;
        var d = document.createElement("div");
        d.className = "toast error show";
        d.textContent = msg;
        host.appendChild(d);
        setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 9000);
      }
      window.__earlyToast = show;
      window.addEventListener("error", function (e) {
        if (e.target && e.target.tagName === "SCRIPT") show("Failed to load script: " + (e.target.src || ""));
        else show("Script error: " + (e.message || "unknown"));
      }, true);
      window.addEventListener("unhandledrejection", function (e) {
        show("Error: " + ((e.reason && e.reason.message) || e.reason || "unknown"));
      });
    })();
  </script>
  <script src="/client.js" defer></script>
</body>
</html>`;

// =====================================================================
// Client JS (classic script). NOTE: String.raw keeps regex backslashes
// intact; this code deliberately contains no backticks or dollar-brace.
// =====================================================================
const CLIENT_JS = String.raw`
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  var hb = null;
  var HyperbeamFactory = null;
  var virtualX = 0.5, virtualY = 0.5;
  var preParkX = 0.5, preParkY = 0.5;
  var isCursorParked = false;
  var cursorHideTimeout = null;
  var sessionSeconds = 0;
  var currentSessionId = safeGet("hb_active_session_id");
  var streamAspect = 16 / 9;
  var heartbeatStarted = false;
  var sensitivity = parseFloat(safeGet("hb_trackpad_sens") || "2.0");
  var busy = false;

  function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function safeDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  // Desktop = precise pointer (mouse) and no primary touch. iPads report coarse pointer.
  var isDesktop = (function () {
    var coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
    var touchPts = navigator.maxTouchPoints || 0;
    var iPadOS = /Macintosh/.test(navigator.userAgent) && touchPts > 1;
    return !(coarse || iPadOS || ("ontouchstart" in window && touchPts > 0));
  })();

  // ------------------------------------------------------------------
  // Toasts
  // ------------------------------------------------------------------
  function toast(msg, type, ms, onClick) {
    var host = $("toast-host");
    var el = document.createElement("div");
    el.className = "toast " + (type || "info");
    el.textContent = msg;
    host.appendChild(el);
    requestAnimationFrame(function () { el.classList.add("show"); });
    var remove = function () {
      el.classList.remove("show");
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
    };
    el.addEventListener("click", function () { remove(); if (onClick) { try { onClick(); } catch (e) {} } });
    if (onClick) el.style.cursor = "pointer";
    setTimeout(remove, ms || (type === "error" ? 8000 : 4000));
  }
  window.hbToast = toast;

  function setBoot(on, text) {
    $("boot-overlay").style.display = on ? "flex" : "none";
    if (text) $("bootText").textContent = text;
  }

  async function api(path, opts) {
    var res = await fetch(path, opts);
    var data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      throw new Error((data && (data.error || data.message)) || ("HTTP " + res.status));
    }
    return data;
  }
  function postJSON(path, body, method) {
    return api(path, {
      method: method || "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ------------------------------------------------------------------
  // Hyperbeam SDK: loaded dynamically, only when a session starts
  // ------------------------------------------------------------------
  async function getHyperbeam() {
    if (HyperbeamFactory) return HyperbeamFactory;
    var sources = [
      "https://unpkg.com/@hyperbeam/web@latest/dist/index.js",
      "https://cdn.jsdelivr.net/npm/@hyperbeam/web@latest/dist/index.js",
      "https://esm.sh/@hyperbeam/web"
    ];
    var lastErr = null;
    for (var i = 0; i < sources.length; i++) {
      try {
        var mod = await import(sources[i]);
        var fn = mod.default || mod.Hyperbeam || mod;
        if (typeof fn === "function") {
          HyperbeamFactory = fn;
          return fn;
        }
        lastErr = new Error("SDK export not a function");
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error("Could not load Hyperbeam SDK (" + (lastErr && lastErr.message) + "). Check adblock/network.");
  }

  // ------------------------------------------------------------------
  // Geometry (16:9 letterbox lock, subpixel mapping)
  // ------------------------------------------------------------------
  var streamWrapper, streamContainer, cursorEl;

  function getVideoBox() {
    var rect = streamWrapper.getBoundingClientRect();
    var containerRatio = rect.width / rect.height;
    var width, height, left, top;
    if (containerRatio > streamAspect) {
      height = rect.height;
      width = rect.height * streamAspect;
      left = (rect.width - width) / 2;
      top = 0;
    } else {
      width = rect.width;
      height = rect.width / streamAspect;
      left = 0;
      top = (rect.height - height) / 2;
    }
    return { left: left, top: top, width: width, height: height, rectLeft: rect.left, rectTop: rect.top };
  }

  function updateCursorPosition() {
    var box = getVideoBox();
    var px = box.left + virtualX * box.width;
    var py = box.top + virtualY * box.height;
    cursorEl.style.transform = "translate3d(" + px + "px," + py + "px,0)";
  }

  // ------------------------------------------------------------------
  // Cursor auto-hide (5s) with remote parking
  // ------------------------------------------------------------------
  function send(ev) {
    if (!hb) return;
    try { hb.sendEvent(ev); } catch (e) { console.warn("sendEvent failed", e); }
  }

  function parkCursorOffscreen() {
    cursorEl.style.opacity = "0";
    document.body.classList.add("cursor-hidden");
    if (hb && !isCursorParked) {
      preParkX = virtualX;
      preParkY = virtualY;
      isCursorParked = true;
      send({ type: "mousemove", x: 0.9999, y: 0.9999 });
    }
  }

  function wakeCursor() {
    cursorEl.style.opacity = "1";
    document.body.classList.remove("cursor-hidden");
    if (isCursorParked) {
      isCursorParked = false;
      virtualX = preParkX;
      virtualY = preParkY;
      updateCursorPosition();
      send({ type: "mousemove", x: virtualX, y: virtualY });
    }
    if (cursorHideTimeout) clearTimeout(cursorHideTimeout);
    cursorHideTimeout = setTimeout(parkCursorOffscreen, 5000);
  }

  // ------------------------------------------------------------------
  // Session attach / launch
  // ------------------------------------------------------------------
  async function attachToSession(sessionObj) {
    if (!sessionObj || !sessionObj.embed_url) {
      throw new Error("Session has no streaming URL (embed_url). Try Stop, then Launch again.");
    }
    setBoot(true, "⏳ Connecting to VM...");
    var Hyperbeam = await getHyperbeam();

    currentSessionId = sessionObj.session_id;
    if (currentSessionId) safeSet("hb_active_session_id", currentSessionId);

    streamContainer.innerHTML = "";
    var opts = { volume: 1.0 };
    if (sessionObj.admin_token) opts.adminToken = sessionObj.admin_token;
    hb = await Hyperbeam(streamContainer, sessionObj.embed_url, opts);

    // Hyperbeam only lets Ctrl+C copy out of the VM when the clipboard_copy role is on (off by default).
    try {
      if (typeof hb.addRoles === "function" && hb.userId) {
        await Promise.race([hb.addRoles([hb.userId], ["clipboard_copy"], false), sleep(3000)]);
      }
    } catch (e) { console.warn("addRoles failed", e); }

    $("splash").style.display = "none";
    cursorEl.style.display = "block";
    updateCursorPosition();
    wakeCursor();
    startHeartbeat();
    refreshSleepBtn();
    document.title = "Hyperbeam Cloud Browser Pro";
    setBoot(false);
    toast("✅ VM connected", "success", 2000);
    setTimeout(function () { setAudioBoost($("audioBoostSelect").value, true); }, 1500);
  }

  async function launchSessionWithProfile(profileSessionId, tabsToReopen) {
    if (busy) return;
    busy = true;
    var launchBtn = $("splashLaunchBtn");
    launchBtn.disabled = true;
    launchBtn.textContent = "⏳ Booting VM...";
    setBoot(true, "⏳ Booting VM...");
    try {
      var data = await postJSON("/api/launch", {
        lastSessionId: profileSessionId || safeGet("hb_profile_id"),
        cookieSync: $("cookieSyncChk").checked,
        sleepProof: $("sleepProofChk").checked
      });
      if (data && data.session_id) {
        if (data.sleep_proof) { safeSet("hb_sleep_proof", data.session_id); safeSet("hb_sleep_proof_secs", String(data.offline_secs || 3600)); }
        else if (safeGet("hb_sleep_proof") === data.session_id) safeDel("hb_sleep_proof");
      }
      if (data && data.profile_id) safeSet("hb_profile_id", data.profile_id);
      if (data && data.profile_note === "created") toast("🆕 New login profile created. Sign in once, then use 🛑 Stop to save it.", "info", 9000);
      if (data && data.profile_note === "stale-profile-recreated") toast("⚠️ Old profile could not be loaded (expired?). Created a fresh one: log in again, then press 🛑 Stop.", "error", 12000);
      if (data && data.profile_note === "already-running") toast("🔗 Connected to your VM that was already running", "success", 3500);
      if (data && data.profile_note === "cookie-sync") {
        toast("🍪 Hyperbeam ACCEPTED the cookie-sync extension. Log in to your sites, wait ~1 min, then tap 🔐 Login > Check sync status.", "success", 10000);
        if (data.kv === false) toast("⚠️ No KV bound (SAVES_KV): cookies are only kept in temporary Worker memory.", "error", 10000);
      }
      if (data && data.profile_note === "extension-failed") {
        safeSet("hb_cookiesync", "0");
        $("cookieSyncChk").checked = false;
        toast("❌ Hyperbeam rejected the extension (" + (data.profile_error || "unknown") + "). Cookie sync turned off; started a plain VM.", "error", 14000);
      }
      if (data && data.profile_note === "profiles-restricted") toast("ℹ️ VM started, but your Hyperbeam plan blocks saved logins (profiles). You will need to sign in each session.", "info", 12000);
      if (data && data.profile_note === "profile-failed") toast("⚠️ VM started without saved logins: " + (data.profile_error || "profile error"), "error", 12000);
      if (data && data.profile_note === "loaded") toast("🔑 Login profile loaded", "success", 2500);
      if (!data || data.error || !data.embed_url) {
        throw new Error((data && data.error) || "No streaming URL returned by Hyperbeam.");
      }
      await attachToSession(data);

      if (tabsToReopen && tabsToReopen.length) {
        setTimeout(async function () {
          for (var i = 0; i < tabsToReopen.length; i++) {
            try { await hb.tabs.create({ url: tabsToReopen[i].url }); } catch (e) {}
          }
        }, 1200);
      }
    } catch (err) {
      console.error(err);
      toast("❌ Launch failed: " + err.message, "error", 10000);
      $("splash").style.display = "flex";
      setBoot(false);
    } finally {
      busy = false;
      launchBtn.disabled = false;
      launchBtn.textContent = "🚀 Launch Session";
    }
  }

  function launchFreshSession() {
    var defaultSaveId = safeGet("hb_default_save_id");
    if (defaultSaveId) {
      var saves = [];
      try { saves = JSON.parse(safeGet("hb_cached_saves") || "[]"); } catch (e) {}
      var def = saves.filter(function (s) { return s.id === defaultSaveId; })[0];
      if (def && def.sessionId) return launchSessionWithProfile(def.sessionId, def.tabs || []);
    }
    return launchSessionWithProfile(null, []);
  }

  // Detect a running VM; offer a one-tap reconnect (SDK still loads only on click)
  var pendingReconnect = null;
  function humanUptime(ms) {
    var m = Math.max(0, Math.round(ms / 60000)), h = Math.floor(m / 60);
    return h >= 24 ? Math.floor(h / 24) + " d " + (h % 24) + " h" : (h ? h + " h " : "") + (m % 60) + " min";
  }
  async function checkAutoReconnect() {
    try {
      var list = await api("/api/active");
      var running = Array.isArray(list) ? list.filter(function (r) { return r.embed_url; }) : [];
      if (running.length > 0) {
        pendingReconnect = running[0];
        var sleeping = safeGet("hb_sleep_flag") === running[0].session_id;
        var up = running[0].creation_date ? " (up " + humanUptime(Date.now() - Date.parse(running[0].creation_date)) + ")" : "";
        $("runningInfo").textContent = (sleeping ? "😴 Your VM is sleeping" : "🟢 A VM is running") + up + ". Tap Reconnect to jump back in.";
        $("reconnectRow").style.display = "block";
      } else {
        pendingReconnect = null;
        $("reconnectRow").style.display = "none";
        safeDel("hb_sleep_flag");
      }
    } catch (e) { /* silent: not critical */ }
  }

  // ------------------------------------------------------------------
  // Audio boost
  // ------------------------------------------------------------------
  // The SDK plays audio through its own Web Audio graph (not a visible <video> in our container),
  // so we tap AudioNode.connect BEFORE the SDK loads and route anything headed to the speakers
  // through one boost GainNode per AudioContext.
  var audioTap = { gains: [], mult: 1.0 };
  function installAudioTap() {
    if (window.__hbAudioTap || typeof AudioNode === "undefined") return;
    window.__hbAudioTap = true;
    var origConnect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (dest) {
      try {
        var isDest = dest && typeof AudioDestinationNode !== "undefined" && dest instanceof AudioDestinationNode;
        if (isDest && !this.__hbBoost) {
          var ctx = this.context;
          var g = null;
          for (var i = 0; i < audioTap.gains.length; i++) if (audioTap.gains[i].ctx === ctx) g = audioTap.gains[i].node;
          if (!g) {
            g = ctx.createGain();
            g.__hbBoost = true;
            g.gain.value = audioTap.mult;
            origConnect.call(g, ctx.destination);
            audioTap.gains.push({ ctx: ctx, node: g });
          }
          var args = Array.prototype.slice.call(arguments);
          args[0] = g;
          return origConnect.apply(this, args);
        }
      } catch (e) { console.warn("audio tap", e); }
      return origConnect.apply(this, arguments);
    };
  }

  function findMediaEl(root) {
    var els = root.querySelectorAll("video, audio");
    if (els.length) return els[0];
    var all = root.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      if (all[i].shadowRoot) { var f = findMediaEl(all[i].shadowRoot); if (f) return f; }
    }
    return null;
  }

  var mediaBoost = null;
  function setAudioBoost(val, silent) {
    var mult = parseFloat(val) || 1.0;
    audioTap.mult = mult;
    if (!hb) { if (!silent) toast("Launch a session first (boost will apply when it starts)", "info"); return; }

    var applied = false;
    audioTap.gains.forEach(function (g) {
      try {
        if (g.ctx.state === "suspended") g.ctx.resume();
        g.node.gain.setValueAtTime(mult, g.ctx.currentTime);
        applied = true;
      } catch (e) {}
    });

    if (!applied) {
      // Fallback: a real media element somewhere in the page
      var el = findMediaEl(streamContainer);
      if (el) {
        try {
          if (!mediaBoost) {
            var Ctx = window.AudioContext || window.webkitAudioContext;
            var c = new Ctx();
            var src = c.createMediaElementSource(el);
            var gn = c.createGain();
            src.connect(gn);
            gn.connect(c.destination);
            mediaBoost = { ctx: c, node: gn };
          }
          if (mediaBoost.ctx.state === "suspended") mediaBoost.ctx.resume();
          mediaBoost.node.gain.setValueAtTime(mult, mediaBoost.ctx.currentTime);
          applied = true;
        } catch (e) { console.warn("media boost", e); }
      }
    }

    try { hb.volume = Math.min(1, mult); } catch (e) {}

    if (!silent) {
      if (applied) toast("🔊 Volume boost " + Math.round(mult * 100) + "%", "success", 1800);
      else toast("Boost not active for this session. Reload the page, then Reconnect or Launch (the audio hook must load before the SDK). Volume set to max normal level.", "error", 9000);
    }
  }

  // ------------------------------------------------------------------
  // Resolution
  // ------------------------------------------------------------------
  var RESOLUTION_MAP = {
    "540p": { width: 960, height: 540 },
    "720p": { width: 1280, height: 720 },
    "900p": { width: 1600, height: 900 },
    "1080p": { width: 1920, height: 1080 }
  };
  async function changeResolutionPreset(preset) {
    var dims = RESOLUTION_MAP[preset];
    if (!dims) return;
    if (hb && typeof hb.resize === "function") {
      try { await hb.resize(dims.width, dims.height); }
      catch (e1) {
        try { await hb.resize({ width: dims.width, height: dims.height }); } catch (e2) {}
      }
    }
    streamAspect = dims.width / dims.height;
    updateCursorPosition();
  }

  // ------------------------------------------------------------------
  // Trackpad visibility
  // ------------------------------------------------------------------
  function toggleTrackpadVisibility() {
    var on = document.body.classList.toggle("show-trackpad");
    $("trackpadToggleBtn").classList.toggle("active-toggle", on);
    setTimeout(updateCursorPosition, 100);
  }

  // ------------------------------------------------------------------
  // Save & Restore
  // ------------------------------------------------------------------
  async function triggerSaveWorkspace() {
    if (!hb || !hb.tabs) return toast("Launch a session first to save your state!", "error");
    var name = prompt("Name this save state:", "Workspace - " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    if (!name) return;
    try {
      var tabsList = await hb.tabs.query({});
      var validTabs = (tabsList || []).map(function (t) {
        return { title: t.title || t.url, url: t.url };
      }).filter(function (t) { return t.url && t.url.indexOf("chrome://") !== 0; });

      var savePayload = {
        id: "save_" + Date.now(),
        name: name,
        sessionId: safeGet("hb_profile_id") || currentSessionId,
        date: new Date().toLocaleString(),
        tabs: validTabs
      };
      var updated = await postJSON("/api/saves", savePayload);
      safeSet("hb_cached_saves", JSON.stringify(updated));
      toast("✅ Workspace saved (" + validTabs.length + " tabs + login profile)", "success");
    } catch (err) {
      toast("Save failed: " + err.message, "error");
    }
  }

  async function loadSaves() {
    var saves = [];
    try { saves = await api("/api/saves"); } catch (e) {}
    if (!saves || !saves.length) {
      try { saves = JSON.parse(safeGet("hb_cached_saves") || "[]"); } catch (e) { saves = []; }
    } else {
      safeSet("hb_cached_saves", JSON.stringify(saves));
    }
    return saves;
  }

  async function openRestoreModal() {
    var modal = $("restoreModal");
    var listEl = $("savesListContainer");
    listEl.innerHTML = '<div class="empty-note">Loading saved sessions...</div>';
    modal.style.display = "flex";

    var defaultSaveId = safeGet("hb_default_save_id");
    var saves = await loadSaves();

    if (!saves.length) {
      listEl.innerHTML = '<div class="empty-note">No saved workspaces found yet.<br><br>Click "💾 Save" while in a session to store your tabs and logins!</div>';
      return;
    }

    listEl.innerHTML = "";
    saves.forEach(function (s) {
      var isDefault = s.id === defaultSaveId;
      var card = document.createElement("div");
      card.className = "save-card";

      var tabs = s.tabs || [];
      var pills = tabs.map(function (t) {
        return '<div class="tab-pill">' + escapeHtml(t.title || t.url) + "</div>";
      }).join("");

      card.innerHTML =
        '<div class="save-card-header">' +
          '<strong style="color:#c4b5fd;font-size:14px;">' + escapeHtml(s.name || "Untitled") +
            (isDefault ? ' <span style="color:#34d399;font-size:11px;">(Default Base)</span>' : "") + "</strong>" +
          '<span style="font-size:11px;color:#71717a;">' + escapeHtml(s.date || "") + "</span>" +
        "</div>" +
        '<div style="font-size:11.5px;color:#a1a1aa;">' + tabs.length + " Tabs Saved:</div>" +
        '<div style="max-height:60px;overflow-y:auto;">' + pills + "</div>" +
        '<div style="display:flex;justify-content:flex-end;gap:6px;margin-top:6px;flex-wrap:wrap;">' +
          '<button type="button" class="btn js-default" style="padding:4px 8px;font-size:11px;">' + (isDefault ? "⭐ Default" : "📌 Set Default") + "</button>" +
          '<button type="button" class="btn btn-danger js-delete" style="padding:4px 8px;font-size:11px;">🗑️ Delete</button>' +
          '<button type="button" class="btn btn-restore js-restore" style="padding:4px 14px;font-size:11px;">⚡ Restore &amp; Launch</button>' +
        "</div>";

      card.querySelector(".js-default").addEventListener("click", function () { setDefaultSaveState(s.id); });
      card.querySelector(".js-delete").addEventListener("click", function () { deleteSaveState(s.id); });
      card.querySelector(".js-restore").addEventListener("click", function () { restoreChosenSave(s.id); });
      listEl.appendChild(card);
    });
  }

  function closeRestoreModal() { $("restoreModal").style.display = "none"; }

  function setDefaultSaveState(saveId) {
    safeSet("hb_default_save_id", saveId);
    toast("⭐ Set as default launch profile", "success");
    openRestoreModal();
  }

  async function deleteSaveState(saveId) {
    if (!confirm("Delete this saved workspace?")) return;
    if (safeGet("hb_default_save_id") === saveId) safeDel("hb_default_save_id");
    try {
      var updated = await postJSON("/api/saves", { id: saveId }, "DELETE");
      safeSet("hb_cached_saves", JSON.stringify(updated));
    } catch (e) {
      toast("Delete failed: " + e.message, "error");
    }
    openRestoreModal();
  }

  async function restoreChosenSave(saveId) {
    var saves = await loadSaves();
    var chosen = saves.filter(function (s) { return s.id === saveId; })[0];
    if (!chosen) return toast("Save state not found", "error");

    closeRestoreModal();

    if (hb && currentSessionId && currentSessionId !== chosen.sessionId) {
      try { await postJSON("/api/terminate", { sessionId: currentSessionId }); } catch (e) {}
      hb = null;
      streamContainer.innerHTML = "";
      setBoot(true, "💾 Saving logins, please wait...");
      await new Promise(function (r) { setTimeout(r, 6000); });
    }
    await launchSessionWithProfile(chosen.sessionId, chosen.tabs || []);
  }

  // ------------------------------------------------------------------
  // Clipboard bridge
  // ------------------------------------------------------------------
  function openClipboardModal() {
    $("clipboardModal").style.display = "flex";
    $("clipTextArea").focus();
  }
  function closeClipboardModal() { $("clipboardModal").style.display = "none"; }
  function openClipboardModalWithText(text) {
    $("clipTextArea").value = text;
    openClipboardModal();
  }

  async function sendToVmClipboard() {
    var text = $("clipTextArea").value;
    if (!text) return toast("Please enter or paste text first.", "error");
    var btn = $("transferClipBtn");
    btn.disabled = true;
    btn.textContent = "⏳ Uploading...";
    try {
      var data = await postJSON("/api/clip", { text: text });
      if (data.status !== "ok" || !data.rawUrl) throw new Error(data.error || "Failed");

      if (!hb || !hb.tabs) {
        toast("Launch a session first, then transfer.", "error");
        return;
      }
      var bridgeTabUrl = (data.rawUrl.indexOf(window.location.origin) === 0 && data.viewUrl)
        ? data.viewUrl
        : window.location.origin + "/clip?src=" + encodeURIComponent(data.rawUrl);
      await hb.tabs.create({ url: bridgeTabUrl });
      closeClipboardModal();
      toast("🚀 Transferred! In the VM, open the 'VM Clipboard Bridge' tab, press copy, then Ctrl+V in your target tab.", "success", 9000);
    } catch (e) {
      toast("Transfer failed: " + e.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "🚀 Transfer to VM";
    }
  }

  // ------------------------------------------------------------------
  // Video theater
  // ------------------------------------------------------------------
  async function fetchAndPlayNativeMedia() {
    if (!hb || !hb.tabs) return toast("Launch the virtual browser first!", "error");

    var fetchBtn = $("fetchMediaBtn");
    var theater = $("video-theater");
    var theaterView = $("theater-view");
    var theaterTitle = $("theater-title");

    try {
      var activeTabs = await hb.tabs.query({ active: true });
      var targetUrl = activeTabs && activeTabs[0] ? activeTabs[0].url : "";
      if (!targetUrl || targetUrl.indexOf("chrome://") === 0) {
        return toast("Navigate to a video or media page inside the browser first!", "error");
      }

      var ytMatch = targetUrl.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([\w-]{11})/);
      if (ytMatch) {
        theaterTitle.textContent = "🎬 YouTube 60 FPS Native Player";
        theaterView.innerHTML = '<iframe src="https://www.youtube-nocookie.com/embed/' + ytMatch[1] +
          '?autoplay=1&playsinline=1" style="width:100%;height:100%;border:none;" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowfullscreen></iframe>';
        theater.style.display = "flex";
        return;
      }

      if (/\.(mp4|webm|m3u8|mov)($|\?)/i.test(targetUrl)) {
        var proxied = "/api/proxy-video?url=" + encodeURIComponent(targetUrl) + "&ref=" + encodeURIComponent(targetUrl);
        theaterTitle.textContent = "🎬 Direct Video Stream";
        theaterView.innerHTML = '<video src="' + proxied + '" controls autoplay playsinline style="max-width:100%;max-height:100%;outline:none;"></video>';
        theater.style.display = "flex";
        return;
      }

      fetchBtn.disabled = true;
      fetchBtn.textContent = "⏳ Extracting...";
      var cobData = await postJSON("/api/cobalt", { targetUrl: targetUrl });

      if (cobData && (cobData.status === "stream" || cobData.status === "redirect" || cobData.status === "tunnel") && cobData.url) {
        theaterTitle.textContent = "🎬 Cobalt Extracted 60 FPS Stream";
        theaterView.innerHTML = '<video src="' + escapeHtml(cobData.url) + '" controls autoplay playsinline style="max-width:100%;max-height:100%;outline:none;"></video>';
        theater.style.display = "flex";
        return;
      }
      toast("Cobalt extracted nothing from this host. Use fullscreen (⛶) in the VM player; cursors vanish after 5s.", "info", 7000);
    } catch (err) {
      toast("Fetch error: " + err.message, "error");
    } finally {
      fetchBtn.disabled = false;
      fetchBtn.textContent = "🎬 Video";
    }
  }

  function closeNativeMedia() {
    $("theater-view").innerHTML = "";
    $("video-theater").style.display = "none";
  }

  // ------------------------------------------------------------------
  // Terminate
  // ------------------------------------------------------------------
  async function forceTerminateActive() {
    try {
      var sid = currentSessionId;
      if (!sid) {
        var list = await api("/api/active");
        var running = Array.isArray(list) ? list : [];
        if (!running.length) return toast("No active VMs running.", "info");
        sid = running[0].session_id;
      }
      if (!confirm("Stop the running VM completely?")) return;
      await postJSON("/api/terminate", { sessionId: sid });
      safeDel("hb_active_session_id");
      safeDel("hb_sleep_flag");
      toast("🛑 Virtual machine stopped.", "success", 1500);
      setTimeout(function () { location.reload(); }, 900);
    } catch (e) {
      toast("Stop failed: " + e.message, "error");
    }
  }

  // ------------------------------------------------------------------
  // Heartbeat (Anti-AFK every 25s) + latency badge
  // ------------------------------------------------------------------
  function startHeartbeat() {
    if (heartbeatStarted) return;
    heartbeatStarted = true;

    setInterval(function () {
      try { if (hb && typeof hb.ping === "function") hb.ping(); } catch (e) {}
    }, 25000);

    setInterval(async function () {
      if (!hb) return;
      var t0 = performance.now();
      try {
        await fetch("/api/ping", { cache: "no-store" });
        $("pingBadge").textContent = "⚡ " + Math.round(performance.now() - t0) + "ms";
      } catch (e) {
        $("pingBadge").textContent = "⚠️ offline";
      }
    }, 6000);
  }

  // ------------------------------------------------------------------
  // Input wiring
  // ------------------------------------------------------------------
  function sendClick(buttonNum) {
    if (!hb) return;
    wakeCursor();
    send({ type: "mousedown", button: buttonNum, x: virtualX, y: virtualY });
    setTimeout(function () {
      send({ type: "mouseup", button: buttonNum, x: virtualX, y: virtualY });
    }, 40);
  }

  // ------------------------------------------------------------------
  // Smooth scroll engine: batches wheel events (~30/s), eases mouse-wheel jumps,
  // and adds inertia after two-finger swipes / held scroll buttons.
  // ------------------------------------------------------------------
  var scr = { pendX: 0, pendY: 0, remX: 0, remY: 0, velX: 0, velY: 0, hold: 0, dragging: false, timer: null, last: 0 };

  function scrollKick() {
    if (scr.timer) return;
    scr.last = performance.now();
    scr.timer = setInterval(scrollTick, 33);
  }

  function scrollTick() {
    var now = performance.now();
    var dt = Math.min(80, now - scr.last) || 33;
    scr.last = now;

    if (scr.hold) {
      scr.velY += (scr.hold * 2.0 - scr.velY) * 0.12;      // ramp up while a scroll button is held
    } else if (!scr.dragging) {
      var f = Math.pow(0.9965, dt);                        // inertia decay (~1s glide)
      scr.velX *= f; scr.velY *= f;
      if (Math.abs(scr.velX) < 0.02) scr.velX = 0;
      if (Math.abs(scr.velY) < 0.02) scr.velY = 0;
    }
    if (!scr.dragging) {
      scr.pendX += scr.velX * dt;
      scr.pendY += scr.velY * dt;
    }

    // Ease mouse-wheel notches instead of sending one big jump
    var ex = Math.abs(scr.remX) < 2 ? scr.remX : scr.remX * 0.3;
    var ey = Math.abs(scr.remY) < 2 ? scr.remY : scr.remY * 0.3;
    scr.remX -= ex; scr.remY -= ey;
    scr.pendX += ex; scr.pendY += ey;

    var ix = Math.max(-800, Math.min(800, Math.round(scr.pendX)));
    var iy = Math.max(-800, Math.min(800, Math.round(scr.pendY)));
    if (ix || iy) {
      wakeCursor();                                        // un-park the remote cursor so the page under it scrolls
      send({ type: "wheel", deltaX: ix, deltaY: iy });
      scr.pendX -= ix; scr.pendY -= iy;
    }

    var idle = !scr.hold && !scr.dragging && !scr.velX && !scr.velY && !scr.remX && !scr.remY &&
               Math.abs(scr.pendX) < 0.5 && Math.abs(scr.pendY) < 0.5;
    if (idle) {
      clearInterval(scr.timer);
      scr.timer = null;
      scr.pendX = 0; scr.pendY = 0;
    }
  }

  function wireDesktopInput() {
    streamWrapper.addEventListener("mousemove", function (e) {
      if (!isDesktop || !hb) return;
      var box = getVideoBox();
      virtualX = Math.min(0.9999, Math.max(0.0001, (e.clientX - box.rectLeft - box.left) / box.width));
      virtualY = Math.min(0.9999, Math.max(0.0001, (e.clientY - box.rectTop - box.top) / box.height));
      send({ type: "mousemove", x: virtualX, y: virtualY });
      updateCursorPosition();
      wakeCursor();
    });
    streamWrapper.addEventListener("mousedown", function (e) {
      if (!isDesktop || !hb) return;
      wakeCursor();
      send({ type: "mousedown", button: e.button, x: virtualX, y: virtualY });
    });
    streamWrapper.addEventListener("mouseup", function (e) {
      if (!isDesktop || !hb) return;
      send({ type: "mouseup", button: e.button, x: virtualX, y: virtualY });
    });
    streamWrapper.addEventListener("contextmenu", function (e) { if (hb) e.preventDefault(); });
    streamWrapper.addEventListener("wheel", function (e) {
      if (!hb) return;
      e.preventDefault();
      var m = e.deltaMode === 1 ? 40 : (e.deltaMode === 2 ? 800 : 1);
      scr.dragging = false;
      scr.remX = Math.max(-3000, Math.min(3000, scr.remX + e.deltaX * m));
      scr.remY = Math.max(-3000, Math.min(3000, scr.remY + e.deltaY * m));
      scrollKick();
    }, { passive: false });

    function keyHandler(type) {
      return function (e) {
        var tag = e.target && e.target.tagName;
        if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
        if (!hb) return;
        send({
          type: type, key: e.key, code: e.code,
          ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey
        });
      };
    }
    window.addEventListener("keydown", keyHandler("keydown"));
    window.addEventListener("keyup", keyHandler("keyup"));
  }

  function wireTrackpad() {
    var trackpad = $("trackpad-surface");
    var lastTouchX = 0, lastTouchY = 0, touchStartTime = 0, isMoving = false;

    var scrollMode = false, lastMidX = 0, lastMidY = 0, lastMoveT = 0;

    function onScrollBtn(e) { return e.target && e.target.closest && e.target.closest(".scroll-btn"); }

    trackpad.addEventListener("touchstart", function (e) {
      if (onScrollBtn(e)) return;                // scroll buttons handle their own presses
      e.preventDefault();
      if (e.touches.length >= 2) {
        scrollMode = true;
        isMoving = true;                         // never counts as a tap
        lastMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        lastMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        lastMoveT = performance.now();
        scr.dragging = true; scr.velX = 0; scr.velY = 0;
        scrollKick();
        return;
      }
      var t = e.touches[0];
      lastTouchX = t.clientX;
      lastTouchY = t.clientY;
      touchStartTime = performance.now();
      isMoving = false;
      wakeCursor();
    }, { passive: false });

    trackpad.addEventListener("touchmove", function (e) {
      if (onScrollBtn(e)) return;
      e.preventDefault();
      if (e.touches.length >= 2) {
        var mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        var my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        var nowT = performance.now();
        var dtm = Math.max(1, nowT - lastMoveT);
        var gain = 1.5 * (sensitivity / 2.0);
        var dX = -(mx - lastMidX) * gain;        // natural scrolling: content follows your fingers
        var dY = -(my - lastMidY) * gain;
        if (Math.abs(dX) < Math.abs(dY) * 0.5) dX = 0;   // axis lock
        if (Math.abs(dY) < Math.abs(dX) * 0.5) dY = 0;
        scr.pendX += dX; scr.pendY += dY;
        scr.velX = 0.6 * scr.velX + 0.4 * (dX / dtm);
        scr.velY = 0.6 * scr.velY + 0.4 * (dY / dtm);
        lastMidX = mx; lastMidY = my; lastMoveT = nowT;
        scrollKick();
        return;
      }
      if (scrollMode) {                          // one finger left over after a scroll: ignore, don't jump the cursor
        lastTouchX = e.touches[0].clientX;
        lastTouchY = e.touches[0].clientY;
        return;
      }
      var t = e.touches[0];
      var dx = t.clientX - lastTouchX;
      var dy = t.clientY - lastTouchY;
      var dist = Math.hypot(dx, dy);
      if (dist > 1.2) isMoving = true;

      var box = getVideoBox();
      var flick = dist > 5.0 ? 1.22 : 1.0;
      virtualX = Math.min(0.999, Math.max(0.001, virtualX + (dx * sensitivity * 2.3 * flick) / box.width));
      virtualY = Math.min(0.999, Math.max(0.001, virtualY + (dy * sensitivity * 2.3 * flick) / box.height));

      updateCursorPosition();
      wakeCursor();
      send({ type: "mousemove", x: virtualX, y: virtualY });

      lastTouchX = t.clientX;
      lastTouchY = t.clientY;
    }, { passive: false });

    function endTouch(e) {
      if (onScrollBtn(e)) return;
      if (scrollMode) {
        if (e.touches.length === 0) {
          scrollMode = false;
          scr.dragging = false;                  // inertia takes over
          if (performance.now() - lastMoveT > 90) { scr.velX = 0; scr.velY = 0; }  // paused before lifting: no glide
          scrollKick();
        }
        return;
      }
      if (e.type === "touchend" && !isMoving && performance.now() - touchStartTime < 220) sendClick(0);
    }
    trackpad.addEventListener("touchend", endTouch);
    trackpad.addEventListener("touchcancel", endTouch);

    $("leftClickBtn").addEventListener("pointerdown", function (e) { e.preventDefault(); sendClick(0); });
    $("rightClickBtn").addEventListener("pointerdown", function (e) { e.preventDefault(); sendClick(2); });

    var saBtn = $("selectAllBtn"), holdTimer = null, holdFired = false;
    saBtn.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      holdFired = false;
      clearTimeout(holdTimer);
      holdTimer = setTimeout(function () {
        holdFired = true;
        openMiniMenu();
        try { if (navigator.vibrate) navigator.vibrate(15); } catch (er) {}
      }, 450);
    });
    saBtn.addEventListener("pointerup", function (e) {
      e.preventDefault();
      clearTimeout(holdTimer);
      if (holdFired || !hb) return;               // a hold opens the menu instead of selecting
      wakeCursor();
      sendClick(0);
      setTimeout(function () { vmCombo("a").catch(function () {}); }, 80);
    });
    ["pointerleave", "pointercancel"].forEach(function (ev) {
      saBtn.addEventListener(ev, function () { clearTimeout(holdTimer); });
    });
    saBtn.addEventListener("contextmenu", function (e) { e.preventDefault(); });

    var up = $("scrollUpBtn"), down = $("scrollDownBtn");
    function holdStart(dir) { scr.dragging = false; scr.hold = dir; wakeCursor(); scrollKick(); }
    function holdStop() { scr.hold = 0; }
    up.addEventListener("pointerdown", function (e) { e.preventDefault(); holdStart(-1); });
    down.addEventListener("pointerdown", function (e) { e.preventDefault(); holdStart(1); });
    [up, down].forEach(function (b) {
      ["pointerup", "pointerleave", "pointercancel"].forEach(function (ev) { b.addEventListener(ev, holdStop); });
    });

    var sensSlider = $("sensSlider"), sensValue = $("sensValue");
    if (isNaN(sensitivity)) sensitivity = 2.0;
    sensSlider.value = sensitivity;
    sensValue.textContent = sensitivity.toFixed(1) + "x";
    sensSlider.addEventListener("input", function (e) {
      sensitivity = parseFloat(e.target.value);
      sensValue.textContent = sensitivity.toFixed(1) + "x";
      safeSet("hb_trackpad_sens", String(sensitivity));
    });
  }

  function wireKeyboardBuffer() {
    var keyInput = $("hiddenKeyboardInput");
    var DUMMY = "     "; // 5 spaces: keeps Safari's backspace alive
    keyInput.value = DUMMY;

    $("kbBtn").addEventListener("click", function (e) {
      e.preventDefault();
      keyInput.focus();
      keyInput.value = DUMMY;
    });

    keyInput.addEventListener("keydown", function (e) {
      if (!hb) return;
      if (e.key === "Backspace" || e.keyCode === 8) {
        send({ type: "keydown", key: "Backspace", code: "Backspace" });
        send({ type: "keyup", key: "Backspace", code: "Backspace" });
        e.preventDefault();
        keyInput.value = DUMMY;
      } else if (e.key === "Enter" || e.keyCode === 13) {
        send({ type: "keydown", key: "Enter", code: "Enter" });
        send({ type: "keyup", key: "Enter", code: "Enter" });
        e.preventDefault();
        keyInput.value = DUMMY;
      }
    });

    keyInput.addEventListener("input", function (e) {
      if (!hb) { keyInput.value = DUMMY; return; }
      if (e.inputType === "deleteContentBackward" || keyInput.value.length < DUMMY.length) {
        send({ type: "keydown", key: "Backspace", code: "Backspace" });
        send({ type: "keyup", key: "Backspace", code: "Backspace" });
      } else if (keyInput.value.length > DUMMY.length) {
        var added = keyInput.value.slice(DUMMY.length);
        if (added.length > 50) {
          keyInput.value = DUMMY;
          openClipboardModalWithText(added);
          return;
        }
        for (var i = 0; i < added.length; i++) {
          send({ type: "keydown", key: added[i] });
          send({ type: "keyup", key: added[i] });
        }
      }
      keyInput.value = DUMMY;
    });
  }

  // ------------------------------------------------------------------
  // Usage timer
  // ------------------------------------------------------------------
  function startUsageTimer() {
    var MONTH_KEY = "hb_month_" + new Date().getMonth();
    var monthlyMins = parseInt(safeGet(MONTH_KEY) || "0", 10) || 0;
    $("usedMins").textContent = monthlyMins;
    setInterval(function () {
      if (!hb) return;
      sessionSeconds++;
      var h = String(Math.floor(sessionSeconds / 3600)).padStart(2, "0");
      var m = String(Math.floor((sessionSeconds % 3600) / 60)).padStart(2, "0");
      var s = String(sessionSeconds % 60).padStart(2, "0");
      $("sessionTimer").textContent = h + ":" + m + ":" + s;
      if (sessionSeconds % 60 === 0) {
        monthlyMins++;
        safeSet(MONTH_KEY, String(monthlyMins));
        $("usedMins").textContent = monthlyMins;
      }
    }, 1000);
  }

  // ------------------------------------------------------------------
  // Init: bind everything via addEventListener after DOM is ready
  // ------------------------------------------------------------------

  // ------------------------------------------------------------------
  // Reconnect (frozen stream): tap once = soft reconnect, tap again within 20s = full re-attach
  // ------------------------------------------------------------------
  var lastReconnectTap = 0;
  async function reconnectStream() {
    var now = Date.now();
    var wantHard = (now - lastReconnectTap) < 20000;
    lastReconnectTap = now;

    if (!wantHard && hb && typeof hb.reconnect === "function") {
      try {
        hb.reconnect();
        toast("🔄 Reconnecting stream... still frozen? Tap 🔄 again for a full reconnect.", "info", 6000);
        return;
      } catch (e) { console.warn("soft reconnect failed", e); }
    }

    setBoot(true, "🔄 Reconnecting to VM...");
    try {
      var list = await api("/api/active");
      var running = Array.isArray(list) ? list : [];
      if (!running.length) throw new Error("No running VM found. It may have timed out. Launch a new session.");
      var match = running.filter(function (r) { return r.session_id === currentSessionId; })[0] || running[0];
      try { if (hb && typeof hb.destroy === "function") hb.destroy(); } catch (e) {}
      hb = null;
      await attachToSession(match);
    } catch (e) {
      setBoot(false);
      if (!hb) $("splash").style.display = "flex";
      toast("Reconnect failed: " + e.message, "error", 9000);
    }
  }

  // ------------------------------------------------------------------
  // Quick Login vault (AES-GCM, key from passphrase via PBKDF2; stored only in this browser)
  // ------------------------------------------------------------------
  var vault = { key: null, salt: null, accounts: [], lockTimer: null };

  function b64enc(buf) {
    var bytes = new Uint8Array(buf), str = "";
    for (var i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
    return btoa(str);
  }
  function b64dec(str) {
    var bin = atob(str), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  async function deriveVaultKey(pass, salt) {
    var km = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: salt, iterations: 200000, hash: "SHA-256" },
      km, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    );
  }
  async function deriveAuthToken(pass, salt) {
    var km = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveBits"]);
    var prefix = new TextEncoder().encode("auth:");
    var salt2 = new Uint8Array(prefix.length + salt.length);
    salt2.set(prefix, 0);
    salt2.set(salt, prefix.length);
    var bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: salt2, iterations: 200000, hash: "SHA-256" }, km, 256);
    return b64enc(bits);
  }
  async function fetchServerVault() {
    try {
      var r = await fetch("/api/vault", { cache: "no-store" });
      if (!r.ok) return null;
      var d = await r.json();
      return d && d.data ? d : null;
    } catch (e) { return null; }
  }
  async function pushVault(blob) {
    var r = await fetch("/api/vault", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Vault-Auth": vault.authToken },
      body: JSON.stringify(blob)
    });
    var d = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
    if (d.persistent === false && !vault.warnedMem) {
      vault.warnedMem = true;
      toast("⚠️ Vault is in temporary Worker memory only. Bind a KV namespace named SAVES_KV or it can vanish.", "error", 12000);
    }
  }
  async function vaultSave() {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, vault.key, new TextEncoder().encode(JSON.stringify(vault.accounts)));
    var blob = { salt: b64enc(vault.salt), iv: b64enc(iv), data: b64enc(ct) };
    safeSet("hb_vault_v1", JSON.stringify(blob));
    await pushVault(blob);
  }
  async function vaultUnlock(pass) {
    if (!window.crypto || !crypto.subtle) throw new Error("Secure crypto unavailable in this browser");
    var server = await fetchServerVault();
    var localRaw = safeGet("hb_vault_v1");
    var blob = server || (localRaw ? JSON.parse(localRaw) : null);

    if (!blob) {
      vault.salt = crypto.getRandomValues(new Uint8Array(16));
      vault.key = await deriveVaultKey(pass, vault.salt);
      vault.authToken = await deriveAuthToken(pass, vault.salt);
      vault.accounts = [];
      await vaultSave();
      vault.serverExists = true;
      return;
    }

    var salt = b64dec(blob.salt);
    var key = await deriveVaultKey(pass, salt);
    var pt;
    try {
      pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64dec(blob.iv) }, key, b64dec(blob.data));
    } catch (e) { throw new Error("Wrong passphrase"); }

    vault.salt = salt;
    vault.key = key;
    vault.authToken = await deriveAuthToken(pass, salt);
    vault.accounts = JSON.parse(new TextDecoder().decode(pt));
    safeSet("hb_vault_v1", JSON.stringify(blob));
    vault.serverExists = true;

    if (!server) {
      try { await pushVault(blob); toast("☁️ Your existing vault was uploaded; it now works on every device.", "success", 5000); }
      catch (e) { toast("Could not sync vault to the server: " + e.message, "error", 8000); }
    }
  }
  function vaultLock() {
    vault.key = null; vault.accounts = []; vault.authToken = null;
    if (vault.lockTimer) { clearTimeout(vault.lockTimer); vault.lockTimer = null; }
    renderLoginPanel();
  }
  function touchVaultTimer() {
    if (vault.lockTimer) clearTimeout(vault.lockTimer);
    vault.lockTimer = setTimeout(function () { vaultLock(); toast("🔒 Vault auto-locked", "info", 2500); }, 10 * 60 * 1000);
  }

  // TOTP (RFC 6238: SHA-1, 6 digits, 30s)
  function base32decode(str) {
    var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    str = str.replace(/[\s=-]/g, "").toUpperCase();
    var bits = 0, val = 0, out = [];
    for (var i = 0; i < str.length; i++) {
      var idx = alphabet.indexOf(str.charAt(i));
      if (idx < 0) throw new Error("Authenticator key has invalid characters");
      val = (val << 5) | idx;
      bits += 5;
      if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
    }
    return new Uint8Array(out);
  }
  async function totpNow(secret) {
    var counter = Math.floor(Date.now() / 30000);
    var buf = new ArrayBuffer(8), dv = new DataView(buf);
    dv.setUint32(0, Math.floor(counter / 4294967296));
    dv.setUint32(4, counter >>> 0);
    var key = await crypto.subtle.importKey("raw", base32decode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
    var sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
    var off = sig[19] & 15;
    var bin = ((sig[off] & 127) << 24) | (sig[off + 1] << 16) | (sig[off + 2] << 8) | sig[off + 3];
    return String(bin % 1000000).padStart(6, "0");
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function typeIntoVm(text, pressEnter) {
    if (!hb) throw new Error("Launch a session first");
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      send({ type: "keydown", key: ch });
      send({ type: "keyup", key: ch });
      await sleep(18);
    }
    if (pressEnter) {
      await sleep(120);
      send({ type: "keydown", key: "Enter", code: "Enter" });
      send({ type: "keyup", key: "Enter", code: "Enter" });
    }
  }

  function renderLoginPanel() {
    var unlocked = !!vault.key;
    $("loginLocked").style.display = unlocked ? "none" : "block";
    $("loginUnlocked").style.display = unlocked ? "block" : "none";
    var exists = vault.serverExists || !!safeGet("hb_vault_v1");
    $("vaultHint").textContent = exists
      ? "Enter your passphrase to unlock (works on all your devices)."
      : "Create a passphrase to encrypt your logins. They sync to all your devices, encrypted. It can't be recovered if forgotten.";
    $("vaultUnlockBtn").textContent = exists ? "🔓 Unlock" : "🔐 Create vault";

    var list = $("vaultAccounts");
    list.innerHTML = "";
    if (!unlocked) return;
    if (!vault.accounts.length) {
      var empty = document.createElement("div");
      empty.className = "lp-note";
      empty.textContent = "No accounts yet.";
      list.appendChild(empty);
    }
    vault.accounts.forEach(function (a, idx) {
      var card = document.createElement("div");
      card.className = "acct-card";
      var t = document.createElement("div"); t.className = "acct-title"; t.textContent = a.label || a.email;
      var sub = document.createElement("div"); sub.className = "acct-sub"; sub.textContent = a.email;
      var row = document.createElement("div"); row.className = "acct-row";

      function mk(label, fn) {
        var b = document.createElement("button");
        b.type = "button"; b.className = "btn"; b.textContent = label;
        b.addEventListener("click", guard(async function () { touchVaultTimer(); await fn(); }));
        return b;
      }
      var enter = function () { return $("vaultEnter").checked; };
      row.appendChild(mk("✉️ Email", function () { return typeIntoVm(a.email, enter()); }));
      row.appendChild(mk("🔑 Pass", function () { return typeIntoVm(a.password, enter()); }));
      if (a.totp) {
        row.appendChild(mk("🔢 Code", async function () {
          var left = 30 - ((Date.now() / 1000) % 30);
          if (left < 3) { toast("⏳ Waiting for a fresh code...", "info", 2500); await sleep(Math.ceil(left * 1000) + 300); }
          var code = await totpNow(a.totp);
          await typeIntoVm(code, enter());
        }));
      }
      var del = document.createElement("button");
      del.type = "button"; del.className = "btn btn-danger"; del.textContent = "🗑️";
      del.style.flex = "0 0 auto";
      del.addEventListener("click", guard(async function () {
        if (!confirm("Delete " + (a.label || a.email) + "?")) return;
        vault.accounts.splice(idx, 1);
        await vaultSave();
        renderLoginPanel();
      }));
      row.appendChild(del);

      card.appendChild(t); card.appendChild(sub); card.appendChild(row);
      list.appendChild(card);
    });
  }

  async function checkCookieStatus() {
    var el = $("cookieStatusText");
    el.textContent = "Checking...";
    var d = await api("/api/cookies-status");
    if (!d.updated) {
      el.textContent = "No cookies received yet. Launch with sync on, log in somewhere, wait ~1-2 min.";
    } else {
      var mins = Math.max(0, Math.round((Date.now() - d.updated) / 60000));
      el.textContent = "✅ " + d.count + " cookies stored, last updated " + mins + " min ago." + (d.kv ? "" : " ⚠️ memory only (no KV).");
    }
  }

  async function openLoginPanel() {
    var panel = $("loginPanel");
    var show = panel.style.display !== "block";
    $("clipPanel").style.display = "none";
    panel.style.display = show ? "block" : "none";
    if (show) {
      renderLoginPanel();
      var sv = await fetchServerVault();
      vault.serverExists = !!sv;
      renderLoginPanel();
    }
  }

  async function onVaultUnlock() {
    var pass = $("vaultPass").value;
    if (!pass || pass.length < 6) return toast("Use a passphrase of at least 6 characters", "error");
    var btn = $("vaultUnlockBtn");
    btn.disabled = true;
    try {
      await vaultUnlock(pass);
      $("vaultPass").value = "";
      touchVaultTimer();
      renderLoginPanel();
    } finally { btn.disabled = false; }
  }

  async function onSaveAccount() {
    var email = $("acctEmail").value.trim();
    var password = $("acctPass").value;
    var totp = $("acctTotp").value.replace(/\s/g, "");
    if (!email || !password) return toast("Email and password are required", "error");
    if (totp) { try { base32decode(totp); } catch (e) { return toast(e.message, "error"); } }
    vault.accounts.push({ label: $("acctLabel").value.trim() || email, email: email, password: password, totp: totp });
    await vaultSave();
    ["acctLabel", "acctEmail", "acctPass", "acctTotp"].forEach(function (id) { $(id).value = ""; });
    $("addAcctForm").style.display = "none";
    touchVaultTimer();
    renderLoginPanel();
    toast("💾 Account saved (encrypted)", "success", 2000);
  }


  // ------------------------------------------------------------------
  // Clipboard tools: Ctrl+C/V/X, VM -> iPad "copy back", clipboard manager
  // ------------------------------------------------------------------
  // CLIPBOARD-LOGIC-BEGIN
  async function vmCombo(letter) {
    if (!hb) throw new Error("Launch a session first");
    var code = "Key" + letter.toUpperCase();
    wakeCursor();
    send({ type: "keydown", key: "Control", code: "ControlLeft", ctrlKey: true });
    await sleep(25);
    send({ type: "keydown", key: letter, code: code, ctrlKey: true });
    await sleep(25);
    send({ type: "keyup", key: letter, code: code, ctrlKey: true });
    await sleep(25);
    send({ type: "keyup", key: "Control", code: "ControlLeft" });
  }

  async function activeTab() {
    try { var a = await hb.tabs.query({ active: true }); return a && a[0] ? a[0] : null; } catch (e) { return null; }
  }
  async function closeHelperTab(tab, prev) {
    try { if (tab && tab.id != null) await hb.tabs.remove(tab.id); } catch (e) {}
    try { if (prev && prev.id != null) await hb.tabs.update(prev.id, { active: true }); } catch (e) {}
  }

  // VM clipboard -> text. Opens a helper tab in the VM, pastes into it, and waits for the text to arrive.
  async function captureVmClipboard() {
    if (!hb || !hb.tabs) throw new Error("Launch a session first");
    var cid = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    var prev = await activeTab();
    var tab = await hb.tabs.create({ url: location.origin + "/clip-out?cid=" + cid });
    await sleep(1400);
    await vmCombo("v");
    var text = null, t0 = Date.now();
    while (Date.now() - t0 < 9000) {
      var r = await fetch("/api/clipout?cid=" + cid, { cache: "no-store" });
      if (r.status === 200) { text = await r.text(); break; }
      await sleep(400);
    }
    await closeHelperTab(tab, prev);
    if (text == null) {
      throw new Error(serverKv === false
        ? "Nothing arrived. Copy back needs a KV namespace named SAVES_KV, because your iPad and the VM reach different Cloudflare servers."
        : "Nothing arrived. Copy something in the VM first (select text, then Ctrl+C).");
    }
    return text;
  }

  // Text -> VM clipboard (and optionally paste it). Private: never goes through a public paste site.
  var serverKv = null;      // does the Worker have a KV namespace? (set at startup)
  function setServerKv(v) { serverKv = v; }

  function b64urlUtf8(text) {
    var bytes = new TextEncoder().encode(text), bin = "";
    for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  // Without KV, Cloudflare may answer the VM from a different server than the one that stored the clip
  // ("Clip expired or not found"). So the text rides inside the URL fragment instead: no server storage at all.
  async function clipUrlForVm(text) {
    if (serverKv !== false) {
      var d = await postJSON("/api/clip", { text: text, private: true });
      if (d && d.kv !== false && d.viewUrl) return d.viewUrl;
      serverKv = false;
    }
    var enc = b64urlUtf8(text);
    if (enc.length > 300000) {
      throw new Error("This clip is too long to send without KV. Bind a KV namespace named SAVES_KV (Worker > Settings > Bindings) and try again.");
    }
    return location.origin + "/clip?inline=1#" + enc;
  }

  async function sendTextToVmClipboard(text, pasteAfter) {
    if (!hb || !hb.tabs) throw new Error("Launch a session first");
    var clipUrl = await clipUrlForVm(text);
    var prev = await activeTab();
    var tab = await hb.tabs.create({ url: clipUrl });
    await sleep(1500 + Math.min(3000, Math.round(text.length / 50)));
    await vmCombo("c");
    await sleep(350);
    await closeHelperTab(tab, prev);
    if (pasteAfter) { await sleep(600); await vmCombo("v"); }
  }

  var CLIPS_KEY = "hb_clips_v1";
  function loadClips() {
    try { return JSON.parse(safeGet(CLIPS_KEY) || "[]"); } catch (e) { return []; }
  }
  function storeClips(list) {
    list = list.slice(0, 40);
    while (list.length > 1 && JSON.stringify(list).length > 4000000) list.pop();
    try { localStorage.setItem(CLIPS_KEY, JSON.stringify(list)); }
    catch (e) { toast("Clip storage is full. Delete some clips.", "error"); }
    return list;
  }
  function saveClip(text, src) {
    if (!text) return;
    var list = loadClips().filter(function (c) { return c.text !== text; });
    list.unshift({ id: "c" + Date.now().toString(36), text: text, ts: Date.now(), src: src || "manual" });
    storeClips(list);
    var panel = $("clipPanel");
    if (panel && panel.style.display === "block") renderClipPanel();
  }
  // CLIPBOARD-LOGIC-END

  // iPad clipboard write. Must be called straight from a tap; a Promise inside ClipboardItem lets Safari wait for the async text.
  function writeLocalClipboard(textPromise) {
    try {
      if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
        var item = new ClipboardItem({
          "text/plain": textPromise.then(function (t) { return new Blob([t], { type: "text/plain" }); })
        });
        return navigator.clipboard.write([item]);
      }
    } catch (e) {}
    return textPromise.then(function (t) { return navigator.clipboard.writeText(t); });
  }

  function copyLocalText(text) {
    var done = function () { toast("📱 Copied to your clipboard (" + text.length + " chars)", "success", 2500); };
    var fallback = function () {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0.01;user-select:text;-webkit-user-select:text;";
      document.body.appendChild(ta);
      ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) {}
      document.body.removeChild(ta);
      if (ok) done(); else toast("Could not copy. Long-press the text in Clips instead.", "error");
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }

  // Call directly from a tap handler (keeps the iPadOS "user gesture" alive)
  function grabVmClipboard() {
    if (!hb || !hb.tabs) { toast("Launch a session first", "error"); return; }
    toast("📥 Grabbing the VM clipboard...", "info", 3000);
    var p = captureVmClipboard();
    var w = writeLocalClipboard(p);
    w.catch(function () {});
    p.then(function (text) {
      saveClip(text, "vm");
      return w.then(function () {
        toast("✅ Copied to your iPad clipboard (" + text.length + " chars) and saved in 📚 Clips", "success", 4500);
      }, function () {
        toast("📚 Got the text and saved it in Clips, but iPadOS blocked the auto-copy. Tap 📱 Copy there.", "error", 9000);
        openClipPanel(true);
      });
    }).catch(function (e) { toast("Copy back failed: " + e.message, "error", 9000); });
  }

  function timeAgo(ts) {
    var m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    var h = Math.round(m / 60);
    return h < 48 ? h + " h ago" : Math.round(h / 24) + " d ago";
  }

  function renderClipPanel() {
    var list = $("clipList");
    list.innerHTML = "";
    var clips = loadClips();
    if (!clips.length) {
      var e = document.createElement("div");
      e.className = "lp-note";
      e.textContent = "No clips yet. Use 📥 Grab after copying in the VM.";
      list.appendChild(e);
      return;
    }
    clips.forEach(function (c) {
      var card = document.createElement("div");
      card.className = "acct-card";
      var t = document.createElement("div");
      t.className = "acct-title";
      t.style.fontWeight = "500";
      t.style.color = "#e4e4e7";
      t.textContent = c.text.replace(/\s+/g, " ").slice(0, 90) || "(blank)";
      var sub = document.createElement("div");
      sub.className = "acct-sub";
      sub.textContent = c.text.length + " chars · " + timeAgo(c.ts) + " · " + (c.src === "vm" ? "from VM" : "manual");
      var row = document.createElement("div");
      row.className = "acct-row";
      function mk(label, fn) {
        var b = document.createElement("button");
        b.type = "button"; b.className = "btn"; b.textContent = label;
        b.addEventListener("click", guard(fn));
        row.appendChild(b);
      }
      mk("📱 Copy", function () { copyLocalText(c.text); });
      mk("🖥️ To VM", async function () {
        toast("➡️ Sending to the VM...", "info", 2500);
        await sendTextToVmClipboard(c.text, false);
        toast("✅ In the VM clipboard. Use Ctrl+V.", "success", 3000);
      });
      mk("⏎ Paste", async function () {
        toast("➡️ Sending and pasting...", "info", 2500);
        await sendTextToVmClipboard(c.text, true);
        toast("✅ Pasted into the VM", "success", 2000);
      });
      mk("🗑️", function () {
        storeClips(loadClips().filter(function (x) { return x.id !== c.id; }));
        renderClipPanel();
      });
      card.appendChild(t); card.appendChild(sub); card.appendChild(row);
      list.appendChild(card);
    });
  }

  function openClipPanel(forceOpen) {
    var panel = $("clipPanel");
    var show = forceOpen === true || panel.style.display !== "block";
    $("loginPanel").style.display = "none";
    panel.style.display = show ? "block" : "none";
    if (show) renderClipPanel();
  }

  function openMiniMenu() {
    var btn = $("selectAllBtn"), m = $("miniMenu"), r = btn.getBoundingClientRect();
    m.style.display = "flex";
    var w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.max(6, Math.min(window.innerWidth - w - 6, r.right - w)) + "px";
    m.style.top = Math.max(6, r.top - h - 10) + "px";
  }
  function closeMiniMenu() { $("miniMenu").style.display = "none"; }



  // ------------------------------------------------------------------
  // Sleep mode
  // ------------------------------------------------------------------
  // SLEEP-LOGIC-BEGIN
  function refreshSleepBtn() {
    var b = $("sleepBtn");
    if (!b) return;
    var flagged = !!(hb && currentSessionId && safeGet("hb_sleep_flag") === currentSessionId);
    b.textContent = flagged ? "☀️ Wake" : "😴 Sleep";
    b.classList.toggle("active-toggle", flagged);
  }

  function showSleepingSplash(label) {
    $("splash").style.display = "flex";
    $("runningInfo").textContent = "😴 Your VM is sleeping and stays alive in the cloud (up to " + label + " with nobody connected). You can close this page or turn off the iPad.";
    $("reconnectRow").style.display = "block";
    document.title = "😴 Sleeping - Hyperbeam";
  }

  async function goToSleep() {
    if (!hb || !currentSessionId) { toast("No running session to put to sleep", "error"); return; }
    if (!confirm("Put the VM to sleep?\n\nIt keeps running in the cloud while you close this page or turn the iPad off, until you Wake or Stop it. Sleeping still uses your Hyperbeam minutes.")) return;
    setBoot(true, "😴 Going to sleep...");
    try {
      var r;
      try {
        r = await postJSON("/api/sleep", { sessionId: currentSessionId, mode: "sleep" });
      } catch (err) {
        // Backup plan: a sleep-proof VM was created with a long timeout, so it is protected even if extending it failed.
        if (safeGet("hb_sleep_proof") !== currentSessionId) throw err;
        var hrs = Math.max(1, Math.round((parseInt(safeGet("hb_sleep_proof_secs") || "3600", 10) || 3600) / 3600));
        r = { label: "its launch timeout (about " + hrs + " h)" };
        toast("ℹ️ Couldn't extend the timeout, but this VM was launched sleep-proof, so it stays alive anyway.", "info", 8000);
      }
      safeSet("hb_sleep_flag", currentSessionId);
      try { if (typeof hb.destroy === "function") hb.destroy(); } catch (e) {}
      hb = null;
      streamContainer.innerHTML = "";
      cursorEl.style.display = "none";
      refreshSleepBtn();
      await checkAutoReconnect();            // so the Reconnect / Wake buttons know which VM to join
      showSleepingSplash(r.label);
      toast("😴 Sleeping. Your VM stays alive for up to " + r.label + " with nobody connected. You can close this page or the iPad now.", "success", 12000);
    } catch (e) {
      toast("Could not enable sleep: " + e.message + ". This VM wasn't launched sleep-proof. Stop it and launch again with 🛡️ Sleep-proof ticked (🔐 Login panel).", "error", 14000);
    } finally {
      setBoot(false);
    }
  }

  async function wakeInPlace() {
    var r = await postJSON("/api/sleep", { sessionId: currentSessionId, mode: "wake" });
    safeDel("hb_sleep_flag");
    refreshSleepBtn();
    toast("☀️ Awake. Normal timeout is back: if you leave now, the VM ends after " + r.label + ".", "success", 7000);
  }
  // SLEEP-LOGIC-END

  function toggleSleep() {
    if (hb && currentSessionId && safeGet("hb_sleep_flag") === currentSessionId) return wakeInPlace();
    return goToSleep();
  }

  async function wakeAndReconnect() {
    if (!pendingReconnect) { toast("No running VM found. It may have ended. Tap Launch Session.", "error"); return; }
    await attachToSession(pendingReconnect);
    await wakeInPlace();
  }

  function guard(fn) {
    return function (e) {
      try {
        var r = fn(e);
        if (r && typeof r.catch === "function") {
          r.catch(function (err) { console.error(err); toast("Error: " + (err && err.message || err), "error"); });
        }
      } catch (err) {
        console.error(err);
        toast("Error: " + (err && err.message || err), "error");
      }
    };
  }
  function on(id, ev, fn) {
    var el = $(id);
    if (el) el.addEventListener(ev, guard(fn));
  }

  function init() {
    installAudioTap();
    streamWrapper = $("stream-wrapper");
    streamContainer = $("stream-container");
    cursorEl = $("hardware-cursor");

    document.body.classList.toggle("is-desktop", isDesktop);
    if (!isDesktop) document.body.classList.add("show-trackpad");
    $("trackpadToggleBtn").classList.toggle("active-toggle", !isDesktop);

    // Top bar
    on("resSelect", "change", function (e) { return changeResolutionPreset(e.target.value); });
    on("audioBoostSelect", "change", function (e) { setAudioBoost(e.target.value); });
    $("audioBoostSelect").addEventListener("change", function (e) { audioTap.mult = parseFloat(e.target.value) || 1; });
    on("saveBtn", "click", triggerSaveWorkspace);
    on("restoreBtn", "click", openRestoreModal);
    on("fetchMediaBtn", "click", fetchAndPlayNativeMedia);
    on("pasteBtn", "click", openClipboardModal);
    on("trackpadToggleBtn", "click", toggleTrackpadVisibility);
    on("stopBtn", "click", forceTerminateActive);
    on("sleepBtn", "click", toggleSleep);
    on("splashWakeBtn", "click", wakeAndReconnect);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && !hb) checkAutoReconnect();
    });
    setInterval(function () { if (!hb && document.visibilityState === "visible") checkAutoReconnect(); }, 30000);
    on("reconnectBtn", "click", reconnectStream);
    on("loginBtn", "click", openLoginPanel);
    on("loginCloseBtn", "click", function () { $("loginPanel").style.display = "none"; });
    on("vaultUnlockBtn", "click", onVaultUnlock);
    on("vaultLockBtn", "click", function () { vaultLock(); toast("🔒 Vault locked", "info", 1500); });
    on("addAcctToggle", "click", function () {
      var f = $("addAcctForm");
      f.style.display = f.style.display === "block" ? "none" : "block";
    });
    on("acctSaveBtn", "click", onSaveAccount);
    on("cookieStatusBtn", "click", checkCookieStatus);


    // Is KV bound? Many features (vault, saves, clips, copy back) need it.
    api("/api/cookies-status").then(function (d) {
      setServerKv(!!d.kv);
    }).catch(function () {});

    // Clipboard tools
    on("mmCopy", "click", function () { closeMiniMenu(); return vmCombo("c"); });
    on("mmPaste", "click", function () { closeMiniMenu(); return vmCombo("v"); });
    on("mmCut", "click", function () { closeMiniMenu(); return vmCombo("x"); });
    on("mmGrab", "click", function () { closeMiniMenu(); grabVmClipboard(); });
    on("mmClips", "click", function () { closeMiniMenu(); openClipPanel(true); });
    on("clipsBtn", "click", function () { openClipPanel(); });
    on("clipPanelClose", "click", function () { $("clipPanel").style.display = "none"; });
    on("cpCopy", "click", function () { return vmCombo("c"); });
    on("cpPaste", "click", function () { return vmCombo("v"); });
    on("cpGrab", "click", function () { grabVmClipboard(); });
    on("clipAddBtn", "click", function () {
      var t = $("clipAddBox").value;
      if (!t.trim()) return toast("Type or paste some text first", "error");
      saveClip(t, "manual");
      $("clipAddBox").value = "";
      renderClipPanel();
    });
    document.addEventListener("pointerdown", function (e) {
      var m = $("miniMenu");
      if (m.style.display === "flex" && !m.contains(e.target) && e.target.id !== "selectAllBtn") closeMiniMenu();
    });
    var proofChk = $("sleepProofChk");
    proofChk.checked = safeGet("hb_sleepproof") !== "0";
    proofChk.addEventListener("change", function () { safeSet("hb_sleepproof", proofChk.checked ? "1" : "0"); });
    var syncChk = $("cookieSyncChk");
    syncChk.checked = safeGet("hb_cookiesync") !== "0";
    syncChk.addEventListener("change", function () { safeSet("hb_cookiesync", syncChk.checked ? "1" : "0"); });
    $("vaultPass").addEventListener("keydown", function (e) { if (e.key === "Enter") guard(onVaultUnlock)(); });

    // Splash
    on("splashLaunchBtn", "click", launchFreshSession);
    on("splashRestoreBtn", "click", openRestoreModal);
    on("splashReconnectBtn", "click", async function () {
      if (!pendingReconnect) return;
      try { await attachToSession(pendingReconnect); }
      catch (e) { setBoot(false); toast("Reconnect failed: " + e.message, "error", 9000); }
    });

    // Modals / theater
    on("restoreCloseBtn", "click", closeRestoreModal);
    on("clipCloseBtn", "click", closeClipboardModal);
    on("clipCancelBtn", "click", closeClipboardModal);
    on("transferClipBtn", "click", sendToVmClipboard);
    on("theaterCloseBtn", "click", closeNativeMedia);

    wireDesktopInput();
    wireTrackpad();
    wireKeyboardBuffer();
    startUsageTimer();
    window.addEventListener("resize", updateCursorPosition);

    // Explicit window bindings (fallback / console debugging)
    window.launchFreshSession = launchFreshSession;
    window.openRestoreModal = openRestoreModal;
    window.closeRestoreModal = closeRestoreModal;
    window.triggerSaveWorkspace = triggerSaveWorkspace;
    window.fetchAndPlayNativeMedia = fetchAndPlayNativeMedia;
    window.closeNativeMedia = closeNativeMedia;
    window.openClipboardModal = openClipboardModal;
    window.closeClipboardModal = closeClipboardModal;
    window.openClipboardModalWithText = openClipboardModalWithText;
    window.sendToVmClipboard = sendToVmClipboard;
    window.toggleTrackpadVisibility = toggleTrackpadVisibility;
    window.forceTerminateActive = forceTerminateActive;
    window.setAudioBoost = setAudioBoost;
    window.reconnectStream = reconnectStream;
    window.changeResolutionPreset = changeResolutionPreset;
    window.setDefaultSaveState = setDefaultSaveState;
    window.deleteSaveState = deleteSaveState;
    window.restoreChosenSave = restoreChosenSave;

    checkAutoReconnect();
  }

  // The script is deferred, so the DOM is parsed — but stay safe either way.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
`;


// =====================================================================
// Cookie-sync extension (zip built on the fly, uploaded to Hyperbeam at VM start)
// =====================================================================
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// Minimal "store" (no compression) ZIP writer; manifest.json sits in the zip root as Hyperbeam requires.
function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = enc.encode(f.content);
    const crc = crc32(data);

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0, true);
    lh.setUint16(8, 0, true);
    lh.setUint16(10, 0, true);
    lh.setUint16(12, 33, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, data);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, 0, true);
    ch.setUint16(14, 33, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint16(30, 0, true);
    ch.setUint16(32, 0, true);
    ch.setUint16(34, 0, true);
    ch.setUint16(36, 0, true);
    ch.setUint32(38, 0, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);

    offset += 30 + name.length + data.length;
  }
  let cdSize = 0;
  for (const p of central) cdSize += p.length;

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, 0, true);
  eocd.setUint16(6, 0, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  eocd.setUint16(20, 0, true);

  const all = parts.concat(central, [new Uint8Array(eocd.buffer)]);
  let total = 0;
  for (const p of all) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}

function extensionFiles(origin, token) {
  const manifest = JSON.stringify({
    manifest_version: 3,
    name: "Cookie Sync",
    version: "1.0.0",
    description: "Restores and saves site cookies via your own Worker",
    permissions: ["cookies", "storage", "alarms"],
    host_permissions: ["<all_urls>"],
    background: { service_worker: "background.js" }
  });
  const bg = EXT_BG.replace("__ENDPOINT__", origin).replace("__TOKEN__", token);
  return [
    { name: "manifest.json", content: manifest },
    { name: "background.js", content: bg }
  ];
}

// Auth token the extension uses (derived from your API key; never stored anywhere)
async function syncToken(apiKey) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(apiKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("cookie-sync-v1")));
  return Array.from(sig).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

// Cookies are encrypted at rest (AES-GCM, key derived from your API key)
async function cookieCryptoKey(apiKey) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey + ":cookies-v1"));
  return crypto.subtle.importKey("raw", h, "AES-GCM", false, ["encrypt", "decrypt"]);
}
function u8ToB64(u8) {
  let str = "";
  for (let i = 0; i < u8.length; i += 0x8000) str += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(str);
}
function b64ToU8(b64) {
  const bin = atob(b64), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function encryptCookies(apiKey, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await cookieCryptoKey(apiKey), new TextEncoder().encode(text)));
  return u8ToB64(iv) + "." + u8ToB64(ct);
}
async function decryptCookies(apiKey, blob) {
  const parts = blob.split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToU8(parts[0]) }, await cookieCryptoKey(apiKey), b64ToU8(parts[1]));
  return new TextDecoder().decode(pt);
}

// Runs inside the VM's Chrome. Restores saved cookies on boot, then saves changes (debounced ~1 min).
// Google domains are deliberately NOT synced (Google ties sessions to the device; copying them only triggers alerts).
const EXT_BG = String.raw`
var ENDPOINT = "__ENDPOINT__";
var TOKEN = "__TOKEN__";
var EXCLUDE = ["google.com", "googleapis.com", "gstatic.com", "gmail.com", "youtube.com", "googleusercontent.com", "ggpht.com"];
var initRunning = false;

function excluded(domain) {
  var d = String(domain || "").replace(/^\./, "").toLowerCase();
  return EXCLUDE.some(function (x) { return d === x || d.endsWith("." + x); });
}

async function api(method, body) {
  var r = await fetch(ENDPOINT + "/api/cookies", {
    method: method,
    headers: { "X-Sync-Token": TOKEN, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

async function restore() {
  var data = await api("GET");
  var list = (data && data.cookies) || [];
  var now = Date.now() / 1000;
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    try {
      if (excluded(c.domain)) continue;
      if (!c.session && c.expirationDate && c.expirationDate < now) continue;
      var host = String(c.domain).replace(/^\./, "");
      var det = {
        url: (c.secure ? "https://" : "http://") + host + c.path,
        name: c.name, value: c.value, path: c.path,
        secure: !!c.secure, httpOnly: !!c.httpOnly
      };
      if (c.sameSite) det.sameSite = c.sameSite;
      if (!c.hostOnly) det.domain = c.domain;
      if (!c.session && c.expirationDate) det.expirationDate = c.expirationDate;
      await chrome.cookies.set(det);
    } catch (e) {}
  }
}

async function flush() {
  var all = await chrome.cookies.getAll({});
  var keep = all.filter(function (c) { return !excluded(c.domain); }).map(function (c) {
    return {
      name: c.name, value: c.value, domain: c.domain, path: c.path,
      secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
      session: c.session, hostOnly: c.hostOnly, expirationDate: c.expirationDate
    };
  });
  await api("PUT", { cookies: keep });
}

// Never save before the restore finished, or an empty fresh VM would overwrite your stored cookies.
async function init() {
  if (initRunning) return;
  var st = await chrome.storage.local.get("restoreDone");
  if (st.restoreDone) return;
  initRunning = true;
  try {
    await restore();
    await chrome.storage.local.set({ restoreDone: true });
    await flush();
  } catch (e) {
  } finally {
    initRunning = false;
  }
}

async function flushIfReady() {
  var st = await chrome.storage.local.get("restoreDone");
  if (!st.restoreDone) return init();
  try { await flush(); } catch (e) {}
}

chrome.runtime.onStartup.addListener(init);
chrome.runtime.onInstalled.addListener(init);
chrome.cookies.onChanged.addListener(function () {
  chrome.alarms.get("flush", function (a) {
    if (!a) chrome.alarms.create("flush", { delayInMinutes: 1 });
  });
});
chrome.alarms.create("heartbeat", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(function (a) {
  if (a.name === "flush") flushIfReady();
  else if (a.name === "heartbeat") chrome.storage.local.get("restoreDone", function (st) { if (!st.restoreDone) init(); });
});
init();
`;
