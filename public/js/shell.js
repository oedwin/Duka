/* shell.js - the frame around every logged-in page:
   top bar (shop name, online/offline, log out) and navigation
   (bottom bar on phones, side bar on desktop).
   To add a screen in a later step, add one line to Duka.NAV. */
(function () {
    "use strict";
    var Duka = (window.Duka = window.Duka || {});

    var ICONS = {
        home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
        users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M16 4.7a3.5 3.5 0 010 6.6"/><path d="M18 14.3c2 .8 3.5 2.6 3.5 5.7"/>',
        box: '<path d="M3 7.5L12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5l9 4.5 9-4.5M12 12v9"/>',
        gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'
    };

    Duka.NAV = [
        { href: "/dashboard.html", label: "Home", icon: "home", roles: ["owner", "cashier"] },
        { href: "/products.html", label: "Products", icon: "box", roles: ["owner", "cashier"],
          also: ["/product-form.html", "/product-import.html"] },
        { href: "/staff.html", label: "Staff", icon: "users", roles: ["owner"] },
        { href: "/settings.html", label: "Settings", icon: "gear", roles: ["owner"] }
    ];

    function svg(name) {
        var el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        el.setAttribute("viewBox", "0 0 24 24");
        el.setAttribute("aria-hidden", "true");
        el.innerHTML = ICONS[name] || "";
        return el;
    }

    /* Call at the top of each page script:
         var page = await Duka.initPage({ title: "Settings", roles: ["owner"] });
         page.main.append(...)   // put your content here */
    Duka.initPage = async function (options) {
        options = options || {};
        var h = Duka.h;
        var never = new Promise(function () {}); // used to stop a page that is redirecting

        var token = Duka.auth.getToken();
        if (!token) { window.location.replace("/"); return never; }

        var user = Duka.auth.user();
        if (!user) {
            try {
                var me = await Duka.api("/api/auth/me");
                user = me.user;
                Duka.auth.saveUser(user);
            } catch (error) {
                document.body.textContent = error.message;
                return never;
            }
        } else {
            // Show the page at once from what we know, and check quietly in the background.
            Duka.api("/api/auth/me").then(function (me) { Duka.auth.saveUser(me.user); }).catch(function () {});
        }

        if (options.roles && options.roles.indexOf(user.role) === -1) {
            window.location.replace("/dashboard.html");
            return never;
        }

        document.title = (options.title ? options.title + " - " : "") + "Duka";

        var net = h("span", { class: "net", id: "net" }, "Online");
        function updateNet() {
            var online = navigator.onLine !== false;
            net.textContent = online ? "Online" : "Offline";
            net.classList.toggle("offline", !online);
        }
        window.addEventListener("online", updateNet);
        window.addEventListener("offline", updateNet);
        updateNet();

        var logout = h("button", { type: "button", onclick: Duka.auth.logout }, "Log out");
        var topbar = h("header", { class: "topbar" },
            h("span", { class: "brand" }, "Duka"),
            h("span", { class: "shopname" }, user.shopName || ""),
            net, logout);

        var nav = h("nav", { class: "nav", "aria-label": "Main" });
        Duka.NAV.forEach(function (item) {
            if (item.roles.indexOf(user.role) === -1) return;
            var link = h("a", { href: item.href }, svg(item.icon), item.label);
            var here = window.location.pathname;
            if (here === item.href || (item.also && item.also.indexOf(here) !== -1)) {
                link.setAttribute("aria-current", "page");
            }
            nav.appendChild(link);
        });

        var main = h("main", { class: "page", id: "page" });
        document.body.textContent = "";
        document.body.append(topbar, nav, main);

        var flash = null;
        try { flash = sessionStorage.getItem("duka_flash"); sessionStorage.removeItem("duka_flash"); } catch (e) { /* ignore */ }
        if (flash) Duka.toast(flash);

        return { user: user, main: main };
    };
})();
