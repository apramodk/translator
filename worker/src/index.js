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

async function transcribeAudio(env, file, { diarize, language } = {}) {
  const form = new FormData();
  form.append("file", file, file.name || "audio.webm");
  form.append("model", "whisper-v3-turbo");
  if (diarize) {
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities", "word");
    form.append("diarize", "true");
  } else {
    form.append("response_format", "json");
  }
  if (language) form.append("language", language);

  const resp = await fetch("https://audio-turbo.api.fireworks.ai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.FIREWORKS_API_KEY}` },
    body: form,
  });
  const bodyText = await resp.text();
  if (!resp.ok) throw new Error(`Fireworks transcribe error (${resp.status}): ${bodyText}`);
  return JSON.parse(bodyText);
}

// Fast, non-reasoning-heavy translation via a small/quick Fireworks LLM.
// gpt-oss-120b with reasoning_effort=low was benchmarked at ~1s round trip
// with clean output (vs. "thinking" models that burn tokens on chain-of-thought
// and often get cut off before producing an answer).
async function translateText(env, text) {
  if (!text || !text.trim()) return "";
  const resp = await fetch("https://api.fireworks.ai/inference/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.FIREWORKS_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "accounts/fireworks/models/gpt-oss-120b",
      reasoning_effort: "low",
      temperature: 0.2,
      max_tokens: 300,
      messages: [
        {
          role: "system",
          content:
            "Translate the given Cantonese/Chinese text to natural, fluent English. " +
            "Reply with ONLY the translation, no notes or explanations.",
        },
        { role: "user", content: text },
      ],
    }),
  });
  const bodyText = await resp.text();
  if (!resp.ok) throw new Error(`Fireworks translate error (${resp.status}): ${bodyText}`);
  const data = JSON.parse(bodyText);
  return (data.choices?.[0]?.message?.content || "").trim();
}

async function handleTranslateLive(request, env, cors) {
  const form = await request.formData();
  const file = form.get("file");
  if (!file) {
    return new Response(JSON.stringify({ error: "Missing 'file' field" }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  const language = form.get("language") || "yue"; // default: Cantonese

  const transcription = await transcribeAudio(env, file, { language });
  const sourceText = (transcription.text || "").trim();
  const translated = sourceText ? await translateText(env, sourceText) : "";

  return new Response(JSON.stringify({ source_text: sourceText, translated_text: translated }), {
    status: 200,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

async function handleTranslateFinal(request, env, cors) {
  const form = await request.formData();
  const file = form.get("file");
  if (!file) {
    return new Response(JSON.stringify({ error: "Missing 'file' field" }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  const language = form.get("language") || "yue";

  const transcription = await transcribeAudio(env, file, { diarize: true, language });
  const words = transcription.words || [];

  // Group consecutive same-speaker words into segments.
  const segments = [];
  for (const w of words) {
    const speaker = w.speaker_id ?? "0";
    const last = segments[segments.length - 1];
    if (last && last.speaker === speaker) {
      last.text += (last.text ? " " : "") + w.word;
    } else {
      segments.push({ speaker, text: w.word });
    }
  }

  // Translate each segment. Small number of segments per recording, so
  // sequential calls are fine; could be parallelized with Promise.all.
  const translated = await Promise.all(
    segments.map((seg) => translateText(env, seg.text).catch(() => ""))
  );
  const result = segments.map((seg, i) => ({ ...seg, translated: translated[i] }));

  return new Response(JSON.stringify({ segments: result, text: transcription.text }), {
    status: 200,
    headers: { ...cors, "Content-Type": "application/json" },
  });
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

    try {
      if (url.pathname === "/translate-live") {
        return await handleTranslateLive(request, env, cors);
      }
      if (url.pathname === "/translate-final") {
        return await handleTranslateFinal(request, env, cors);
      }
      if (url.pathname !== "/transcribe") {
        return new Response("Not found", { status: 404, headers: cors });
      }

      const incomingForm = await request.formData();
      const file = incomingForm.get("file");
      if (!file) {
        return new Response(JSON.stringify({ error: "Missing 'file' field" }), {
          status: 400,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }

      const diarize = incomingForm.get("diarize");
      const language = incomingForm.get("language");
      const transcription = await transcribeAudio(env, file, { diarize: !!diarize, language });

      return new Response(JSON.stringify(transcription), {
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
