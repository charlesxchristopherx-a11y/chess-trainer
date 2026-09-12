/**
 * Chess Trainer — Cloudflare Worker
 *
 * Two jobs:
 *  1. Serve the built static site (dist/) via the ASSETS binding.
 *  2. Handle POST /api/coach — the "Ask the coach" backend, answered by
 *     Workers AI instead of a third-party API key. This is the "brains"
 *     that replaces the Anthropic call the app makes when it's running as
 *     a Claude.ai artifact (where that call is proxied for free).
 *
 * Response shape for /api/coach intentionally mirrors Anthropic's Messages
 * API ({ content: [{ type: "text", text }] }) so the frontend's existing
 * parsing code (src/ChessTrainer.jsx) needs zero changes — it already
 * tries this same-origin route first and only falls back to Anthropic
 * directly if this route doesn't exist.
 */

const SYSTEM_PROMPT =
  "You are a friendly, encouraging chess coach inside a training app. " +
  "Answer in 3-6 short sentences, plain English, no headers or markdown.";

// Small, fast, free-tier-friendly instruct model. Swap for a different
// Workers AI model name any time — see https://developers.cloudflare.com/workers-ai/models/
const MODEL = "@cf/meta/llama-3.1-8b-instruct";

function withCORS(resp) {
  resp.headers.set("Access-Control-Allow-Origin", "*");
  resp.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  resp.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return resp;
}

async function handleCoach(request, env) {
  if (request.method === "OPTIONS") {
    return withCORS(new Response(null, { status: 204 }));
  }
  if (request.method !== "POST") {
    return withCORS(new Response("Method not allowed", { status: 405 }));
  }
  try {
    const body = await request.json();
    const userPrompt =
      (body.messages && body.messages[0] && body.messages[0].content) ||
      body.prompt ||
      "";
    if (!userPrompt.trim()) {
      return withCORS(
        new Response(JSON.stringify({ content: [{ type: "text", text: "Ask me something about the position!" }] }), {
          headers: { "Content-Type": "application/json" },
        })
      );
    }

    const result = await env.AI.run(MODEL, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    });

    const text = (result && result.response) ? result.response.trim() : "";
    const payload = {
      content: [{ type: "text", text: text || "Sorry, I couldn't come up with an answer just now — try again." }],
    };
    return withCORS(
      new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } })
    );
  } catch (e) {
    const payload = { content: [{ type: "text", text: "The coach hit a snag — please try again." }] };
    return withCORS(
      new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } })
    );
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/coach") {
      return handleCoach(request, env);
    }
    // Everything else: serve the built static site.
    return env.ASSETS.fetch(request);
  },
};
