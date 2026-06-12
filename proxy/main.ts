const GH_TOKEN = Deno.env.get("GH_TOKEN") || "";
const OWNER = "haohao2006888";
const REPO = "tongxingzhe-survey";
const PATH = "data/submissions.json";
const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}`;

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
    .filter((s) => s.userName || s.name) // skip test entries
    .map((s) => {
      const { bio_audio, part1_audio, part2_audio, part3_audio, ua, ...rest } = s as Record<string, unknown>;
      return rest;
    });
}

Deno.serve(async (req) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
  };

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });

  // ── GET: return clean submissions (no audio, no test entries) ──
  if (req.method === "GET") {
    try {
      const getResp = await fetch(API, {
        headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github.v3+json" },
      });
      if (!getResp.ok) {
        return new Response(JSON.stringify({ error: `GitHub API: ${getResp.status}` }), {
          status: 502,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      const data = await getResp.json();
      const submissions: Record<string, unknown>[] = data.content
        ? JSON.parse(b64ToUtf8(data.content))
        : [];
      const lite = cleanSubmissions(submissions);
      return new Response(JSON.stringify(lite), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ error: msg }), {
        status: 500,
        headers: { ...headers, "Content-Type": "application/json" } },
      );
    }
  }

  // ── PUT /part4: update part4_text of a specific submission ──
  if (req.method === "PUT" && new URL(req.url).pathname === "/part4") {
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
        return new Response(JSON.stringify({ error: "Submission not found" }), {
          status: 404,
          headers: { ...headers, "Content-Type": "application/json" },
        });
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
      return new Response(
        JSON.stringify({ success: !!result.content }),
        { headers: { ...headers, "Content-Type": "application/json" } },
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ error: msg }), {
        status: 500,
        headers: { ...headers, "Content-Type": "application/json" } },
      );
    }
  }

  // ── POST: append new submission ──
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...headers, "Content-Type": "application/json" },
    });
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

    return new Response(
      JSON.stringify({ success: !!result.content, count: submissions.length }),
      { headers: { ...headers, "Content-Type": "application/json" } },
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...headers, "Content-Type": "application/json" } },
    );
  }
});
