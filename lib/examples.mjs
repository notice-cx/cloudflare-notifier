import { normalizeEvent } from "./notifications.mjs";

export function example(type, worker, branch) {
  const occurredAt = "2026-11-10T18:42:00Z";
  const accountId = "11111111111111111111111111111111";
  if (type.startsWith("build.")) {
    return normalizeEvent({
      type: `cf.workersBuilds.worker.${type}`,
      source: { workerName: worker },
      metadata: { accountId, eventTimestamp: occurredAt },
      payload: {
        buildUuid: "example-build",
        runningAt: "2026-11-10T18:40:18Z",
        stoppedAt: type === "build.started" ? undefined : occurredAt,
        buildTriggerMetadata: { branch, commitMessage: "Add receipt emails", commitHash: "a8f29d13c6b1", providerType: "github", providerAccountName: "example", repoName: worker },
      },
    }, accountId);
  }
  const details = {
    "deployment.succeeded": { summary: "Deployment confirmed by CI", deploymentId: "91ed0c2", url: "https://checkout.example.com/" },
    "deployment.failed": { summary: "The deployment command returned an error" },
    "runtime.exception": { summary: "TypeError", outcome: "exception" },
    "runtime.limit": { outcome: "exceededCpu" },
    "runtime.http": { status: 503 },
    "scheduled.failed": { job: "Invoice sync", schedule: "0 9 * * *", summary: "Scheduled job returned an error" },
  };
  return normalizeEvent({
    type, source: type.startsWith("runtime.") ? "notifier.runtime" : "notifier.report",
    worker, branch, occurredAt, ...details[type],
  }, accountId);
}
