const GH_TOKEN = Deno.env.get("GH_TOKEN") || "";
const OWNER = "haohao2006888";
const REPO = "tongxingzhe-survey";
const META_PATH = "data/submissions_meta.json";
const META_API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${META_PATH}`;
const SUB_DIR = "data/submissions/";
const OLD_PATH = "data/submissions.json";
const OLD_API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${OLD_PATH}`;

// Baidu ASR credentials
const BAIDU_KEY = "rrJI9DRyudEBu7NdN6JO37i1";
const BAIDU_SECRET = "K53an5SVXnI7NS4yFq8hifX53d4hmqLW";
let baiduToken = "";
let baiduExpiry = 0;

function subApi(id: string) {
  return `https://api.github.com/repos/${OWNER}/${REPO}/contents/${SUB_DIR}${id}.json`;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function utf8ToB64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function b64ToUtf8(str: string): string {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function makeId(s: Record<string, unknown>): string {
  const ts = (s.time || s._received || new Date().toISOString()) as string;
  const name = ((s.userName || s.name || "?") as string).slice(0, 8).replace(/[^a-zA-Z\u4e00-\u9fff0-9]/g, "");
  // Use full timestamp including ms + random suffix to prevent collisions
  const clean = ts.replace(/[:.]/g, "-").slice(0, 23); // keep milliseconds
  const rand = Math.random().toString(36).slice(2, 5);
  return clean + "_" + name + "_" + rand;
}

/** Build text-only meta entry (no audio) */
function toMeta(s: Record<string, unknown>) {
  const { bio_audio, part1_audio, part2_audio, part3_audio, ua, _received, ...rest } = s;
  rest.id = makeId(s);
  return rest;
}

// ── GitHub API helpers ──
const ghHeaders = { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github.v3+json" };

async function ghGet(url: string) {
  const resp = await fetch(url, { headers: ghHeaders });
  if (!resp.ok) throw new Error(`GitHub GET ${resp.status}`);
  return resp.json();
}

async function ghPut(url: string, content: string, sha: string | null, msg: string) {
  const body: Record<string, string> = { message: msg, content: utf8ToB64(content), branch: "main" };
  if (sha) body.sha = sha;
  const resp = await fetch(url, {
    method: "PUT",
    headers: { ...ghHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`GitHub PUT ${resp.status}: ${(err as any).message || ""}`);
  }
  return resp.json();
}

// ── One-time migration: old submissions.json → individual files + meta ──
async function migrateIfNeeded(): Promise<void> {
  // Check if meta already exists
  try { await ghGet(META_API); return; } catch { /* need migration */ }

  // Check for old submissions.json
  let oldSubs: Record<string, unknown>[];
  try {
    const data = await ghGet(OLD_API);
    oldSubs = data.content ? JSON.parse(b64ToUtf8(data.content)) : [];
  } catch { return; }

  const valid = oldSubs.filter((s: any) => s.userName || s.name);
  if (valid.length === 0) return;

  console.log(`Migrating ${valid.length} entries from old format...`);

  // Create individual files + build meta array
  const meta: Record<string, unknown>[] = [];
  for (const s of valid) {
    const entry = toMeta(s);
    meta.push(entry);

    // Create individual file (with audio intact)
    const fileUrl = subApi(entry.id as string);
    try {
      await ghGet(fileUrl); // already exists, skip
    } catch {
      await ghPut(fileUrl, JSON.stringify(s, null, 2), null,
        `📦 迁移: ${s.userName || s.name || "?"}`);
    }
  }

  // Write meta index
  await ghPut(META_API, JSON.stringify(meta, null, 2), null, "📋 创建元数据索引");
  console.log(`Migration complete: ${meta.length} entries`);
}

// ── Baidu ASR ──
async function getBaiduToken() {
  if (baiduToken && Date.now() < baiduExpiry) return baiduToken;
  const resp = await fetch(
    `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${BAIDU_KEY}&client_secret=${BAIDU_SECRET}`,
    { method: "POST" }
  );
  const data = await resp.json();
  baiduToken = data.access_token || "";
  baiduExpiry = Date.now() + (data.expires_in || 86400) * 1000 - 60000;
  return baiduToken;
}

async function baiduSTT(pcmBase64: string, devPid: number): Promise<string> {
  const token = await getBaiduToken();
  const binaryStr = atob(pcmBase64);
  const pcmBytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    pcmBytes[i] = binaryStr.charCodeAt(i);
  }
  const resp = await fetch("http://vop.baidu.com/server_api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      format: "pcm", rate: 16000, channel: 1, cuid: "survey-deno-stt",
      token, speech: pcmBase64, len: pcmBytes.length, dev_pid: devPid,
    }),
  });
  const data = await resp.json();
  if (data.err_no === 0) return (data.result || []).join("") || "";
  throw new Error("Baidu err_no=" + data.err_no + ": " + (data.err_msg || ""));
}

// ── Server ──
Deno.serve(async (req) => {
  const url = new URL(req.url);
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
  };

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  // ── GET / : fast list from meta index ──
  if (req.method === "GET" && url.pathname === "/") {
    try {
      await migrateIfNeeded();
      try {
        const data = await ghGet(META_API);
        const meta: Record<string, unknown>[] = data.content
          ? JSON.parse(b64ToUtf8(data.content)) : [];
        // Filter: only return entries that have userName or name (real submissions)
        const clean = meta.filter((m: any) => m.userName || m.name);
        return json(clean);
      } catch { return json([]); } // No data yet
    } catch (e: unknown) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  // ── GET /submission?id=xxx : full data with audio ──
  if (req.method === "GET" && url.pathname === "/submission") {
    try {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "missing id" }, 400);
      const data = await ghGet(subApi(id));
      const sub = data.content ? JSON.parse(b64ToUtf8(data.content)) : null;
      return json(sub || { error: "not found" });
    } catch (e: unknown) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  // ── POST /stt : Baidu speech-to-text ──
  if (url.pathname === "/stt" && req.method === "POST") {
    try {
      const body = await req.json();
      const pcm = body.audio || body.audio_base64 || body.speech || "";
      if (!pcm) return json({ error: "missing audio" }, 400);
      const devPid = body.dev_pid ? Number(body.dev_pid) : 1537;
      const text = await baiduSTT(pcm, devPid);
      return json({ text, success: true });
    } catch (e: unknown) {
      return json({ error: e instanceof Error ? e.message : String(e), success: false }, 500);
    }
  }

  // ── PUT /part4 : update part4_text ──
  if (req.method === "PUT" && url.pathname === "/part4") {
    try {
      const { name, time, part4_text } = await req.json();
      // Read meta, find entry, update part4
      const metaData = await ghGet(META_API);
      const meta: Record<string, unknown>[] = metaData.content
        ? JSON.parse(b64ToUtf8(metaData.content)) : [];
      const idx = meta.findIndex((m: any) =>
        (m.userName || m.name) === name && (m.time || m._received) === time
      );
      if (idx < 0) return json({ error: "Submission not found" }, 404);

      meta[idx].part4_text = part4_text;
      const id = meta[idx].id as string;

      // Update individual file too (keeps audio intact)
      try {
        const fileData = await ghGet(subApi(id));
        const sub = fileData.content ? JSON.parse(b64ToUtf8(fileData.content)) : {};
        sub.part4_text = part4_text;
        await ghPut(subApi(id), JSON.stringify(sub, null, 2), fileData.sha,
          `✍️ ${name} 批注更新`);
      } catch { /* file may not exist, meta is source of truth */ }

      // Write updated meta
      await ghPut(META_API, JSON.stringify(meta, null, 2), metaData.sha,
        `✍️ ${name} 批注更新`);
      return json({ success: true });
    } catch (e: unknown) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  // ── POST / : new submission → create individual file + append to meta ──
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const payload = await req.json();
    await migrateIfNeeded();

    const id = makeId(payload);

    // 1. Read meta, append text-only entry (do this FIRST — meta is source of truth)
    let metaSha: string;
    let meta: Record<string, unknown>[];
    try {
      const metaData = await ghGet(META_API);
      meta = metaData.content ? JSON.parse(b64ToUtf8(metaData.content)) : [];
      metaSha = metaData.sha;
    } catch {
      meta = [];
      metaSha = "";
    }
    meta.push(toMeta(payload));

    // 2. Write updated meta
    await ghPut(META_API, JSON.stringify(meta, null, 2), metaSha,
      `📝 ${payload.userName || payload.name || "?"} (${new Date().toISOString().slice(0, 10)})`);

    // 3. Create individual file with full data (including audio) — best-effort
    const fullEntry = { ...payload, _received: new Date().toISOString(), id };
    try {
      await ghPut(subApi(id), JSON.stringify(fullEntry, null, 2), null,
        `📝 ${payload.userName || payload.name || "?"}`);
    } catch (e) {
      console.warn("Individual file creation failed (meta already saved):", e);
    }

    return json({ success: true, count: meta.length });
  } catch (e: unknown) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
