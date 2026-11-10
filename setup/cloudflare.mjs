export function cloudflare(accountId, token, send = fetch) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  async function request(path, { method = "GET", body, missing = false } = {}) {
    let response;
    try {
      response = await send(base + path, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body && JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error("Could not reach Cloudflare. Check your connection and try again.");
    }
    if (missing && response.status === 404) return null;
    if ([401, 403].includes(response.status)) {
      throw new Error("Cloudflare denied access. Check the account ID and the token’s Workers Scripts and Queues permissions.");
    }
    let result;
    try { result = await response.json(); } catch { throw new Error(`Cloudflare returned HTTP ${response.status}.`); }
    if (!response.ok || !result.success) {
      const codes = (result.errors ?? []).map(({ code }) => Number(code)).filter(Number.isFinite);
      throw new Error(`Cloudflare returned HTTP ${response.status}${codes.length ? ` (code ${codes.join(", ")})` : ""}.`);
    }
    return result;
  }

  return {
    async worker(name) {
      return (await request(`/workers/scripts/${encodeURIComponent(name)}/settings`, { missing: true }))?.result ?? null;
    },
    async queue(name) {
      const { result } = await request(`/queues?name=${encodeURIComponent(name)}`);
      return result.find((queue) => queue.queue_name === name) ?? null;
    },
    async createQueue(name) {
      return (await request("/queues", { method: "POST", body: { queue_name: name } })).result;
    },
    async subdomain() {
      return (await request("/workers/subdomain", { missing: true }))?.result?.subdomain ?? "";
    },
    async subscriptions(id) {
      const subscriptions = [];
      for (let page = 1; ; page++) {
        const query = new URLSearchParams({ queue_id: id, page: String(page), per_page: "50" });
        const { result, result_info: info } = await request(`/event_subscriptions/subscriptions?${query}`);
        subscriptions.push(...result);
        if (page >= (info?.total_pages ?? page)) return subscriptions;
      }
    },
    async createSubscription(queueId, worker, events) {
      await request("/event_subscriptions/subscriptions", {
        method: "POST",
        body: {
          name: `notifier-${worker}`,
          enabled: true,
          source: { type: "workersBuilds.worker", worker_name: worker },
          destination: { type: "queues.queue", queue_id: queueId },
          events,
        },
      });
    },
    async updateSubscription(id, body) {
      await request(`/event_subscriptions/subscriptions/${encodeURIComponent(id)}`, { method: "PATCH", body });
    },
    async test(queueId) {
      await request(`/queues/${encodeURIComponent(queueId)}/messages`, {
        method: "POST",
        body: { content_type: "json", body: { source: "notifier.test", type: "test", occurredAt: new Date().toISOString() } },
      });
    },
  };
}
