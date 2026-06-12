const GH_TOKEN = Deno.env.get("GH_TOKEN") || "";
const OWNER = "haohao2006888";
const REPO = "tongxingzhe-survey";
const PATH = "data/submissions.json";
const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}`;

// Baidu ASR credentials
const BAIDU_KEY = "rrJI9DRyudEBu7NdN6JO37i1";
const BAIDU_SECRET = "K53an5SVXnI7NS4yFq8hifX53d4hmqLW";

let baiduToken = "";
let baiduExpiry = 0;

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...extraHeaders },
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

/** Strip audio AND filter out test/non-user entries */
function cleanSubmissions(submissions: Record<string, unknown>[]) {
  return submissions
    .filter((s) => s.userName || s.name)
    .map((s) => {
      const { bio_audio, part1_audio, part2_audio, part3_audio, ua, ...rest } = s as Record<string, unknown>;
      return rest;
    });
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
      format: "pcm",
      rate: 16000,
      channel: 1,
      cuid: "survey-deno-stt",
      token,
      speech: pcmBase64,
      len: pcmBytes.length,
      dev_pid: devPid,
    }),
  });
  const data = await resp.json();
  if (data.err_no === 0) {
    return (data.result || []).join("") || "";
  }
  throw new Error("Baidu err_no=" + data.err_no + ": " + (data.err_msg || ""));
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
  };

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });

  // ── GET: return clean submissions ──
  if (req.method === "GET") {
    try {
      const getResp = await fetch(API, {
        headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github.v3+json" },
      });
      if (!getResp.ok) return json({ error: `GitHub API: ${getResp.status}` }, 502);
      const data = await getResp.json();
      const submissions: Record<string, unknown>[] = data.content
        ? JSON.parse(b64ToUtf8(data.content))
        : [];
      return json(cleanSubmissions(submissions));
    } catch (e: unknown) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  // ── POST /stt: Baidu speech-to-text (v2) ──
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

  // ── PUT /part4: update part4_text ──
  if (req.method === "PUT" && url.pathname === "/part4") {
    try {
      const { name, time, part4_text } = await req.json();
      const getResp = await fetch(API, {
        headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github.v3+json" },
      });
      const data = await getResp.json();
      const submissions = data.content ? JSON.parse(b64ToUtf8(data.content)) : [];
      const sha = data.sha;
      const idx = submissions.findIndex(
        (s: Record<string, unknown>) => (s.userName || s.name) === name && (s.time || s._received) === time
      );
      if (idx >= 0) {
        submissions[idx].part4_text = part4_text;
      } else {
        return json({ error: "Submission not found" }, 404);
      }
      const encoded = utf8ToB64(JSON.stringify(submissions, null, 2));
      const putResp = await fetch(API, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${GH_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: `✍️ ${name} 批注更新`,
          content: encoded,
          sha,
          branch: "main",
        }),
      });
      const result = await putResp.json();
      return json({ success: !!result.content });
    } catch (e: unknown) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  // ── POST: append new submission ──
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const payload = await req.json();
    const getResp = await fetch(API, {
      headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github.v3+json" },
    });
    const data = await getResp.json();
    const submissions: Record<string, unknown>[] = data.content
      ? JSON.parse(b64ToUtf8(data.content))
      : [];
    const sha = data.sha;

    submissions.push({ ...payload, _received: new Date().toISOString() });

    const encoded = utf8ToB64(JSON.stringify(submissions, null, 2));
    const putResp = await fetch(API, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${GH_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: `📝 ${payload.userName || payload.name || "?"} (${new Date().toISOString().slice(0, 10)})`,
        content: encoded,
        sha,
        branch: "main",
      }),
    });
    const result = await putResp.json();

    return json({ success: !!result.content, count: submissions.length });
  } catch (e: unknown) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
