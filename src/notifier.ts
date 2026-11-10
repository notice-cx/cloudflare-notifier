import { deliver, matchingRule, normalizeEvent, parseReport, parseWebhookBody, payloadFor } from "../lib/notifications.mjs";
import { parseSettings } from "../lib/settings.mjs";

type NotifierEnv = Env & { WEBHOOK_HEADERS?: string; WEBHOOK_BODY?: string; REPORT_TOKEN?: string };

async function readReport(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 8192) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    return parseReport(JSON.parse(text + decoder.decode()));
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

async function authorized(request: Request, token: string) {
  const input = request.headers.get("Authorization");
  if (!input?.startsWith("Bearer ") || input.length > 263) return false;
  const encoder = new TextEncoder();
  const [provided, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(input.slice(7))),
    crypto.subtle.digest("SHA-256", encoder.encode(token)),
  ]);
  return crypto.subtle.timingSafeEqual(provided, expected);
}

export default {
  async fetch(request, env) {
    const settings = parseSettings(JSON.parse(env.NOTIFIER_SETTINGS));
    if (!settings.reportEndpoint || new URL(request.url).pathname !== "/events" || request.method !== "POST") {
      return new Response(null, { status: 404 });
    }
    if (!env.REPORT_TOKEN || !await authorized(request, env.REPORT_TOKEN)) {
      return Response.json({ error: "Invalid reporting token." }, { status: 401 });
    }
    const report = await readReport(request);
    if (!report) return Response.json({ error: "Invalid event or body exceeds 8 KB." }, { status: 400 });
    if (!matchingRule(settings, report)) {
      return Response.json({ error: "This event does not match an installation rule." }, { status: 422 });
    }
    await env.EVENTS.send({ ...report, occurredAt: report.occurredAt || new Date().toISOString() });
    return Response.json({ queued: true }, { status: 202 });
  },

  async queue(batch, env) {
    const settings = parseSettings(JSON.parse(env.NOTIFIER_SETTINGS));
    const template = settings.destination === "webhook" ? parseWebhookBody(env.WEBHOOK_BODY) : null;
    for (const message of batch.messages) {
      const event = normalizeEvent(message.body, settings.accountId);
      if (!event) {
        console.warn({ result: "unsupported_event", deliveryId: message.id });
        message.ack();
        continue;
      }
      const rule = matchingRule(settings, event);
      if (!rule && event.type !== "test") {
        message.ack();
        continue;
      }
      const details = { deliveryId: message.id, type: event.type, worker: event.worker, attempt: message.attempts };
      const payload = payloadFor(settings, event, rule, message.id, template);
      const result = await deliver(settings, { url: env.WEBHOOK_URL, headers: env.WEBHOOK_HEADERS }, payload, message.attempts);
      if (result.action === "ack") {
        console.log({ ...details, result: "delivered", status: result.status });
        message.ack();
      } else if (result.action === "retry") {
        console.warn({ ...details, result: "retry_requested", status: result.status, delaySeconds: result.delay });
        message.retry({ delaySeconds: result.delay });
      } else {
        // Preserve the event before acknowledging it. A failed write lets Queues retry this message.
        await env.FAILED.send({ event: message.body, status: result.status, reason: result.reason, deliveryId: message.id });
        console.error({ ...details, result: "failed", status: result.status, reason: result.reason });
        message.ack();
      }
    }
  },
} satisfies ExportedHandler<NotifierEnv>;
