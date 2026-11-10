import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaults } from "../lib/settings.mjs";
import { install, preflight } from "../setup/install.mjs";
import { setupServer } from "../setup/server.mjs";

const settings = { ...defaults, accountId: "1".repeat(32) };
const credentials = { token: "example-token-only-for-tests", webhook: "https://discord.com/api/webhooks/123/example" };

test("installation resumes after a failure and leaves credentials out of project files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "notifier-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const queues = new Map();
  const subs = [];
  const workers = new Set(["checkout-api"]);
  const client = {
    worker: async (name) => workers.has(name) ? {} : null,
    queue: async (name) => queues.get(name),
    createQueue: async (name) => {
      assert.ok(!queues.has(name));
      const queue = { queue_id: name, queue_name: name, consumers: [] };
      queues.set(name, queue);
      return queue;
    },
    subscriptions: async () => subs,
    createSubscription: async (queueId, worker, events) => {
      subs.push({ id: "1", enabled: true, name: `notifier-${worker}`, source: { type: "workersBuilds.worker", worker_name: worker }, destination: { queue_id: queueId }, events });
    },
    updateSubscription: async () => { assert.fail("This fixture should not need a subscription update"); },
  };
  await assert.rejects(install(settings, credentials, { directory, client, deploy: async () => { throw new Error("simulated deploy failure"); } }), /simulated deploy failure/);
  let secretPath;
  const deploy = async (configFile, secretFile) => {
    const config = JSON.parse(await readFile(configFile, "utf8"));
    assert.equal(config.workers_dev, false);
    assert.equal(config.queues.consumers[0].dead_letter_queue, "cloudflare-notifier-failed");
    assert.ok(!JSON.stringify(config).includes(credentials.webhook));
    workers.add(config.name);
    queues.get("cloudflare-notifier-events").consumers = [{ type: "worker", script_name: config.name }];
    secretPath = secretFile;
    assert.equal(JSON.parse(await readFile(secretFile, "utf8")).WEBHOOK_URL, credentials.webhook);
  };
  await install(settings, credentials, { directory, client, deploy });
  await install(settings, credentials, { directory, client, deploy });
  assert.equal(queues.size, 2);
  assert.equal(subs.length, 1);
  assert.equal((await preflight(settings, credentials, { directory, client })).ready, true);
  await assert.rejects(readFile(secretPath), { code: "ENOENT" });
});

test("demo mode cannot call an installer and cross-origin requests are denied", async (t) => {
  const server = setupServer({ demo: true, installer: {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const send = (path, requestOrigin) => fetch(origin + path, {
    method: "POST", headers: { "content-type": "application/json", origin: requestOrigin },
    body: JSON.stringify({ settings }),
  });
  assert.equal((await send("/api/install", "https://example.com")).status, 403);
  const response = await send("/api/install", origin);
  assert.equal(JSON.parse((await response.text()).trim()).result.demo, true);
  assert.equal((await (await send("/api/test", origin)).json()).demo, true);
});
