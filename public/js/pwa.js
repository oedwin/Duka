/* pwa.js - makes Duka installable and keeps it up to date.
     - registers the service worker (so the app opens with no internet)
     - shows an "Update" banner when a new version is ready
     - lets the Home screen offer "Install Duka" (Duka.pwa.canInstall / Duka.pwa.install()) */
(function () {
    "use strict";
    var Duka = (window.Duka = window.Duka || {});
    var isDev = /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
    var installEvent = null;

    function standalone() {
        return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
    }
    var ios = /iphone|ipad|ipod/i.test(window.navigator.userAgent) && !window.MSStream;

    Duka.pwa = {
        isStandalone: standalone,
        // Chrome / Edge / Android show a real install button; iPhones need "Share > Add to Home Screen".
        canInstall: function () { return !standalone() && !!installEvent; },
        needsIosHelp: function () { return ios && !standalone(); },
        install: function () {
            if (!installEvent) return Promise.resolve(false);
            var e = installEvent;
            installEvent = null;
            e.prompt();
            return e.userChoice.then(function (choice) { window.dispatchEvent(new Event("duka:install")); return choice.outcome === "accepted"; });
        }
    };

    window.addEventListener("beforeinstallprompt", function (event) {
        event.preventDefault();
        installEvent = event;
        window.dispatchEvent(new Event("duka:install"));
    });
    window.addEventListener("appinstalled", function () { installEvent = null; window.dispatchEvent(new Event("duka:install")); });

    if (!("serviceWorker" in navigator)) return;

    var hadController = !!navigator.serviceWorker.controller;
    var reloading = false;

    function showUpdateBanner(worker) {
        if (isDev || document.getElementById("updateBanner")) return;
        var banner = document.createElement("div");
        banner.id = "updateBanner";
        banner.className = "update-banner no-print";
        banner.setAttribute("role", "status");
        var text = document.createElement("span");
        text.textContent = "A new version of Duka is ready.";
        var button = document.createElement("button");
        button.type = "button";
        button.textContent = "Update now";
        button.addEventListener("click", function () { worker.postMessage({ type: "SKIP_WAITING" }); });
        banner.append(text, button);
        document.body.appendChild(banner);
    }

    // The new version took over: reload once so the page and its scripts match.
    navigator.serviceWorker.addEventListener("controllerchange", function () {
        if (!hadController) { hadController = true; return; } // the very first install needs no reload
        if (reloading) return;
        reloading = true;
        window.location.reload();
    });

    window.addEventListener("load", function () {
        navigator.serviceWorker.register("/sw.js").then(function (registration) {
            if (registration.waiting && navigator.serviceWorker.controller) showUpdateBanner(registration.waiting);
            registration.addEventListener("updatefound", function () {
                var worker = registration.installing;
                if (!worker) return;
                worker.addEventListener("statechange", function () {
                    if (worker.state === "installed" && navigator.serviceWorker.controller) showUpdateBanner(worker);
                });
            });
            // Look for a new version now and then while the app stays open.
            setInterval(function () { registration.update().catch(function () {}); }, 60 * 60 * 1000);
        }).catch(function (error) { console.warn("Offline mode could not start:", error.message); });
    });
})();
