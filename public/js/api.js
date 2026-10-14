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

                if (response.status === 401 && !options.noAuthRedirect) {
                    Duka.auth.clear();
                    window.location.href = "/";
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
        date: function (value) {
            if (!value) return "";
            var d = new Date(value);
            return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
        }
    };
})();
