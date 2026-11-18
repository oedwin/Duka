/* sw.js - makes Duka installable and keeps the app screens available on a weak connection.
   - Shop data (/api/...) is NEVER stored or answered from here: sales, stock and money always come
     live from the server, so nothing old or wrong can be shown.
   - Pages and files (html, css, js, icons) are fetched fresh first; if the network is slow or down,
     the last copy is used, and a friendly "You are offline" page is shown for pages never opened before.
   Change VERSION when you want every phone to drop its old copies. */
var VERSION = "duka-v1";
var CACHE = VERSION + "-files";
var PRECACHE = ["/offline", "/css/app.css", "/icons/icon-192.png", "/manifest.json"];
var SLOW_MS = 4000;

self.addEventListener("install", function (event) {
    event.waitUntil(
        caches.open(CACHE)
            .then(function (cache) { return Promise.all(PRECACHE.map(function (url) { return cache.add(url).catch(function () {}); })); })
            .then(function () { return self.skipWaiting(); })
    );
});

self.addEventListener("activate", function (event) {
    event.waitUntil(
        caches.keys()
            .then(function (keys) { return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); })
            .then(function () { return self.clients.claim(); })
    );
});

function networkFirst(request) {
    return new Promise(function (resolve) {
        var settled = false;
        var timer = setTimeout(function () {
            // Slow network: show the saved copy now if there is one, the fresh answer still updates the cache.
            caches.match(request).then(function (hit) { if (hit && !settled) { settled = true; resolve(hit); } });
        }, SLOW_MS);
        fetch(request).then(function (response) {
            clearTimeout(timer);
            if (response.ok && response.type === "basic" && !response.redirected) {
                var copy = response.clone();
                caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
            }
            if (!settled) { settled = true; resolve(response); }
        }).catch(function () {
            clearTimeout(timer);
            if (settled) return;
            caches.match(request).then(function (hit) {
                settled = true;
                if (hit) return resolve(hit);
                if (request.mode === "navigate") return caches.match("/offline").then(function (page) { resolve(page || Response.error()); });
                resolve(Response.error());
            });
        });
    });
}

self.addEventListener("fetch", function (event) {
    var request = event.request;
    if (request.method !== "GET") return;
    var url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname.indexOf("/api/") === 0) return;   // shop data: always live
    if (url.pathname === "/sw.js") return;
    event.respondWith(networkFirst(request));
});
