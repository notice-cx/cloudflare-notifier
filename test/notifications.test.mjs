import assert from "node:assert/strict";
import { test } from "node:test";
import { example } from "../lib/examples.mjs";
import { deliver, matchingRule, normalizeEvent, parseReport, parseWebhookBody, payloadFor } from "../lib/notifications.mjs";
import { defaults, parseSettings } from "../lib/settings.mjs";
import notifier from "../src/notifier.ts";
import collector from "../src/tail.ts";

const config = parseSettings({
  ...defaults,
  rules: [{ ...defaults.rules[0], branch: "main", events: ["build.failed", "runtime.exception", "scheduled.failed"] }],
});
const webhook = "https://discord.com/api/webhooks/123/example";
const report = { source: "notifier.report", type: "scheduled.failed", worker: "checkout-api", job: "Invoices", schedule: "0 9 * * *" };

test("routes build branches and runtime events and normalizes canceled builds", () => {
  const canceled = normalizeEvent({
    type: "cf.workersBuilds.worker.build.failed", source: { workerName: "checkout-api" },
    payload: { buildOutcome: "canceled" },
  });
  assert.equal(canceled.type, "build.canceled");
  assert.equal(matchingRule(config, example("build.failed", "checkout-api", "preview")), undefined);
  assert.equal(matchingRule(config, example("build.failed", "checkout-api", "main"))?.environment, "Production");
  assert.equal(matchingRule(config, { worker: "checkout-api", type: "runtime.exception" })?.environment, "Production");
  assert.equal(parseReport({ type: "deployment.succeeded", worker: "checkout-api" }), null);
  assert.equal(parseReport(report).job, "Invoices");
});

test("native payloads escape untrusted markup and custom JSON preserves structured fields", () => {
  const event = { ...example("build.failed", "checkout-api", "main"), summary: "<@everyone> **injected**" };
  const discord = payloadFor(config, event, config.rules[0], "message-1");
  assert.deepEqual(discord.allowed_mentions, { parse: [], roles: [] });
  assert.match(discord.embeds[0].description, /\\\*/);
  const slack = payloadFor({ ...config, destination: "slack" }, event, config.rules[0], "message-1");
  assert.equal(slack.blocks[1].text.type, "plain_text");
  const mapped = payloadFor({ ...config, destination: "webhook" }, event, config.rules[0], "message-1",
    parseWebhookBody('{"text":"{{title}}","details":"{{details}}","id":"{{deliveryId}}"}'));
  assert.equal(mapped.details.Worker, "checkout-api");
  assert.equal(mapped.id, "message-1");
  assert.throws(() => parseWebhookBody('{"text":"{{unknown}}"}'), /Unsupported webhook field/);
});

test("Discord uses the native endpoint and respects Retry-After", async () => {
  const result = await deliver(config, { url: webhook }, { embeds: [] }, 1, async (url, init) => {
    assert.equal(url.searchParams.get("wait"), "true");
    assert.equal(init.redirect, "manual");
    return new Response(null, { status: 429, headers: { "Retry-After": "2.2" } });
  });
  assert.deepEqual(result, { action: "retry", status: 429, delay: 3 });
});

test("queue acknowledges delivered and filtered events and preserves rejected messages", async (t) => {
  const responses = [204, 503, 401];
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: responses.shift() }));
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "error", () => {});
  const outcomes = [];
  const failed = [];
  const item = (id, body) => ({
    id, body, attempts: 1,
    ack: () => outcomes.push([id, "ack"]),
    retry: ({ delaySeconds }) => outcomes.push([id, "retry", delaySeconds]),
  });
  await notifier.queue({ messages: [
    item("filtered", { ...report, worker: "other-worker" }), item("ok", report),
    item("retry", report), item("rejected", report),
  ] }, { NOTIFIER_SETTINGS: JSON.stringify(config), WEBHOOK_URL: webhook, FAILED: { send: async (message) => failed.push(message) } });
  assert.deepEqual(outcomes, [["filtered", "ack"], ["ok", "ack"], ["retry", "retry", 10], ["rejected", "ack"]]);
  assert.deepEqual(failed, [{ event: report, status: 401, reason: "destination_rejected", deliveryId: "rejected" }]);
});

test("tail collector sends selected failures without request or log contents", async () => {
  const messages = [];
  await collector.tail([
    { scriptName: "checkout-api", outcome: "ok", logs: [{ message: ["ignored"] }] },
    { scriptName: "other-worker", outcome: "exception", exceptions: [{ name: "Error" }] },
    { scriptName: "checkout-api", outcome: "exception", exceptions: [{ name: "TypeError", message: "sensitive" }], eventTimestamp: 0 },
  ], { NOTIFIER_SETTINGS: JSON.stringify(config), EVENTS: { sendBatch: async (batch) => messages.push(...batch) } });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].body.summary, "TypeError");
  assert.doesNotMatch(JSON.stringify(messages), /sensitive|ignored/);
});
