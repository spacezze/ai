/**
 * Cloudflare Worker: clean chat proxy
 *
 * Required secrets/configuration:
 *   NOTRACK_COOKIE     - full upstream Cookie value, stored as a Worker secret
 *   NOTRACK_UID        - optional alternative to NOTRACK_COOKIE
 *   SI_USR_ID          - optional alternative to NOTRACK_COOKIE
 *   SI_SES_ID          - optional alternative to NOTRACK_COOKIE
 *   DEFAULT_CHAT_ID    - optional default conversation ID
 *   CORS_ORIGINS       - optional comma-separated origin allowlist; defaults to "*"
 *   UPSTREAM_URL       - optional upstream URL override
 */

const DEFAULT_UPSTREAM_URL = "https://notrack.ai/api/dispatch";
const MAX_MESSAGE_LENGTH = 8_000;
const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_MAX_TURNS = 6;
const MAX_MAX_TURNS = 20;

export default {
  async fetch(request, env) {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    const cors = getCorsHeaders(request, env);

    if (request.method === "OPTIONS") {
      if (!cors.allowed) {
        return new Response(null, { status: 403 });
      }

      return new Response(null, {
        status: 204,
        headers: {
          ...cors.headers,
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return jsonResponse(
        {
          ok: true,
          service: "chat-proxy",
          upstreamConfigured: Boolean(getCookieString(env)),
          timestamp: new Date().toISOString(),
          requestId
        },
        200,
        cors.headers
      );
    }

    if (url.pathname === "/" && request.method === "GET") {
      return jsonResponse(
        {
          ok: true,
          message: "Chat proxy is running.",
          endpoints: {
            chat: "POST /api/chat",
            health: "GET /health"
          },
          requestId
        },
        200,
        cors.headers
      );
    }

    if (url.pathname !== "/api/chat") {
      return jsonResponse(
        { ok: false, error: "Route not found.", requestId },
        404,
        cors.headers
      );
    }

    if (request.method !== "POST") {
      return jsonResponse(
        { ok: false, error: "Method not allowed. Use POST /api/chat.", requestId },
        405,
        { ...cors.headers, Allow: "POST, OPTIONS" }
      );
    }

    if (!cors.allowed) {
      return jsonResponse(
        { ok: false, error: "Origin is not allowed.", requestId },
        403,
        {}
      );
    }

    try {
      const body = await readJsonBody(request);
      const input = validateInput(body);

      const cookieString = getCookieString(env);
      if (!cookieString) {
        return jsonResponse(
          {
            ok: false,
            error: "The upstream session is not configured. Add NOTRACK_COOKIE as a Worker secret.",
            requestId
          },
          500,
          cors.headers
        );
      }

      const payload = {
        user_input: input.message,
        model: input.model,
        persona: input.persona,
        mode: input.mode,
        max_turns: input.maxTurns,
        chat_id: input.chatId,
        edit: false,
        edit_mid: null,
        regenerate: input.regenerate,
        attachments: input.attachments
      };

      const upstreamResponse = await fetchWithTimeout(
        env.UPSTREAM_URL || DEFAULT_UPSTREAM_URL,
        {
          method: "POST",
          headers: {
            Accept: "text/event-stream, application/json",
            "Content-Type": "application/json",
            Origin: "https://notrack.ai",
            Referer: "https://notrack.ai/chat",
            Cookie: cookieString
          },
          body: JSON.stringify(payload)
        },
        Number(env.UPSTREAM_TIMEOUT_MS) || 45_000
      );

      if (!upstreamResponse.ok) {
        const upstreamText = await safeReadText(upstreamResponse);
        console.error(`[${requestId}] Upstream ${upstreamResponse.status}: ${upstreamText.slice(0, 500)}`);

        return jsonResponse(
          {
            ok: false,
            error: "The AI service rejected the request.",
            status: upstreamResponse.status,
            requestId
          },
          502,
          cors.headers
        );
      }

      const rawReply = await readUpstreamReply(upstreamResponse);
      const reply = formatReply(rawReply, input.format);

      if (!reply) {
        return jsonResponse(
          { ok: false, error: "The AI service returned an empty answer.", requestId },
          502,
          cors.headers
        );
      }

      return jsonResponse(
        {
          ok: true,
          reply,
          chatId: input.chatId,
          format: input.format,
          requestId
        },
        200,
        cors.headers
      );
    } catch (error) {
      const status = error?.status || (error?.name === "AbortError" ? 504 : 500);
      const publicMessage = status >= 400 && status < 500
        ? error.message
        : status === 504
          ? "The AI service took too long to respond."
          : "The worker could not complete the request.";

      console.error(`[${requestId}] ${error?.stack || error}`);
      return jsonResponse(
        { ok: false, error: publicMessage, requestId },
        status,
        cors.headers
      );
    }
  }
};

function getCorsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const configured = String(env.CORS_ORIGINS || "*")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const allowed = !origin || configured.includes("*") || configured.includes(origin);
  const allowOrigin = !origin
    ? (configured.includes("*") ? "*" : (configured[0] || "*"))
    : (configured.includes("*") ? "*" : (allowed ? origin : "null"));

  return {
    allowed,
    headers: {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
      "Vary": "Origin"
    }
  };
}

function jsonResponse(data, status, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...headers
    }
  });
}

async function readJsonBody(request) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_BODY_BYTES) {
    throw httpError(413, "Request body is too large.");
  }

  let body;
  try {
    body = await request.json();
  } catch {
    throw httpError(400, "Request body must be valid JSON.");
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, "Request body must be a JSON object.");
  }

  return body;
}

function validateInput(body) {
  const message = typeof body.message === "string"
    ? body.message.trim()
    : typeof body.user_input === "string"
      ? body.user_input.trim()
      : "";

  if (!message) {
    throw httpError(400, "Provide a non-empty 'message' string.");
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    throw httpError(413, `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer.`);
  }

  const format = body.format === "plain" ? "plain" : "markdown";
  const maxTurns = clampInteger(body.maxTurns ?? body.max_turns, DEFAULT_MAX_TURNS, 1, MAX_MAX_TURNS);
  const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 5) : [];

  return {
    message,
    format,
    maxTurns,
    model: safeOption(body.model, "C", 40),
    persona: safeOption(body.persona, "normal", 80),
    mode: safeOption(body.mode, "usual", 80),
    chatId: safeOption(body.chatId ?? body.chat_id, crypto.randomUUID(), 100),
    regenerate: body.regenerate === true,
    attachments
  };
}

function safeOption(value, fallback, maxLength) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, maxLength)
    : fallback;
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function getCookieString(env) {
  if (env.NOTRACK_COOKIE) return String(env.NOTRACK_COOKIE).trim();

  const cookies = {
    uid: env.NOTRACK_UID,
    si_usr_id: env.SI_USR_ID,
    si_ses_id: env.SI_SES_ID
  };

  return Object.entries(cookies)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${String(value).trim()}`)
    .join("; ");
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readUpstreamReply(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const data = await response.json();
    return extractText(data);
  }

  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reply = "";

  const consumeEvent = (event) => {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();

    if (!data || data === "[DONE]") return;

    try {
      const parsed = JSON.parse(data);
      const token = extractText(parsed);
      if (token) reply = appendToken(reply, token);
    } catch {
      // Some upstreams send plain-text data events. Keep those instead of dropping them.
      reply = appendToken(reply, data);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || "";
    for (const event of events) consumeEvent(event);
  }

  buffer += decoder.decode();
  if (buffer.trim()) consumeEvent(buffer);
  return reply;
}

function extractText(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";

  const directKeys = ["content", "text", "reply", "message", "output_text"];
  for (const key of directKeys) {
    const candidate = value[key];
    if (typeof candidate === "string") return candidate;
    if (candidate && typeof candidate === "object") {
      const nested = extractText(candidate);
      if (nested) return nested;
    }
  }

  if (typeof value.delta === "string") return value.delta;
  if (value.delta && typeof value.delta === "object") return extractText(value.delta);

  if (Array.isArray(value.choices)) {
    for (const choice of value.choices) {
      const text = extractText(choice);
      if (text) return text;
    }
  }

  return "";
}

function appendToken(current, next) {
  if (!current) return next;
  if (!next || next === current || current.endsWith(next)) return current;
  if (next.startsWith(current)) return next;

  // Upstreams sometimes resend the last few characters in the next event.
  // Remove the largest suffix/prefix overlap to prevent text such as "Hellollo".
  const maxOverlap = Math.min(current.length, next.length);
  // Require at least two characters before treating a boundary as repetition;
  // a one-character match is common in normal token streams.
  for (let size = maxOverlap; size >= 2; size -= 1) {
    if (current.endsWith(next.slice(0, size))) {
      return current + next.slice(size);
    }
  }

  return current + next;
}

function formatReply(value, format) {
  let reply = String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (format === "plain") {
    reply = reply
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/__(.*?)__/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^\s*[-*+]\s+/gm, "• ")
      .replace(/^\s*\d+\.\s+/gm, "")
      .trim();
  }

  return reply;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

// Local smoke-test helpers. They are not used by the Worker runtime.
export const __test = {
  appendToken,
  extractText,
  formatReply,
  validateInput
};

// Example request:
// POST /api/chat
// {
//   "message": "Explain closures in JavaScript with a short example.",
//   "format": "markdown",
//   "maxTurns": 6,
//   "chatId": "optional-conversation-id"
// }
