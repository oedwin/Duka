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
        cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.6 11.5a1 1 0 001 .8h9.2a1 1 0 001-.8L20 7H6"/>',
        receipt: '<path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
        box: '<path d="M3 7.5L12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5l9 4.5 9-4.5M12 12v9"/>',
        user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>',
        coins: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.5c0-1 1-1.7 2.5-1.7s2.5.7 2.5 1.7-1 1.6-2.5 1.9-2.5.9-2.5 1.9 1 1.7 2.5 1.7 2.5-.7 2.5-1.7"/>',
        chart: '<path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/>',
        stock: '<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>',
        truck: '<path d="M1 6h13v10H1zM14 10h4l3 3v3h-7z"/><circle cx="6" cy="18" r="1.8"/><circle cx="17" cy="18" r="1.8"/>',
        store: '<path d="M3 9l1.5-5h15L21 9"/><path d="M3 9a3 3 0 006 0 3 3 0 006 0 3 3 0 006 0"/><path d="M5 12v8h14v-8"/>',
        more: '<path d="M5 12h.01M12 12h.01M19 12h.01"/>',
        gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'
    };

    // more: true = on a phone these live behind the "More" button; on a computer they are all in the side bar.
    Duka.NAV = [
        { href: "/dashboard.html", label: "Home", icon: "home", roles: ["owner", "cashier"] },
        { href: "/pos.html", label: "Sell", icon: "cart", roles: ["owner", "cashier"] },
        { href: "/sales.html", label: "Sales", icon: "receipt", roles: ["owner", "cashier"], also: ["/receipt.html"] },
        { href: "/products.html", label: "Products", icon: "box", roles: ["owner", "cashier"],
          also: ["/product-form.html", "/product-import.html"] },
        { href: "/customers.html", label: "Customers", icon: "user", roles: ["owner"], more: true,
          also: ["/customer.html", "/payment-receipt.html"] },
        { href: "/expenses.html", label: "Expenses", icon: "coins", roles: ["owner"], more: true },
        { href: "/reports.html", label: "Reports", icon: "chart", roles: ["owner"], more: true },
        { href: "/stock.html", label: "Stock", icon: "stock", roles: ["owner"], more: true,
          also: ["/stock-take.html", "/stock-movements.html"] },
        { href: "/purchases.html", label: "Purchases", icon: "truck", roles: ["owner"], more: true,
          also: ["/purchase-form.html", "/purchase.html"] },
        { href: "/suppliers.html", label: "Suppliers", icon: "store", roles: ["owner"], more: true, also: ["/supplier.html"] },
        { href: "/staff.html", label: "Staff", icon: "users", roles: ["owner"], more: true },
        { href: "/settings.html", label: "Settings", icon: "gear", roles: ["owner"], more: true }
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
        var morePanel = h("div", { class: "nav-more" });
        var moreButton = h("button", { type: "button", class: "more-btn", "aria-expanded": "false" }, svg("more"), "More");
        var here = window.location.pathname;
        var hasMore = false;

        Duka.NAV.forEach(function (item) {
            if (item.roles.indexOf(user.role) === -1) return;
            var link = h("a", { href: item.href }, svg(item.icon), item.label);
            var current = here === item.href || (item.also && item.also.indexOf(here) !== -1);
            if (current) link.setAttribute("aria-current", "page");
            if (item.more) {
                hasMore = true;
                if (current) moreButton.dataset.active = "1";
                morePanel.appendChild(link);
            } else {
                nav.appendChild(link);
            }
        });
        if (hasMore) {
            nav.append(moreButton, morePanel);
            moreButton.addEventListener("click", function (event) {
                event.stopPropagation();
                var open = nav.classList.toggle("open");
                moreButton.setAttribute("aria-expanded", open ? "true" : "false");
            });
            document.addEventListener("click", function () { nav.classList.remove("open"); });
        }

        var main = h("main", { class: "page", id: "page" });
        document.body.textContent = "";
        document.body.append(topbar, nav, main);

        var flash = null;
        try { flash = sessionStorage.getItem("duka_flash"); sessionStorage.removeItem("duka_flash"); } catch (e) { /* ignore */ }
        if (flash) Duka.toast(flash);

        return { user: user, main: main };
    };
})();
