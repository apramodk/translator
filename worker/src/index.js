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

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: cors });
    }

    const url = new URL(request.url);
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

      const forwardForm = new FormData();
      forwardForm.append("file", file, file.name || "audio.webm");
      forwardForm.append("model", "whisper-v3-turbo");
      forwardForm.append("response_format", "json");
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
