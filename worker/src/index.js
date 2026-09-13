// Cloudflare Worker: proxies audio to Fireworks AI Whisper transcription API
// so the client (PWA) never needs to hold the Fireworks API key.

const ALLOWED_ORIGINS = new Set([
  "https://apramodk.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

function corsHeaders(origin) {
  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "https://apramodk.github.io";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

async function handleStream(request, env) {
  const origin = request.headers.get("Origin") || "";
  if (!ALLOWED_ORIGINS.has(origin)) {
    return new Response("Forbidden origin", { status: 403 });
  }
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("Expected websocket", { status: 426 });
  }

  const url = new URL(request.url);
  const language = url.searchParams.get("language") || "en";
  const fireworksUrl =
    `https://audio-streaming.us-virginia-1.direct.fireworks.ai/v1/audio/transcriptions/streaming?language=${encodeURIComponent(language)}`;

  // Open the upstream WS to Fireworks (server-side, so we can attach the
  // secret Authorization header — browsers can't set custom WS headers).
  let upstreamResp;
  try {
    upstreamResp = await fetch(fireworksUrl, {
      headers: {
        Upgrade: "websocket",
        Authorization: env.FIREWORKS_API_KEY,
      },
    });
  } catch (err) {
    return new Response("Upstream connection failed: " + err, { status: 502 });
  }

  const upstreamWs = upstreamResp.webSocket;
  if (!upstreamWs) {
    const text = await upstreamResp.text().catch(() => "");
    return new Response(
      `Upstream did not upgrade to websocket. status=${upstreamResp.status} body=${text}`,
      { status: 502 }
    );
  }
  upstreamWs.accept();

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  server.addEventListener("message", (evt) => {
    try { upstreamWs.send(evt.data); } catch (_) {}
  });
  upstreamWs.addEventListener("message", (evt) => {
    try { server.send(evt.data); } catch (_) {}
  });
  server.addEventListener("close", (evt) => {
    try { upstreamWs.close(evt.code, evt.reason); } catch (_) {}
  });
  upstreamWs.addEventListener("close", (evt) => {
    try { server.close(evt.code, evt.reason); } catch (_) {}
  });
  server.addEventListener("error", () => { try { upstreamWs.close(); } catch (_) {} });
  upstreamWs.addEventListener("error", () => { try { server.close(); } catch (_) {} });

  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);

    const url = new URL(request.url);

    if (url.pathname === "/stream") {
      return handleStream(request, env);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: cors });
    }

    if (url.pathname !== "/transcribe") {
      return new Response("Not found", { status: 404, headers: cors });
    }

    try {
      const incomingForm = await request.formData();
      const file = incomingForm.get("file");
      if (!file) {
        return new Response(JSON.stringify({ error: "Missing 'file' field" }), {
          status: 400,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }

      const diarize = incomingForm.get("diarize");

      const forwardForm = new FormData();
      forwardForm.append("file", file, file.name || "audio.webm");
      forwardForm.append("model", "whisper-v3-turbo");
      if (diarize) {
        // Word-level timestamps + speaker labels only needed for the final pass —
        // keeps the fast rolling live-caption requests lighter/quicker.
        forwardForm.append("response_format", "verbose_json");
        forwardForm.append("timestamp_granularities", "word");
        forwardForm.append("diarize", "true");
      } else {
        forwardForm.append("response_format", "json");
      }
      const language = incomingForm.get("language");
      if (language) forwardForm.append("language", language);

      const fireworksResp = await fetch(
        "https://audio-turbo.api.fireworks.ai/v1/audio/transcriptions",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${env.FIREWORKS_API_KEY}` },
          body: forwardForm,
        }
      );

      const bodyText = await fireworksResp.text();
      if (!fireworksResp.ok) {
        return new Response(
          JSON.stringify({ error: "Fireworks API error", detail: bodyText }),
          { status: fireworksResp.status, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      return new Response(bodyText, {
        status: 200,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
  },
};
