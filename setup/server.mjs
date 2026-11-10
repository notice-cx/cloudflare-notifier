import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { defaults, parseSettings } from "../lib/settings.mjs";
import { install, planFor, preflight, savedSettings, testDestination } from "./install.mjs";

const files = {
  "/": ["./web/index.html", "text/html"],
  "/app.mjs": ["./web/app.mjs", "text/javascript"],
  "/style.css": ["./web/style.css", "text/css"],
  "/lib/settings.mjs": ["../lib/settings.mjs", "text/javascript"],
  "/lib/notifications.mjs": ["../lib/notifications.mjs", "text/javascript"],
  "/lib/examples.mjs": ["../lib/examples.mjs", "text/javascript"],
};

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32768) throw new Error("The request is larger than 32 KB.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("Could not read the settings. Reload the installer and try again."); }
}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

export function setupServer({ demo = false, name = "cloudflare-notifier", installer = { preflight, install, testDestination } } = {}) {
  const server = createServer(async (request, response) => {
    const address = server.address();
    const host = `127.0.0.1:${address.port}`;
    const origin = `http://${host}`;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'");
    if (request.headers.host !== host) return json(response, 403, { error: "Open the installer at its local address." });
    if (request.headers["sec-fetch-site"] === "cross-site") return json(response, 403, { error: "Open the installer in its own tab." });
    const path = new URL(request.url, origin).pathname;
    try {
      if (request.method === "GET" && Object.hasOwn(files, path)) {
        const [file, type] = files[path];
        const bytes = await readFile(new URL(file, import.meta.url));
        response.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
        response.end(bytes);
        return;
      }
      if (request.method === "GET" && path === "/api/start") {
        const settings = demo ? defaults : await savedSettings(name) ?? {
          ...defaults, name, rules: [{ ...defaults.rules[0], worker: "" }],
        };
        return json(response, 200, { settings, demo });
      }
      if (request.method !== "POST" || !path.startsWith("/api/")) return json(response, 404, { error: "Page not found." });
      if (request.headers.origin !== origin || request.headers["content-type"] !== "application/json") {
        return json(response, 403, { error: "Send requests from the local installer." });
      }
      const { settings: input, secrets } = await readJson(request);
      const settings = parseSettings(input);
      if (path === "/api/plan") return json(response, 200, planFor(settings));
      if (demo) {
        if (path === "/api/check") return json(response, 200, { demo: true, plan: planFor(settings) });
        if (path === "/api/test") return json(response, 200, { demo: true });
        if (path === "/api/install") {
          response.writeHead(200, { "Content-Type": "application/x-ndjson" });
          response.end(JSON.stringify({ result: { demo: true, plan: planFor(settings) } }) + "\n");
          return;
        }
      }
      if (path === "/api/check") return json(response, 200, await installer.preflight(settings, secrets));
      if (path === "/api/test") {
        await installer.testDestination(settings, secrets);
        return json(response, 200, { queued: true });
      }
      if (path === "/api/install") {
        response.writeHead(200, { "Content-Type": "application/x-ndjson" });
        const write = (value) => response.write(JSON.stringify(value) + "\n");
        try {
          const result = await installer.install(settings, secrets, { progress: (step) => write({ step }) });
          write({ result });
        } catch (error) { write({ error: error.message }); }
        response.end();
        return;
      }
      return json(response, 404, { error: "Page not found." });
    } catch (error) {
      return json(response, 400, { error: error.message });
    }
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: {
    demo: { type: "boolean" }, "no-open": { type: "boolean" }, name: { type: "string" },
  } });
  const server = setupServer({ demo: values.demo, name: values.name });
  server.listen(0, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    console.log(`Cloudflare Notifier setup\n${url}\nPress Ctrl+C to close setup.`);
    if (values["no-open"]) return;
    const command = { darwin: "open", linux: "xdg-open", win32: "explorer.exe" }[process.platform];
    if (!command) return;
    const browser = spawn(command, [url], { stdio: "ignore" });
    browser.on("error", () => {});
    browser.unref();
  });
}
