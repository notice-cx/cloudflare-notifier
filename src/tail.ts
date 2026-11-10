import { matchingRule } from "../lib/notifications.mjs";
import { parseSettings } from "../lib/settings.mjs";

export default {
  async tail(traces, env) {
    const settings = parseSettings(JSON.parse(env.NOTIFIER_SETTINGS));
    const messages = [];
    for (const trace of traces) {
      if (!trace.scriptName) continue;
      const trigger = trace.event;
      const status = trigger && "response" in trigger ? trigger.response?.status : undefined;
      const type =
        trace.outcome === "exceededCpu" || trace.outcome === "exceededMemory" ? "runtime.limit" :
        trace.outcome === "exception" ? "runtime.exception" :
        status !== undefined && status >= 500 && status < 600 ? "runtime.http" : "";
      if (!type) continue;
      const event = {
        source: "notifier.runtime",
        worker: trace.scriptName,
        branch: "",
        type,
        status,
        outcome: trace.outcome,
        summary: trace.exceptions[0]?.name,
        occurredAt: new Date(trace.eventTimestamp ?? Date.now()).toISOString(),
      };
      if (matchingRule(settings, event)) messages.push({ body: event });
    }
    // Only send selected failures and omit console output, request URLs, and headers.
    for (let index = 0; index < messages.length; index += 100) {
      await env.EVENTS.sendBatch(messages.slice(index, index + 100));
    }
  },
} satisfies ExportedHandler<TailEnv>;
