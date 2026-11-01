// SPDX-License-Identifier: Apache-2.0
// The Node stand-in for the Worker's `ratelimits` binding (wrangler.jsonc): a fixed window per
// key, in this process's memory. One process serves a self-hosted deployment, so it sees every
// request; a restart forgets the counts, which only ever lets more through.

/** As `simple` in wrangler.jsonc. */
export function memoryRateLimit(limit: number, periodMs: number) {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    async limit({ key }: { key: string }) {
      const now = Date.now();
      // Expired windows are dropped as the map grows, so unique keys can't fill memory.
      if (windows.size > 10_000) {
        for (const [k, w] of windows) if (now - w.start >= periodMs) windows.delete(k);
      }
      let w = windows.get(key);
      if (!w || now - w.start >= periodMs) {
        w = { start: now, count: 0 };
        windows.set(key, w);
      }
      w.count++;
      return { success: w.count <= limit };
    },
  };
}
