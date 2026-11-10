import { defaults, events } from "/lib/settings.mjs";
import { example } from "/lib/examples.mjs";
import { matchingRule, messageFor, parseWebhookBody, payloadFor } from "/lib/notifications.mjs";

const $ = (id) => document.getElementById(id);
const destinationNames = { discord: "Discord", slack: "Slack", webhook: "Custom webhook" };
const formats = { discord: "Discord embed", slack: "Slack Block Kit", webhook: "Structured JSON" };
const help = {
  discord: "In Discord, open your server’s settings, then Integrations → Webhooks. Create a webhook and copy its URL.",
  slack: "Enable Incoming Webhooks in your Slack app. Add a webhook for the channel and copy its URL.",
  webhook: "Enter the HTTPS endpoint that should receive the JSON event.",
};

let settings = structuredClone(defaults);
let demo = false;
let activeRule = 0;
let installing = false;

function element(tag, content, className) {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  if (className) node.className = className;
  return node;
}

function notice(text, error = false) {
  $("notice").textContent = text;
  $("notice").hidden = !text;
  $("notice").classList.toggle("error", error);
}

function currentSettings() {
  return {
    ...settings, name: $("install-name").value.trim(), accountId: $("account").value.trim().toLowerCase(),
    reportEndpoint: $("report").checked, style: $("style").value,
    role: settings.destination === "discord" ? $("role").value.trim() : "",
  };
}

function requestData(includeSecrets) {
  return {
    settings: currentSettings(),
    ...(includeSecrets ? { secrets: {
      token: $("token").value, webhook: $("webhook").value,
      headers: $("headers").value, body: $("webhook-body").value, reportToken: $("report-token").value,
    } } : {}),
  };
}

async function api(path) {
  const data = requestData(false);
  if (path !== "plan") data.secrets = { token: $("token").value };
  const response = await fetch("/api/" + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error);
  return body;
}

function field(label, value, placeholder, change) {
  const node = element("label", label);
  const input = element("input");
  input.value = value;
  input.placeholder = placeholder;
  input.autocomplete = "off";
  input.addEventListener("input", () => { change(input.value); renderPreview(); });
  node.append(input);
  return node;
}

function renderRules() {
  $("rule-list").replaceChildren(...settings.rules.map((rule, index) => {
    const container = element("section", undefined, "panel rule");
    const head = element("div", undefined, "rule-top");
    head.append(element("h3", `Rule ${index + 1}`));
    if (settings.rules.length > 1) {
      const remove = element("button", "Remove", "button subtle");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove rule ${index + 1}`);
      remove.onclick = () => {
        settings.rules.splice(index, 1);
        activeRule = Math.min(activeRule, settings.rules.length - 1);
        renderRules();
        renderPreview();
      };
      head.append(remove);
    }
    const pair = element("div", undefined, "pair");
    pair.append(
      field("Worker name", rule.worker, "checkout-api", (value) => { rule.worker = value.trim(); activeRule = index; }),
      field("Environment label", rule.environment, "Production", (value) => { rule.environment = value; activeRule = index; }),
    );
    const controls = element("div", undefined, "rule-controls");
    controls.append(pair, field("Branch filter for builds and deploys", rule.branch, "All branches", (value) => { rule.branch = value.trim(); activeRule = index; }));
    const groups = element("div", undefined, "event-groups");
    for (const [label, pattern] of [["Builds and deploys", /^(build|deployment)\./], ["Runtime and jobs", /^(runtime|scheduled)\./]]) {
      const fieldset = element("fieldset");
      fieldset.append(element("legend", label));
      for (const [type, name] of Object.entries(events).filter(([type]) => pattern.test(type))) {
        const choice = element("label", undefined, "choice");
        const input = element("input");
        input.type = "checkbox";
        input.checked = rule.events.includes(type);
        input.onchange = () => {
          rule.events = input.checked ? [...rule.events, type] : rule.events.filter((value) => value !== type);
          activeRule = index;
          $("scenario").value = type;
          renderPreview();
        };
        choice.append(input, element("span", name));
        fieldset.append(choice);
      }
      groups.append(fieldset);
    }
    controls.append(groups);
    container.append(head, controls);
    return container;
  }));
  $("add-rule").disabled = settings.rules.length >= 20;
}

function renderPreview() {
  const active = settings.rules[activeRule];
  const type = $("scenario").value || "build.failed";
  const config = currentSettings();
  const event = example(type, active.worker || "checkout-api", active.branch || "main");
  const rule = matchingRule(config, event);
  const message = messageFor(config, event, rule ?? active);
  const container = $("preview");
  $("format").textContent = formats[config.destination];
  $("rule-status").classList.toggle("positive", Boolean(rule));
  $("rule-status").textContent = rule ? "Included by your rules" : "Filtered by your rules";
  if (config.destination === "webhook") {
    try {
      const template = parseWebhookBody($("webhook-body").value);
      const payload = payloadFor(config, event, rule ?? active, "example-delivery", template);
      container.replaceChildren(element("pre", JSON.stringify(payload, null, 2)));
    } catch { container.replaceChildren(element("p", "Check the custom JSON body in Setup review.", "caption")); }
    return;
  }
  const chat = element("div", undefined, "chat");
  chat.append(element("div", "# notifications", "channel"));
  const sender = element("div", undefined, "sender");
  sender.append(element("span", "↟", "avatar"), element("strong", "Cloudflare Notifier"), element("span", "APP", "tag"));
  chat.append(sender);
  const card = element("div", undefined, `message ${message.tone} ${config.destination}`);
  card.append(element("h3", message.title));
  if (message.role) card.append(element("p", `@Role ${message.role}`, "message-links"));
  if (message.summary) card.append(element("p", message.summary, "summary"));
  if (message.fields.length) {
    const details = element("dl", undefined, "details");
    for (const [label, value] of message.fields) {
      const group = element("div");
      group.append(element("dt", label), element("dd", value));
      details.append(group);
    }
    card.append(details);
  }
  if (message.links.length) card.append(element("p", message.links.map(([label]) => label + " ↗").join("  ·  "), "message-links"));
  chat.append(card);
  container.replaceChildren(chat);
}

function updateDestination() {
  document.querySelectorAll("[data-destination]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.destination === settings.destination));
  });
  $("webhook-help").textContent = help[settings.destination];
  $("headers-field").hidden = settings.destination !== "webhook";
  $("body-field").hidden = settings.destination !== "webhook";
  $("role-field").hidden = settings.destination !== "discord";
  renderPreview();
}

function checklist(items) {
  const list = element("ul", undefined, "steps");
  for (const { title, detail } of items) {
    const row = element("li");
    row.append(element("strong", title), element("small", detail));
    list.append(row);
  }
  return list;
}

function renderPlan(plan) {
  const target = $("plan");
  target.replaceChildren(checklist(plan.steps));
  if (plan.runtime.length) {
    target.append(element("p", "Runtime alerts require Workers Paid. After installation, add this entry to the existing tail_consumers list in each selected Worker’s Wrangler configuration and deploy that Worker.", "caption"));
    target.append(element("pre", JSON.stringify({ tail_consumers: [{ service: plan.resources.tail }] }, null, 2)));
  }
  const needsReport = settings.rules.some((rule) => rule.events.some((event) => /^(scheduled|deployment)\./.test(event)));
  if (needsReport && !currentSettings().reportEndpoint) {
    target.append(element("p", "Deployment and scheduled job reports need a queue producer or the HTTPS reporting endpoint.", "caption"));
  }
}

async function refreshPlan() {
  try { renderPlan(await api("plan")); }
  catch (error) { $("plan").replaceChildren(element("p", error.message, "caption")); }
}

function navigate(page, keepNotice = false) {
  if (!keepNotice) notice("");
  document.querySelectorAll(".page").forEach((view) => { view.hidden = view.id !== page; });
  document.querySelectorAll("[data-page]").forEach((button) => {
    if (button.dataset.page === page) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  window.scrollTo(0, 0);
  if (page === "review") void refreshPlan();
}

function renderDiagnostics(result) {
  const items = result.demo ? [
    { title: "Configuration", detail: "Rules validated with sample data." },
    { title: "Event queue", detail: "The installed Worker would consume events from this queue." },
  ] : [
    { title: "Notification Worker", detail: result.ready ? "Connected to the event queue." : "Run setup to deploy and connect the Worker." },
    { title: "Failed-delivery queue", detail: result.failureQueue ? "Available in Cloudflare." : "Run setup to create the queue." },
    ...result.runtime.map(({ worker, connected }) => ({ title: worker, detail: connected ? "Runtime collector connected." : "Add the runtime collector to this Worker’s Wrangler configuration." })),
  ];
  $("checks").replaceChildren(checklist(items));
  $("dashboard-links").replaceChildren();
  for (const [label, url] of [["Open Worker", result.dashboard], ["Open Queues", result.queues]]) {
    if (!url) continue;
    const anchor = element("a", label + " ↗", "button subtle");
    anchor.href = url;
    anchor.target = "_blank";
    anchor.rel = "noreferrer";
    $("dashboard-links").append(anchor);
  }
  showReportUrl(result.reportUrl);
}

function showReportUrl(url) {
  $("report-url").replaceChildren();
  if (url) $("report-url").append(element("p", "Reporting endpoint", "caption"), element("pre", url));
}

async function runButton(button, action) {
  button.disabled = true;
  notice("");
  try { await action(); }
  catch (error) { notice(error.message, true); }
  finally { button.disabled = false; }
}

async function runInstall(event) {
  event.preventDefault();
  if (installing) return;
  installing = true;
  const button = event.submitter;
  await runButton(button, async () => {
    notice(demo ? "Checking the example setup…" : "Starting installation…");
    const response = await fetch("/api/install", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestData(true)),
    });
    if (!response.ok) throw new Error((await response.json()).error);
    let pending = "";
    let completed;
    for await (const part of response.body.pipeThrough(new TextDecoderStream())) {
      pending += part;
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines.filter(Boolean)) {
        const update = JSON.parse(line);
        if (update.error) throw new Error(update.error);
        if (update.step) notice(update.step);
        if (update.result) completed = update.result;
      }
    }
    if (!completed) throw new Error("The installer disconnected. Check the installation before trying again.");
    $("webhook").value = "";
    $("headers").value = "";
    $("webhook-body").value = "";
    showReportUrl(completed.reportUrl);
    navigate("diagnostics", true);
    notice(demo ? "Sample installation complete. You can try the diagnostic controls below." : "Notifier installed. Send a test message to verify the destination.");
  });
  installing = false;
}

async function start() {
  const response = await fetch("/api/start");
  if (!response.ok) throw new Error("Could not load the installer.");
  ({ settings, demo } = await response.json());
  $("install-name").value = settings.name;
  $("account").value = settings.accountId;
  $("style").value = settings.style;
  $("role").value = settings.role;
  $("report").checked = settings.reportEndpoint;
  $("report-field").hidden = !settings.reportEndpoint;
  $("report-token").required = settings.reportEndpoint && !demo;
  $("scenario").replaceChildren(...Object.entries(events).map(([key, label]) => new Option(label, key)));
  $("scenario").value = "build.failed";
  if (demo) {
    $("mode").textContent = "Demo · sample data";
    $("account").value = "11111111111111111111111111111111";
    $("token").value = "demo-token";
    $("webhook").value = "https://discord.com/api/webhooks/123/example";
    settings.rules[0].branch = "main";
    $("check-details").textContent = "Try the installation checks and a test message with sample data.";
  }
  renderRules();
  updateDestination();
}

document.querySelectorAll("[data-page]").forEach((button) => { button.onclick = () => navigate(button.dataset.page); });
document.querySelectorAll("[data-destination]").forEach((button) => {
  button.onclick = () => { settings.destination = button.dataset.destination; updateDestination(); };
});
$("add-rule").onclick = () => {
  settings.rules.push({ worker: "", branch: "", environment: "", events: ["build.failed"] });
  activeRule = settings.rules.length - 1;
  renderRules();
  $("rule-list").lastElementChild.querySelector("input").focus();
  renderPreview();
};
for (const id of ["style", "role", "scenario"]) $(id).addEventListener("input", renderPreview);
$("webhook-body").addEventListener("input", renderPreview);
for (const id of ["install-name", "account"]) $(id).addEventListener("change", refreshPlan);
$("report").onchange = () => {
  $("report-field").hidden = !$("report").checked;
  $("report-token").required = $("report").checked && !demo;
  void refreshPlan();
};
$("generate-token").onclick = () => {
  $("report-token").value = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  $("report-token").type = "text";
  $("report-token").select();
  notice("Copy the generated token to your CI or scheduled job secrets.");
};
$("review-button").onclick = () => navigate("review");
$("installation").onsubmit = runInstall;
$("preflight").onclick = (event) => runButton(event.currentTarget, async () => {
  const result = await api("check");
  renderPlan(result.plan);
  notice(result.demo ? "Sample account check passed." : "Cloudflare account and resource checks passed.");
});
$("check").onclick = (event) => runButton(event.currentTarget, async () => {
  renderDiagnostics(await api("check"));
  notice("Installation check complete.");
});
$("test").onclick = (event) => runButton(event.currentTarget, async () => {
  const result = await api("test");
  notice(result.demo ? "Sample test completed." : "Test queued. Check your channel or endpoint for the message.");
});

start().catch((error) => notice(error.message, true));
