// SPDX-License-Identifier: Apache-2.0
// The offline shell (M3-24 AC2; m3-ux §3.13). It keeps the app's page and its hashed scripts and
// styles, so an installed app opens with no network and says it's offline. It never answers for
// /api, the chat socket, /setup or /hooks: no account data is kept on the device, so signing out
// leaves nothing behind. No push.
const SHELL = "opa-shell-v1";
const PAGE = "/";
const PASS_THROUGH = /^\/(api|agents|setup|hooks)(\/|$)/;

// Shell updates run one at a time, in the order they were asked for. Two navigations across
// a deploy can name different hashed files; if their updates interleaved, one could store its
// page and the other then prune that page's files as unwanted, and the next offline launch
// would open a page whose script is gone. Within one update the page and its files always
// agree, so serial updates keep them agreeing.
let shellUpdate = Promise.resolve();
function keep(page) {
  const run = shellUpdate.then(() => keepNow(page));
  // A failed update must not jam the queue behind it.
  shellUpdate = run.catch(() => {});
  return run;
}

/** Caches the page and the files it names, and drops files an older page named. */
async function keepNow(page) {
  const html = await page.clone().text();
  const files = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
  const cache = await caches.open(SHELL);
  await cache.addAll(files);
  await cache.put(PAGE, page);
  const wanted = new Set(files.map((f) => new URL(f, self.location.origin).href));
  for (const req of await cache.keys()) {
    const { pathname } = new URL(req.url);
    if (pathname.startsWith("/assets/") && !wanted.has(req.url)) await cache.delete(req);
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    fetch(PAGE, { cache: "no-store" })
      .then((page) => page.ok && keep(page))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== SHELL).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (PASS_THROUGH.test(url.pathname)) return;
  if (request.mode === "navigate") {
    // The network first, so a deploy shows at once; the kept page only when it's unreachable.
    event.respondWith(
      fetch(request).then(
        (page) => {
          const html = page.headers.get("content-type")?.startsWith("text/html");
          if (page.ok && html) event.waitUntil(keep(page.clone()).catch(() => {}));
          return page;
        },
        () => caches.match(PAGE).then((kept) => kept ?? Response.error()),
      ),
    );
    return;
  }
  // Hashed names never change content, so a kept copy is always right, whatever `Vary` says
  // (the page asks with an Origin header the install step didn't send).
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(request, { ignoreVary: true }).then((kept) => kept ?? fetch(request)),
    );
  }
});
