import { events, parseHeaders, parseWebhook } from "./settings.mjs";

const reports = new Set(["deployment.succeeded", "deployment.failed", "scheduled.failed"]);
const customEvents = new Set([...reports, "runtime.exception", "runtime.limit", "runtime.http"]);
const buildPrefix = "cf.workersBuilds.worker.";

function clean(value, max = 180) {
  if (typeof value !== "string") return "";
  return [...value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/https:\/\/[^\s]*?(?:api\/webhooks|services)\/[^\s]+/gi, "[webhook removed]")
    .replace(/\b(?:bearer\s+|(?:token|secret|password|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, "[credential removed]")
    .trim()].slice(0, max).join("");
}

function link(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && !/[<>|\s]/.test(url.href)) return url.href;
  } catch { /* Link was absent or invalid. */ }
  return "";
}

function duration(start, end) {
  const seconds = Math.round((Date.parse(end) - Date.parse(start)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

function dashboard(account, worker) {
  if (!/^[a-f0-9]{32}$/i.test(account ?? "") || !worker) return "";
  return `https://dash.cloudflare.com/${account}/workers/services/view/${encodeURIComponent(worker)}/production`;
}

function buildEvent(input) {
  let type = input.type.slice(buildPrefix.length);
  const payload = input.payload;
  if (!payload || typeof payload !== "object") return null;
  if (type === "build.failed" && /^(canceled|cancelled)$/.test(payload.buildOutcome ?? "")) type = "build.canceled";
  if (!type.startsWith("build.") || !Object.hasOwn(events, type)) return null;
  const worker = clean(input.source?.workerName, 63);
  if (!worker) return null;
  const meta = payload.buildTriggerMetadata;
  const base = dashboard(input.metadata?.accountId, worker);
  const sha = /^[a-f0-9]{7,64}$/i.test(meta?.commitHash ?? "") ? meta.commitHash : "";
  const provider = ["github", "gitlab"].includes(meta?.providerType) ? `${meta.providerType}.com` : "";
  const owner = clean(meta?.providerAccountName);
  const repo = clean(meta?.repoName);
  const repoPath = (value) => value.split("/").map(encodeURIComponent).join("/");
  const commitUrl = provider && owner && repo && sha
    ? `https://${provider}/${repoPath(owner)}/${encodeURIComponent(repo)}/${provider === "gitlab.com" ? "-/" : ""}commit/${sha}`
    : "";
  return {
    type,
    worker,
    branch: clean(meta?.branch, 200),
    summary: clean(meta?.commitMessage),
    fields: [
      ["Commit", sha.slice(0, 8)],
      ["Duration", duration(payload.runningAt ?? payload.createdAt, payload.stoppedAt)],
    ],
    links: [
      ["View build", base && payload.buildUuid ? `${base}/builds/${encodeURIComponent(payload.buildUuid)}` : base],
      ["View commit", commitUrl],
    ],
    occurredAt: date(input.metadata?.eventTimestamp),
  };
}

function date(value) {
  const stamp = Date.parse(value);
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : "";
}

export function parseReport(input) {
  if (!input || !reports.has(input.type)) return null;
  if (typeof input.worker !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.worker)) return null;
  const deployment = input.type.startsWith("deployment.");
  const deploymentId = clean(input.deploymentId, 90);
  const job = clean(input.job, 100);
  const schedule = clean(input.schedule, 100);
  if (input.type === "deployment.succeeded" && !deploymentId) return null;
  if (!deployment && (!job || !schedule)) return null;
  return {
    source: "notifier.report",
    type: input.type,
    worker: input.worker,
    branch: clean(input.branch, 200),
    summary: clean(input.summary),
    deploymentId,
    url: deployment ? link(input.url) : "",
    job,
    schedule,
    occurredAt: date(input.occurredAt),
  };
}

export function normalizeEvent(input, accountId) {
  if (!input || typeof input.type !== "string") return null;
  if (input.type.startsWith(buildPrefix)) return buildEvent(input);
  if (input.source === "notifier.test") return {
    type: "test", worker: "", summary: "Your destination accepted a message from Cloudflare Notifier.",
    fields: [], links: [], occurredAt: date(input.occurredAt),
  };
  if (!customEvents.has(input.type) || !["notifier.runtime", "notifier.report"].includes(input.source)) return null;
  const worker = clean(input.worker, 63);
  if (!worker) return null;
  const base = dashboard(accountId, worker);
  return {
    type: input.type, worker, branch: clean(input.branch, 200), summary: clean(input.summary),
    fields: [
      ["Deployment", clean(input.deploymentId, 90)], ["Job", clean(input.job, 100)],
      ["Schedule (UTC)", clean(input.schedule, 100)], ["Outcome", clean(input.outcome, 100)],
      ["HTTP status", input.status >= 500 && input.status < 600 ? String(input.status) : ""],
    ],
    links: [["Open deployment", link(input.url)], ["Open Worker", base]],
    occurredAt: date(input.occurredAt),
  };
}

export function matchingRule(settings, event) {
  const hasBranch = /^(build|deployment)\./.test(event.type);
  return settings.rules.find((rule) =>
    rule.worker === event.worker && rule.events.includes(event.type) &&
    (!hasBranch || !rule.branch || rule.branch === event.branch));
}

function markdown(value) {
  return value.replace(/[\\`*_~|<>\[\]()#]/g, "\\$&");
}

export function messageFor(settings, event, rule) {
  const title = events[event.type] ?? "Test notification";
  const failed = /(?:failed|exception|limit|http)$/.test(event.type);
  const tone = failed ? "danger" : /succeeded$/.test(event.type) ? "success" : "info";
  const compact = settings.style === "compact";
  const fields = [
    ["Worker", event.worker], ["Environment", rule?.environment], ["Branch", event.branch],
    ...(compact ? [] : event.fields),
  ].filter(([, value]) => value);
  return {
    title, tone, fields, links: event.links.filter(([, url]) => url),
    summary: event.type === "test" || !compact ? event.summary : "",
    role: failed && settings.destination === "discord" ? settings.role : "",
    occurredAt: event.occurredAt,
  };
}

export function renderWebhookBody(template, event) {
  if (typeof template === "string") {
    const token = template.match(/^\{\{([a-zA-Z]+)\}\}$/);
    if (!token) return template;
    if (token[1] === "event") return event;
    const allowed = ["deliveryId", "type", "worker", "environment", "branch", "occurredAt", "severity", "title", "summary", "details", "links"];
    if (!allowed.includes(token[1])) throw new Error(`Unsupported webhook field: ${token[1]}.`);
    return event[token[1]] ?? null;
  }
  if (Array.isArray(template)) return template.map((value) => renderWebhookBody(value, event));
  if (template && typeof template === "object") {
    return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, renderWebhookBody(value, event)]));
  }
  return template;
}

export function parseWebhookBody(input) {
  if (!input?.trim()) return null;
  const body = JSON.parse(input);
  if (body === null) return null;
  if (typeof body !== "object" || Array.isArray(body)) throw new Error("Enter the custom webhook body as a JSON object.");
  renderWebhookBody(body, {});
  return body;
}

export function payloadFor(settings, event, rule, id, template = null) {
  const message = messageFor(settings, event, rule);
  if (settings.destination === "discord") {
    return {
      ...(message.role ? { content: `<@&${message.role}>` } : {}),
      allowed_mentions: { parse: [], roles: message.role ? [message.role] : [] },
      embeds: [{
        title: markdown(message.title),
        color: { danger: 0xe45664, success: 0x31a778, info: 0x7186ef }[message.tone],
        description: [
          markdown(message.summary),
          ...message.links.map(([label, url]) => `[${label}](${url.replaceAll("(", "%28").replaceAll(")", "%29")})`),
        ].filter(Boolean).join("\n") || undefined,
        fields: message.fields.map(([name, value]) => ({ name, value: markdown(value), inline: true })),
        timestamp: message.occurredAt || undefined,
      }],
    };
  }
  if (settings.destination === "slack") {
    const plain = (value) => ({ type: "plain_text", text: value });
    const details = [message.summary, ...message.fields.map(([key, value]) => `${key} · ${value}`)].filter(Boolean).join("\n");
    return {
      text: message.title,
      unfurl_links: false,
      unfurl_media: false,
      blocks: [
        { type: "header", text: plain(message.title) },
        ...(details ? [{ type: "section", text: plain(details) }] : []),
        ...(message.links.length ? [{ type: "section", text: { type: "mrkdwn", text: message.links.map(([label, url]) => `<${url.replaceAll("&", "&amp;")}|${label}>`).join(" · ") } }] : []),
      ],
    };
  }
  const body = {
    schemaVersion: 1, deliveryId: id, type: event.type, worker: event.worker,
    environment: rule?.environment || undefined, branch: event.branch || undefined,
    occurredAt: event.occurredAt || undefined, severity: message.tone,
    title: message.title, summary: message.summary || undefined,
    details: Object.fromEntries(message.fields), links: Object.fromEntries(message.links),
  };
  return template ? renderWebhookBody(template, body) : body;
}

function retryDelay(value, attempt) {
  const wait = /^\d+(?:\.\d+)?$/.test(value ?? "") ? Number(value) : (Date.parse(value ?? "") - Date.now()) / 1000;
  return Number.isFinite(wait) ? Math.max(1, Math.min(43200, Math.ceil(wait))) : Math.min(900, 10 * 2 ** Math.min(attempt - 1, 7));
}

export async function deliver(settings, credentials, payload, attempt, send = fetch) {
  let url;
  let headers;
  try {
    url = parseWebhook(credentials.url, settings.destination);
    headers = parseHeaders(settings.destination === "webhook" && credentials.headers ? JSON.parse(credentials.headers) : {});
    headers.set("content-type", "application/json");
    if (settings.destination === "discord") url.searchParams.set("wait", "true");
  } catch {
    return { action: "fail", reason: "invalid_destination" };
  }
  let response;
  try {
    response = await send(url, { method: "POST", headers, body: JSON.stringify(payload), redirect: "manual", signal: AbortSignal.timeout(8000) });
  } catch {
    return { action: "retry", reason: "network_error", delay: retryDelay(null, attempt) };
  }
  await response.body?.cancel().catch(() => {});
  if (response.ok) return { action: "ack", status: response.status };
  if (response.status === 429 || response.status === 408 || response.status >= 500) {
    return { action: "retry", status: response.status, delay: retryDelay(response.headers.get("retry-after"), attempt) };
  }
  return { action: "fail", status: response.status, reason: "destination_rejected" };
}
