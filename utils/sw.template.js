/* Duka service worker - keeps the app itself (pages, styles, scripts, icons) on the phone,
   so Duka opens instantly and keeps working without internet.
   It NEVER stores shop data: anything under /api/ always goes to the server.
   (Offline sales are kept by the app in IndexedDB, not here.)

   The server fills in __VERSION__ and __PRECACHE__ automatically from the files in /public,
   so there is nothing to update by hand: change a file and the version changes. */
const VERSION = "__VERSION__";
const CACHE = "duka-shell-" + VERSION;
const PRECACHE = __PRECACHE__;
const DEV = ["localhost", "127.0.0.1"].indexOf(self.location.hostname) !== -1;

self.addEventListener("install", (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE);
        // One missing file must not stop the rest from being saved.
        await Promise.allSettled(PRECACHE.map((url) => cache.add(new Request(url, { cache: "reload" }))));
    })());
    // While developing on your own computer, use new files straight away.
    if (DEV) self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names.filter((n) => n.startsWith("duka-shell-") && n !== CACHE).map((n) => caches.delete(n)));
        await self.clients.claim();
    })());
});

// The page asks for "update now" after the person taps the update banner.
self.addEventListener("message", (event) => {
    if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

/** /pos.html and /pos both mean the same page; "/index.html" is "/". Query strings are ignored. */
function pageKey(pathname) {
    let p = pathname.replace(/\.html$/, "");
    if (p === "/index" || p === "") p = "/";
    return p;
}

function offlineAnswer() {
    return new Response(
        "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>" +
        "<title>Offline</title><body style='font-family:sans-serif;padding:2rem'><h1>You are offline</h1>" +
        "<p>This page was not saved on your phone yet. Connect to the internet once, then it will work offline.</p>",
        { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
}

async function handlePage(event, url) {
    const key = pageKey(url.pathname);
    const cache = await caches.open(CACHE);
    const cached = await cache.match(key);

    if (DEV) {
        // On your own computer: always the newest file when online, saved copy when not.
        try { return await fetch(event.request); } catch (e) { return cached || (await cache.match("/offline")) || offlineAnswer(); }
    }

    // Phones: show the saved page at once, and refresh it quietly in the background.
    const refresh = fetch(key, { cache: "no-cache" }).then((res) => {
        if (res.ok && !res.redirected) cache.put(key, res.clone());
        return res;
    });
    if (cached) { event.waitUntil(refresh.catch(() => {})); return cached; }
    try { return await refresh; } catch (e) { return (await cache.match("/offline")) || offlineAnswer(); }
}

async function handleAsset(event) {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(event.request);
    const refresh = fetch(event.request).then((res) => {
        if (res.ok) cache.put(event.request, res.clone());
        return res;
    });
    if (DEV) { try { return await refresh; } catch (e) { return cached || Response.error(); } }
    if (cached) { event.waitUntil(refresh.catch(() => {})); return cached; }
    try { return await refresh; } catch (e) { return Response.error(); }
}

self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.method !== "GET") return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;
    // Shop data and the service worker itself always come straight from the server.
    if (url.pathname.startsWith("/api/") || url.pathname === "/health" || url.pathname === "/sw.js") return;

    if (req.mode === "navigate") event.respondWith(handlePage(event, url));
    else event.respondWith(handleAsset(event));
});
