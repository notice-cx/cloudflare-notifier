import { parseArgs } from "node:util";
import { parseReport } from "../lib/notifications.mjs";

try {
  const { positionals: [type, worker], values } = parseArgs({
    allowPositionals: true,
    options: {
      branch: { type: "string" }, "deployment-id": { type: "string" },
      url: { type: "string" }, summary: { type: "string" },
      job: { type: "string" }, schedule: { type: "string" },
    },
  });
  const report = parseReport({ type, worker, ...values, deploymentId: values["deployment-id"] });
  if (!report) throw new Error("Provide a supported event and Worker name. Deployment success needs --deployment-id. Scheduled failure needs --job and --schedule.");
  const token = process.env.NOTIFIER_REPORT_TOKEN;
  if (!token) throw new Error("Set NOTIFIER_REPORT_TOKEN in your environment.");
  const url = new URL(process.env.NOTIFIER_REPORT_URL ?? "https://invalid.example/");
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/events") {
    throw new Error("Set NOTIFIER_REPORT_URL to the HTTPS /events address from Setup.");
  }
  const response = await fetch(url, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(report),
  });
  if (response.status !== 202) throw new Error(`The notifier rejected this report (HTTP ${response.status}). Check the reporting token and notification rules.`);
  console.log("Event queued.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
