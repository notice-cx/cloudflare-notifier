import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { parseSettings } from "../lib/settings.mjs";
import { install, planFor, preflight, testDestination } from "./install.mjs";

try {
  const { positionals: [action, path = "notifier.local.json"], values } = parseArgs({
    allowPositionals: true, options: { apply: { type: "boolean" } },
  });
  const settings = parseSettings(JSON.parse(await readFile(path, "utf8")));
  const secrets = {
    token: process.env.CLOUDFLARE_API_TOKEN,
    webhook: process.env.NOTIFIER_WEBHOOK_URL,
    headers: process.env.NOTIFIER_WEBHOOK_HEADERS,
    body: process.env.NOTIFIER_WEBHOOK_BODY,
    reportToken: process.env.NOTIFIER_REPORT_TOKEN,
  };
  switch (action) {
    case "plan":
      console.log(JSON.stringify(planFor(settings), null, 2));
      break;
    case "check":
      console.log(JSON.stringify(await preflight(settings, secrets), null, 2));
      break;
    case "install":
      if (!values.apply) throw new Error("Review the plan first. Add --apply to deploy to the selected Cloudflare account.");
      console.log(JSON.stringify(await install(settings, secrets, { progress: (step) => console.error(step) }), null, 2));
      break;
    case "test":
      if (!values.apply) throw new Error("Add --apply to queue a test message to the configured destination.");
      await testDestination(settings, secrets);
      console.log("Test queued. Check the configured destination for the message.");
      break;
    default:
      throw new Error("Choose plan, check, install, or test.");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
