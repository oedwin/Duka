/* api.js - login storage, talking to the server, and number formatting.
   Loaded first on every page. Everything lives under the global `Duka`. */
(function () {
    "use strict";
    var Duka = (window.Duka = window.Duka || {});
    var TOKEN_KEY = "duka_token";
    var USER_KEY = "duka_user";

    // ---------- Who is logged in ----------
    Duka.auth = {
        getToken: function () { return localStorage.getItem(TOKEN_KEY); },
        user: function () {
            try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch (e) { return null; }
        },
        save: function (token, user) {
            localStorage.setItem(TOKEN_KEY, token);
            localStorage.setItem(USER_KEY, JSON.stringify(user));
        },
        saveUser: function (user) { localStorage.setItem(USER_KEY, JSON.stringify(user)); },
        clear: function () {
            localStorage.removeItem(TOKEN_KEY);
            localStorage.removeItem(USER_KEY);
        },
        logout: function () { Duka.auth.clear(); window.location.href = "/"; }
    };

    // ---------- Install on a computer or phone (PWA) ----------
    // Adds the install information to every page, starts the service worker (/sw.js), and lets a
    // screen offer an "Install app" button. Chrome/Edge/Android show their own prompt; iPhone/iPad
    // (Safari) have no prompt, so Duka.install.isIos() lets the screen show the "Add to Home Screen" steps.
    (function () {
        function put(tag, attrs, key) {
            if (document.head.querySelector(key)) return;
            var el = document.createElement(tag);
            Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
            document.head.appendChild(el);
        }
        // The app is installed under the shop's own name (e.g. "Shoe Hub"); before login it is just "Duka".
        var shopName = "";
        try { var saved = JSON.parse(localStorage.getItem("duka_user")); shopName = (saved && saved.shopName) || ""; } catch (e) { /* ignore */ }
        put("link", { rel: "manifest", href: shopName ? "/api/manifest?n=" + encodeURIComponent(shopName) : "/manifest.json" }, 'link[rel="manifest"]');
        put("link", { rel: "apple-touch-icon", href: "/icons/apple-touch-icon.png" }, 'link[rel="apple-touch-icon"]');
        put("link", { rel: "icon", type: "image/png", href: "/icons/icon-192.png" }, 'link[rel="icon"]');
        put("meta", { name: "apple-mobile-web-app-capable", content: "yes" }, 'meta[name="apple-mobile-web-app-capable"]');
        put("meta", { name: "mobile-web-app-capable", content: "yes" }, 'meta[name="mobile-web-app-capable"]');
        put("meta", { name: "apple-mobile-web-app-title", content: (shopName || "Duka").slice(0, 12) }, 'meta[name="apple-mobile-web-app-title"]');
        put("meta", { name: "apple-mobile-web-app-status-bar-style", content: "default" }, 'meta[name="apple-mobile-web-app-status-bar-style"]');

        var secure = window.location.protocol === "https:" || window.location.hostname === "localhost";
        if (secure && "serviceWorker" in navigator) {
            window.addEventListener("load", function () { navigator.serviceWorker.register("/sw.js").catch(function () {}); });
        }

        var deferred = null;
        function announce(name) { try { document.dispatchEvent(new Event(name)); } catch (e) { /* ignore */ } }
        window.addEventListener("beforeinstallprompt", function (event) { event.preventDefault(); deferred = event; announce("duka:install-changed"); });
        window.addEventListener("appinstalled", function () { deferred = null; announce("duka:install-changed"); });

        var ua = navigator.userAgent || "";
        Duka.install = {
            // Already opened as an installed app?
            standalone: function () {
                return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
            },
            isIos: function () { return /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1); },
            canPrompt: function () { return Boolean(deferred); },
            // Should a screen show an Install button right now?
            offer: function () { return !Duka.install.standalone() && (Duka.install.canPrompt() || Duka.install.isIos()); },
            prompt: async function () {
                if (!deferred) return false;
                var event = deferred;
                deferred = null;
                event.prompt();
                var choice = await event.userChoice.catch(function () { return {}; });
                announce("duka:install-changed");
                return choice.outcome === "accepted";
            }
        };
    })();

    // ---------- Unique ids (so a double-tap or retry can never save a sale twice) ----------
    Duka.uuid = function () {
        if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
        // Older phones / plain http on a network address
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
            var r = crypto.getRandomValues(new Uint8Array(1))[0] % 16;
            return (c === "x" ? r : (r & 3) | 8).toString(16);
        });
    };

    function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

    /* Duka.api("/api/settings")                          -> GET
       Duka.api("/api/users", {method:"POST", body:{..}}) -> POST
       Returns the `data` part of the answer, or throws an Error with a plain message.
       Reads (GET) are retried automatically. Writes are retried only when you pass
       safeToRetry:true, which you do ONLY when the body carries a clientUuid. */
    Duka.api = async function (path, options) {
        options = options || {};
        var method = (options.method || "GET").toUpperCase();
        var attempts = method === "GET" || options.safeToRetry === true ? 3 : 1;
        var lastError;

        for (var i = 0; i < attempts; i++) {
            var controller = new AbortController();
            var timer = setTimeout(function () { controller.abort(); }, options.timeout || 20000);
            try {
                var headers = {};
                if (options.body !== undefined) headers["Content-Type"] = "application/json";
                var token = Duka.auth.getToken();
                if (token) headers.Authorization = "Bearer " + token;

                var response = await fetch(path, {
                    method: method,
                    headers: headers,
                    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
                    signal: controller.signal
                });
                clearTimeout(timer);

                var json = null;
                try { json = await response.json(); } catch (e) { /* no JSON body */ }

                if (response.ok && json && json.success !== false) return json.data;

                var error = new Error((json && json.message) || "Something went wrong. Please try again.");
                error.status = response.status;
                error.code = json && json.code;       // e.g. "BELOW_COST": the screen can ask "Sell anyway?"
                error.details = json && json.details;

                if (response.status === 401 && !options.noAuthRedirect) {
                    Duka.auth.clear();
                    window.location.href = "/";
                }
                // Subscription ended: send the person to the renewal screen (login and payment still work).
                if (response.status === 402 && error.code === "SUBSCRIPTION_REQUIRED" && !options.noSubscriptionRedirect
                    && window.location.pathname.indexOf("/subscription") !== 0) {
                    window.location.href = "/subscription.html";
                }
                if (response.status >= 500 && i < attempts - 1) {
                    lastError = error;
                    await sleep(600 * (i + 1));
                    continue;
                }
                throw error;
            } catch (e) {
                clearTimeout(timer);
                if (e.status) throw e; // the server answered; do not disguise it
                // No answer: offline, slow or timed out
                lastError = new Error(
                    navigator.onLine === false
                        ? "You are offline. Check your connection and try again."
                        : "The connection is slow or failed. Please try again."
                );
                lastError.network = true;
                if (i < attempts - 1) { await sleep(600 * (i + 1)); continue; }
                throw lastError;
            }
        }
        throw lastError;
    };

    // ---------- Formatting ----------
    Duka.fmt = {
        /* 25000 -> "UGX 25,000" (whole shillings only) */
        ugx: function (amount) {
            var n = Math.round(Number(amount) || 0);
            var sign = n < 0 ? "-" : "";
            return "UGX " + sign + String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
        },
        number: function (amount) {
            return String(Math.round(Number(amount) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
        },
        /* Stock in friendly units: stock(150, units) -> "3 Sacks"; stock(135, units) -> "2 Sacks, 35 Kg"
           units = [{name:"Kg",factor:1},{name:"Sack (50kg)",factor:50}] */
        stock: function (baseQty, units) {
            var qty = Math.round(Number(baseQty) || 0);
            if (qty < 0) return "-" + Duka.fmt.stock(-qty, units);

            var list = (units || []).slice().sort(function (a, b) { return b.factor - a.factor; });
            var base = list.filter(function (u) { return u.factor === 1; })[0] || { name: "units", factor: 1 };

            function shortName(name) { return String(name).replace(/\s*\(.*\)\s*$/, "") || String(name); }
            function plural(name, n) {
                if (n === 1 || name.length <= 2 || /(kg|g|l|ml|s)$/i.test(name)) return name;
                return /(x|ch|sh)$/i.test(name) ? name + "es" : name + "s";
            }

            var parts = [];
            var rest = qty;
            list.forEach(function (unit) {
                if (unit.factor <= 1) return;
                var n = Math.floor(rest / unit.factor);
                if (n > 0) {
                    parts.push(n + " " + plural(shortName(unit.name), n));
                    rest -= n * unit.factor;
                }
            });
            if (rest > 0 || parts.length === 0) parts.push(rest + " " + plural(shortName(base.name), rest));
            return parts.join(", ");
        },
        date: function (value) {
            if (!value) return "";
            var d = new Date(value);
            return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Africa/Kampala" });
        },
        /* "20 Oct 2026, 3:45 pm" in Kampala time, whatever the phone's own clock setting */
        dateTime: function (value) {
            if (!value) return "";
            return new Date(value).toLocaleString("en-GB", {
                day: "numeric", month: "short", year: "numeric",
                hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Africa/Kampala"
            });
        },
        /* Today's date in Kampala as "2026-10-20" (used for date filters) */
        today: function () {
            return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Kampala" });
        },
        /* "2026-10-20" plus/minus whole days -> "2026-10-19" */
        addDays: function (dateText, days) {
            var parts = dateText.split("-").map(Number);
            var d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + days));
            return d.toISOString().slice(0, 10);
        }
    };
})();
