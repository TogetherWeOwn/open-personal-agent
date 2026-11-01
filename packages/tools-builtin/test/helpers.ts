// SPDX-License-Identifier: Apache-2.0
// In-memory ports for the tool tests. The file ports mimic the scoped repository: ids that aren't
// one safe segment throw, and each user's ports see only their own prefix.
import type { BuiltinToolPorts, HistoryHit } from "../src/index";

export const signal = () => new AbortController().signal;

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

/** A fetch port that answers from `handler` and records every URL it was asked for. */
export function fakeFetch(handler: Handler) {
  const asked: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    asked.push(url);
    return handler(url, init);
  }) as typeof fetch;
  return { fetch: fetchImpl, asked };
}

export const page = (body: string, contentType = "text/html; charset=utf-8", status = 200) =>
  new Response(body, { status, headers: { "content-type": contentType } });

export const redirect = (location: string, status = 302) =>
  new Response(null, { status, headers: { location } });

/** Scoped file ports over one shared store, as `forUser(scope)` hands them out. */
export function filePorts(store: Map<string, { content: string; type: string }>, user: string) {
  const key = (id: string) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("invalid id");
    return `u/${user}/files/${id}`;
  };
  let ids = 0;
  return {
    putFile: async (id: string, content: string, type: string) => {
      store.set(key(id), { content, type });
    },
    getFile: async (id: string) => {
      const found = store.get(key(id));
      return found ? { text: async () => found.content } : null;
    },
    newId: () => `art-${++ids}`,
  };
}

/** A full set of ports with fakes, for the registry and loop tests. */
export function fakePorts(over: Partial<BuiltinToolPorts> = {}): BuiltinToolPorts {
  const store = new Map<string, { content: string; type: string }>();
  return {
    fetch: fakeFetch(() => page("<title>Hi</title><p>hello from the web</p>")).fetch,
    ownHosts: [],
    searchHistory: async (): Promise<HistoryHit[]> => [],
    ...filePorts(store, "alice"),
    ...over,
  };
}
