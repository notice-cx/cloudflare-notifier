import { execFile } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildSubscriptions, parseHeaders, parseSettings, parseWebhook, runtimeWorkers } from "../lib/settings.mjs";
import { parseWebhookBody } from "../lib/notifications.mjs";
import { cloudflare } from "./cloudflare.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const exec = promisify(execFile);

function names(settings) {
  const { name } = settings;
  return { worker: name, tail: `${name}-tail`, events: `${name}-events`, failed: `${name}-failed` };
}

export function planFor(settings) {
  const resources = names(settings);
  const subscriptions = [...buildSubscriptions(settings)].map(([worker, events]) => ({ worker, events }));
  const runtime = runtimeWorkers(settings);
  return {
    resources,
    subscriptions,
    runtime,
    steps: [
      { title: "Create or reuse the queues", detail: `${resources.events} and ${resources.failed}` },
      { title: "Deploy the notifier and save destination credentials", detail: resources.worker },
      ...(subscriptions.length ? [{ title: "Connect Workers Builds", detail: subscriptions.map(({ worker }) => worker).join(", ") }] : []),
      ...(runtime.length ? [{ title: "Deploy the runtime collector", detail: resources.tail }] : []),
      ...(settings.reportEndpoint ? [{ title: "Enable the authenticated reporting endpoint", detail: "POST /events on the notifier Worker" }] : []),
    ],
  };
}

function credentialsFor(settings, input, deploy) {
  if (!settings.accountId) throw new Error("Enter the Cloudflare account ID.");
  const token = String(input?.token ?? "").trim();
  if (!/^[\w-]{20,200}$/.test(token)) throw new Error("Enter an account-scoped Cloudflare API token.");
  if (!deploy) return { token };
  const webhook = parseWebhook(input.webhook, settings.destination).href;
  const headers = settings.destination === "webhook" ? input.headers || "{}" : "{}";
  try { parseHeaders(JSON.parse(headers)); } catch { throw new Error("Enter valid webhook headers as JSON."); }
  const body = settings.destination === "webhook" ? input.body || "null" : "null";
  try { parseWebhookBody(body); } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Enter valid JSON for the custom webhook body.");
    throw error;
  }
  const reportToken = String(input.reportToken ?? "").trim();
  if (settings.reportEndpoint && !/^[\w-]{32,256}$/.test(reportToken)) throw new Error("Use a reporting token of at least 32 letters, digits, underscores, or hyphens.");
  return { token, webhook, headers, body, reportToken };
}

function localDir(settings, directory = process.cwd()) {
  return join(directory, ".notifier", settings.name);
}

async function readState(dir) {
  try { return JSON.parse(await readFile(join(dir, "installation.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function savedSettings(name = "cloudflare-notifier", directory = process.cwd()) {
  if (!/^[a-z0-9-]{1,41}$/.test(name)) return null;
  try { return parseSettings(JSON.parse(await readFile(join(directory, ".notifier", name, "settings.json"), "utf8"))); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function inspect(settings, client, dir) {
  const plan = planFor(settings);
  const { resources } = plan;
  const selected = [...new Set(settings.rules.map(({ worker }) => worker))];
  const [journal, worker, tail, events, failed, subdomain, monitored] = await Promise.all([
    readState(dir),
    client.worker(resources.worker), client.worker(resources.tail),
    client.queue(resources.events), client.queue(resources.failed),
    settings.reportEndpoint ? client.subdomain() : "",
    Promise.all(selected.map(async (name) => ({ name, settings: await client.worker(name) }))),
  ]);
  if (journal && journal.accountId !== settings.accountId) {
    throw new Error("This local installation belongs to another account. Choose a new installation name.");
  }
  if (!journal && (worker || tail || events || failed)) {
    throw new Error("A Worker or queue already uses this installation name. Choose a new name or run setup from the original installation directory.");
  }
  if (events?.consumers?.some((consumer) => consumer.type !== "worker" || consumer.script_name !== resources.worker) || failed?.consumers_total_count > 0) {
    throw new Error("One of the queues has a consumer outside this installation. Review its connections in Cloudflare.");
  }
  const missing = monitored.filter((item) => !item.settings).map(({ name }) => name);
  if (missing.length) throw new Error(`Worker not found in this account: ${missing.join(", ")}.`);
  if (settings.reportEndpoint && !subdomain) throw new Error("Set up a workers.dev subdomain in Cloudflare before enabling the reporting endpoint.");
  const subscriptions = events ? await client.subscriptions(events.queue_id) : [];
  return { plan, worker, events, failed, tail, subdomain, subscriptions, monitored };
}

export async function preflight(input, secrets, options = {}) {
  const settings = parseSettings(input);
  const { token } = credentialsFor(settings, secrets, false);
  const client = options.client ?? cloudflare(settings.accountId, token);
  const snapshot = await inspect(settings, client, localDir(settings, options.directory));
  return diagnostics(settings, snapshot);
}

function diagnostics(settings, snapshot) {
  const { plan, worker, events, failed, tail, subdomain, monitored } = snapshot;
  const { resources } = plan;
  const ready = Boolean(worker && events?.consumers?.some((consumer) => consumer.script_name === resources.worker));
  return {
    plan,
    ready,
    queue: Boolean(events),
    failureQueue: Boolean(failed),
    tail: Boolean(tail),
    runtime: plan.runtime.map((worker) => ({
      worker,
      connected: Boolean(monitored.find(({ name }) => name === worker)?.settings?.tail_consumers?.some(({ service }) => service === resources.tail)),
    })),
    reportUrl: settings.reportEndpoint && subdomain ? `https://${resources.worker}.${subdomain}.workers.dev/events` : "",
    dashboard: `https://dash.cloudflare.com/${settings.accountId}/workers/services/view/${resources.worker}/production`,
    queues: `https://dash.cloudflare.com/${settings.accountId}/workers/queues`,
  };
}

async function deployWorker(configFile, secretFile, token, accountId) {
  const args = [join(root, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--config", configFile];
  if (secretFile) args.push("--secrets-file", secretFile);
  try {
    await exec(process.execPath, args, {
      cwd: root,
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
        CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId,
        WRANGLER_SEND_METRICS: "false", CI: "true",
      },
      timeout: 180000,
    });
  } catch (error) {
    const code = String(error.stderr ?? "").match(/\[code:\s*(\d+)\]/i)?.[1];
    throw new Error(`Wrangler could not deploy the Worker${code ? ` (Cloudflare code ${code})` : ""}. Check Workers Scripts edit access and account plan. If you enabled runtime alerts, check that Workers Paid is active.`);
  }
}

async function writeConfig(dir, settings, resources, isTail) {
  const template = isTail ? "wrangler.tail.jsonc" : "wrangler.jsonc";
  const config = JSON.parse(await readFile(join(root, template), "utf8"));
  delete config.$schema;
  config.name = isTail ? resources.tail : resources.worker;
  config.main = join(root, config.main);
  config.account_id = settings.accountId;
  config.vars.NOTIFIER_SETTINGS = JSON.stringify(settings);
  for (const producer of config.queues.producers) {
    producer.queue = producer.binding === "FAILED" ? resources.failed : resources.events;
  }
  if (!isTail) {
    config.workers_dev = settings.reportEndpoint;
    const [consumer] = config.queues.consumers;
    consumer.queue = resources.events;
    consumer.dead_letter_queue = resources.failed;
  }
  const configFile = join(dir, template);
  await writeFile(configFile, JSON.stringify(config, null, 2));
  return configFile;
}

async function syncSubscriptions(client, queueId, desired, existing) {
  const owned = existing.filter(({ source, name, destination }) =>
    destination?.queue_id === queueId &&
    source?.type === "workersBuilds.worker" && name === `notifier-${source.worker_name}`);
  for (const { worker, events } of desired) {
    const matching = owned.filter(({ source }) => source.worker_name === worker);
    if (!matching.length) {
      await client.createSubscription(queueId, worker, events);
      continue;
    }
    const [current, ...duplicates] = matching;
    const currentTypes = current.events.map((event) => event.replace(/^cf\.workersBuilds\.worker\./, "")).sort();
    if (!current.enabled || currentTypes.join(",") !== events.join(",")) {
      await client.updateSubscription(current.id, { events, enabled: true });
    }
    for (const duplicate of duplicates.filter(({ enabled }) => enabled)) {
      await client.updateSubscription(duplicate.id, { enabled: false });
    }
  }
  for (const old of owned.filter(({ enabled, source }) => enabled && !desired.some(({ worker }) => worker === source.worker_name))) {
    await client.updateSubscription(old.id, { enabled: false });
  }
}

export async function install(input, secrets, { directory, client: injected, deploy = deployWorker, progress = () => {} } = {}) {
  const settings = parseSettings(input);
  const creds = credentialsFor(settings, secrets, true);
  const client = injected ?? cloudflare(settings.accountId, creds.token);
  const dir = localDir(settings, directory);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let lock;
  try { lock = await open(join(dir, "install.lock"), "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("This installation is already running. If the installer was stopped, remove its install.lock file and retry.");
    throw error;
  }
  let temp;
  try {
    progress("Checking account, Workers, and queue names…");
    const snapshot = await inspect(settings, client, dir);
    const { plan } = snapshot;
    const { resources } = plan;
    await writeFile(join(dir, "installation.tmp"), JSON.stringify({ accountId: settings.accountId }), { mode: 0o600 });
    await rename(join(dir, "installation.tmp"), join(dir, "installation.json"));
    await writeFile(join(dir, "settings.json"), JSON.stringify(settings, null, 2), { mode: 0o600 });
    progress("Preparing the event and failed-delivery queues…");
    const queue = snapshot.events ?? await client.createQueue(resources.events);
    if (!snapshot.failed) await client.createQueue(resources.failed);
    progress("Deploying the notification Worker…");
    const config = await writeConfig(dir, settings, resources, false);
    temp = await mkdtemp(join(tmpdir(), "cloudflare-notifier-"));
    const secretFile = join(temp, "secrets.json");
    await writeFile(secretFile, JSON.stringify({
      WEBHOOK_URL: creds.webhook,
      WEBHOOK_HEADERS: creds.headers,
      WEBHOOK_BODY: creds.body,
      ...(settings.reportEndpoint ? { REPORT_TOKEN: creds.reportToken } : {}),
    }), { mode: 0o600 });
    await deploy(config, secretFile, creds.token, settings.accountId);
    if (plan.runtime.length) {
      progress("Deploying the runtime collector…");
      const tailConfig = await writeConfig(dir, settings, resources, true);
      await deploy(tailConfig, null, creds.token, settings.accountId);
    }
    if (plan.subscriptions.length || snapshot.subscriptions.length) {
      progress("Connecting build event subscriptions…");
      await syncSubscriptions(client, queue.queue_id, plan.subscriptions, snapshot.subscriptions);
    }
    return { plan, reportUrl: snapshot.subdomain ? `https://${resources.worker}.${snapshot.subdomain}.workers.dev/events` : "" };
  } finally {
    if (temp) await rm(temp, { recursive: true, force: true });
    await lock.close();
    await rm(join(dir, "install.lock"), { force: true });
  }
}

export async function testDestination(input, secrets, options = {}) {
  const settings = parseSettings(input);
  const { token } = credentialsFor(settings, secrets, false);
  const client = options.client ?? cloudflare(settings.accountId, token);
  const snapshot = await inspect(settings, client, localDir(settings, options.directory));
  if (!diagnostics(settings, snapshot).ready) throw new Error("Install the notifier before sending a test.");
  await client.test(snapshot.events.queue_id);
}
