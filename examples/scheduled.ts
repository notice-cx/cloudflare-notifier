// Add a Queue producer binding named NOTIFIER_EVENTS to the scheduled Worker.
// Point it at the notifier's event queue and enable "Scheduled run failed" in its rule.
export async function reportScheduledFailure(
  queue: Queue,
  controller: ScheduledController,
  worker: string,
  job: string,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    try {
      await queue.send({
        source: "notifier.report",
        type: "scheduled.failed",
        worker,
        job,
        schedule: controller.cron,
        occurredAt: new Date(controller.scheduledTime).toISOString(),
        summary: "The scheduled job failed. Open the Worker logs for details.",
      });
    } catch {
      console.error("Could not queue the scheduled failure notification.");
    }
    throw error;
  }
}
