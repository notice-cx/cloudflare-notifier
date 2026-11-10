export const events = Object.freeze({
  "build.started": "Build started",
  "build.succeeded": "Build succeeded",
  "build.failed": "Build failed",
  "build.canceled": "Build canceled",
  "deployment.succeeded": "Deployment completed",
  "deployment.failed": "Deployment failed",
  "runtime.exception": "Uncaught exception",
  "runtime.limit": "Worker limit exceeded",
  "runtime.http": "HTTP 5xx response",
  "scheduled.failed": "Scheduled run failed",
});

const namePattern = /^[a-z0-9](?:[a-z0-9-]{0,39}[a-z0-9])?$/;
const workerPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const types = ["discord", "slack", "webhook"];

export const defaults = {
  name: "cloudflare-notifier",
  accountId: "",
  destination: "discord",
  style: "detailed",
  role: "",
  reportEndpoint: false,
  rules: [{
    worker: "checkout-api",
    branch: "",
    environment: "Production",
    events: ["build.failed", "build.succeeded"],
  }],
};

export function parseSettings(input) {
  if (!input || typeof input !== "object") throw new Error("Enter installation settings.");
  const { name, accountId, destination, style, role = "", reportEndpoint = false, rules } = input;
  if (typeof name !== "string" || !namePattern.test(name)) throw new Error("Use a short installation name with lowercase letters, digits, and hyphens.");
  if (typeof accountId !== "string" || (accountId !== "" && !/^[a-f0-9]{32}$/i.test(accountId))) throw new Error("Enter a 32-character Cloudflare account ID.");
  if (!types.includes(destination)) throw new Error("Choose a destination.");
  if (!["compact", "detailed"].includes(style)) throw new Error("Choose a message style.");
  if (typeof role !== "string" || (role !== "" && (destination !== "discord" || !/^\d{17,20}$/.test(role)))) {
    throw new Error("Enter a Discord role ID to mention on failures.");
  }
  if (typeof reportEndpoint !== "boolean") throw new Error("Choose whether to enable the reporting endpoint.");
  if (!Array.isArray(rules) || rules.length === 0 || rules.length > 20) throw new Error("Add between 1 and 20 notification rules.");
  const validRules = rules.map((rule) => {
    if (typeof rule?.worker !== "string" || !workerPattern.test(rule.worker)) throw new Error("Enter the exact Worker name for each rule.");
    if ([name, name + "-tail"].includes(rule.worker)) throw new Error("Choose a Worker outside this notifier installation.");
    if (typeof rule.branch !== "string" || rule.branch.length > 200) throw new Error("Enter a branch name of up to 200 characters.");
    if (typeof rule.environment !== "string" || rule.environment.length > 40) throw new Error("Use an environment label of up to 40 characters.");
    if (!Array.isArray(rule.events) || !rule.events.length || rule.events.some((event) => !Object.hasOwn(events, event))) {
      throw new Error("Choose at least one supported event for each rule.");
    }
    return { worker: rule.worker, branch: rule.branch, environment: rule.environment, events: [...new Set(rule.events)] };
  });
  const settings = { name, accountId, destination, style, role, reportEndpoint, rules: validRules };
  if (new TextEncoder().encode(JSON.stringify(settings)).length > 4800) throw new Error("Shorten or split this installation’s rules.");
  return settings;
}

export function parseWebhook(raw, destination) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("Enter a valid webhook URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("Use an HTTPS webhook URL without embedded credentials or a fragment.");
  }
  if (destination === "discord" && (url.hostname !== "discord.com" || !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+\/?$/.test(url.pathname) || url.port)) {
    throw new Error("Paste the webhook URL copied from Discord’s channel integrations.");
  }
  if (destination === "slack" && (!["hooks.slack.com", "hooks.slack-gov.com"].includes(url.hostname) || !url.pathname.startsWith("/services/") || url.port)) {
    throw new Error("Paste the incoming webhook URL from your Slack app.");
  }
  return url;
}

export function parseHeaders(input) {
  if (!input || Array.isArray(input) || typeof input !== "object") throw new Error("Enter webhook headers as a JSON object.");
  const headers = new Headers();
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string" || /^(host|content-type|content-length|transfer-encoding|connection)$/i.test(key)) {
      throw new Error("Use text values and leave the request framing headers to the notifier.");
    }
    try { headers.set(key, value); } catch { throw new Error("One of the webhook headers is invalid."); }
  }
  return headers;
}

export function buildSubscriptions(settings) {
  const subscriptions = new Map();
  for (const rule of settings.rules) {
    const selected = rule.events.filter((event) => event.startsWith("build."));
    if (!selected.length) continue;
    const existing = subscriptions.get(rule.worker) ?? [];
    subscriptions.set(rule.worker, [...new Set([...existing, ...selected])].sort());
  }
  return subscriptions;
}

export function runtimeWorkers(settings) {
  return [...new Set(settings.rules.filter((rule) => rule.events.some((event) => event.startsWith("runtime."))).map((rule) => rule.worker))];
}
