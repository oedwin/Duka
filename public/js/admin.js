/* admin.js - the Duka administrator's dashboard: every shop, its subscription and payments.
   Has its own login and token (admin_accounts table). Actions: suspend, reactivate,
   give free days, confirm a payment made outside Pesapal. */
(async function () {
    "use strict";
    var h = Duka.h;
    /* This screen is NOT part of the shop system: its own login (/admin-login), its own token, no shop menu.
       The shop login and the admin login cannot open each other's screens. */
    var never = new Promise(function () {});
    var KEY = "duka_admin_token";
    function token() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
    function logout() { try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ } window.location.href = "/admin-login"; }
    // Duka.api reads the token from Duka.auth: point it at the admin token on this page only.
    Duka.auth.getToken = token;
    async function api(path, options) {
        options = Object.assign({ noAuthRedirect: true }, options || {});
        try { return await Duka.api(path, options); }
        catch (error) { if (error.status === 401) { logout(); await never; } throw error; }
    }
    if (!token()) { window.location.replace("/admin-login"); return never; }
    var me;
    try { me = await api("/api/admin/me"); } catch (error) { document.body.textContent = error.message; return never; }
    document.title = "Duka Admin";
    var main = h("main", { class: "admin-page" });
    document.body.textContent = "";
    document.body.append(
        h("header", { class: "topbar" },
            h("span", { class: "brand" }, "Duka"),
            h("span", { class: "shopname" }, "Admin · " + me.admin.fullName),
            h("button", { type: "button", onclick: changePassword }, "Password"),
            h("button", { type: "button", onclick: logout }, "Log out")),
        main);
    var page = { main: main };

    async function changePassword() {
        var v = await Duka.dialog({
            title: "Change password", confirmText: "Change",
            fields: [{ name: "currentPassword", label: "Current password", type: "password", autocomplete: "current-password" },
                     { name: "newPassword", label: "New password (at least 10 characters)", type: "password", autocomplete: "new-password" }]
        });
        if (!v) return;
        try { await api("/api/admin/change-password", { method: "POST", body: v }); Duka.toast("Password changed."); }
        catch (error) { Duka.toast(error.message, "error"); }
    }

    var STATE = {
        trial: ["Free trial", ""], active: ["Active", ""], cancelling: ["Ending", "warn"], none: ["No plan", "warn"],
        trial_ended: ["Trial ended", "off"], past_due: ["Expired", "off"], cancelled: ["Ended", "off"], suspended: ["Suspended", "off"]
    };
    var FILTERS = [["", "All"], ["trial", "Free trial"], ["active", "Active"], ["expiring", "Ending soon"], ["expired", "Expired"], ["suspended", "Suspended"]];

    var overview = null;
    var list = { shops: [], total: 0, page: 0, hasMore: false };
    var filter = "";
    var search = "";
    var root = h("div", {});
    page.main.append(h("div", { class: "page-head" }, h("h1", {}, "Admin")), root);

    function badge(state) {
        var s = STATE[state] || STATE.none;
        return h("span", { class: "badge" + (s[1] ? " " + s[1] : "") }, s[0]);
    }
    function stat(label, value, kind) {
        return h("div", { class: "stat-box" + (kind ? " " + kind : "") }, h("div", { class: "stat" }, String(value)), h("div", { class: "sub" }, label));
    }
    function fail(error) { Duka.toast(error.message, "error"); }

    async function loadOverview() { overview = await api("/api/admin/overview"); }
    async function loadShops(reset) {
        if (reset) list = { shops: [], total: 0, page: 0, hasMore: false };
        var next = list.page + 1;
        var res = await api("/api/admin/shops?page=" + next + "&state=" + encodeURIComponent(filter) + "&search=" + encodeURIComponent(search));
        list = { shops: list.shops.concat(res.shops), total: res.total, page: next, hasMore: res.hasMore };
    }

    // ---------- overview ----------
    function overviewCard() {
        var c = overview.counts, i = overview.income;
        return h("div", { class: "card" },
            h("h2", {}, "Overview"),
            h("div", { class: "stats" },
                stat("Shops", c.total), stat("Active (paying)", c.active, "good"),
                stat("On free trial", c.trial), stat("Ending in 7 days", c.expiring, c.expiring ? "bad" : ""),
                stat("Expired", c.expired, c.expired ? "bad" : ""), stat("Suspended", c.suspended)),
            h("p", { class: "muted" }, "Income this month: ", h("strong", {}, Duka.fmt.ugx(i.thisMonth)),
                " · last 30 days: ", h("strong", {}, Duka.fmt.ugx(i.last30)), " · all time: ", h("strong", {}, Duka.fmt.ugx(i.allTime))));
    }

    // ---------- payments waiting ----------
    function pendingCard() {
        var rows = overview.pending.map(function (p) {
            return h("div", { class: "row" },
                h("div", { class: "grow" },
                    h("div", { class: "name" }, p.shopName),
                    h("div", { class: "sub" }, p.planName + " · " + p.months + " month" + (p.months > 1 ? "s" : "") + " · " + Duka.fmt.dateTime(p.createdAt)),
                    h("div", { class: "sub" }, p.merchantRef + (p.started ? " · payment page opened" : " · no online payment started")),
                    p.note ? h("div", { class: "sub" }, p.note) : null),
                h("div", { class: "price" }, Duka.fmt.ugx(p.amount),
                    h("div", {}, h("button", { type: "button", class: "btn ghost small", onclick: function () { confirmPayment(p.merchantRef); } }, "Confirm paid"))));
        });
        return h("div", { class: "card" }, h("h2", {}, "Orders waiting for payment"),
            h("p", { class: "muted" }, "Customers who paid another way (cash, direct mobile money) quote their DUKA reference. Online payments confirm themselves."),
            rows.length ? h("div", {}, rows) : h("p", { class: "empty" }, "Nothing waiting."));
    }
    async function confirmPayment(ref) {
        var v = await Duka.dialog({
            title: "Confirm this payment?",
            message: "Only do this when you have seen the money (" + ref + "). The shop gets its days at once.",
            fields: [{ name: "reference", label: "Payment reference (mobile money transaction id, or CASH-date)" }],
            confirmText: "Confirm payment"
        });
        if (!v) return;
        try {
            await api("/api/admin/payments/confirm", { method: "POST", body: { merchantRef: ref, reference: v.reference.trim() } });
            Duka.toast("Payment confirmed.");
            await Promise.all([loadOverview(), loadShops(true)]);
            render();
        } catch (error) { fail(error); }
    }

    // ---------- shops ----------
    function shopsCard() {
        var chips = h("div", { class: "badges" }, FILTERS.map(function (f) {
            var on = filter === f[0];
            return h("button", {
                type: "button", class: "btn small" + (on ? "" : " ghost"),
                onclick: async function () { filter = f[0]; try { await loadShops(true); render(); } catch (e) { fail(e); } }
            }, f[1]);
        }));
        var box = h("input", { class: "input", type: "search", placeholder: "Search shop, owner or phone", value: search, "aria-label": "Search shops" });
        box.addEventListener("keydown", async function (e) {
            if (e.key !== "Enter") return;
            search = box.value.trim();
            try { await loadShops(true); render(); } catch (error) { fail(error); }
        });
        var rows = list.shops.map(function (s) {
            return h("a", { class: "row link", href: "#", onclick: function (e) { e.preventDefault(); openShop(s.id); } },
                h("div", { class: "grow" },
                    h("div", { class: "name" }, s.name),
                    h("div", { class: "sub" }, (s.ownerName || "No owner") + (s.ownerPhone ? " · " + s.ownerPhone : "")),
                    h("div", { class: "sub" }, (s.planName || "No plan") + " · " + s.users + (s.maxUsers ? " of " + s.maxUsers : "") + " users")),
                h("div", { class: "price" }, badge(s.state),
                    h("div", { class: "sub" }, s.endsAt ? (s.allowed ? "ends " : "ended ") + Duka.fmt.date(s.endsAt) : "")));
        });
        var more = h("button", { type: "button", class: "btn ghost block", hidden: !list.hasMore }, "Show more");
        more.addEventListener("click", async function () { try { await loadShops(false); render(); } catch (e) { fail(e); } });
        return h("div", { class: "card" }, h("h2", {}, "Shops (" + list.total + ")"), chips, box,
            rows.length ? h("div", {}, rows) : h("p", { class: "empty" }, "No shops match."), more);
    }

    // ---------- one shop ----------
    async function openShop(id) {
        var d;
        try { d = await api("/api/admin/shops/" + id); } catch (error) { fail(error); return; }
        var s = d.shop, modal;
        function done(message) { return async function () {
            if (modal) modal.close();
            Duka.toast(message);
            try { await Promise.all([loadOverview(), loadShops(true)]); render(); } catch (e) { fail(e); }
        }; }
        async function suspend() {
            var v = await Duka.dialog({ title: "Suspend " + s.name + "?", message: "The shop cannot work until you reactivate it. Their data is kept.",
                fields: [{ name: "reason", label: "Reason" }], confirmText: "Suspend", danger: true });
            if (!v) return;
            try { await api("/api/admin/shops/" + id + "/suspend", { method: "POST", body: { reason: v.reason.trim() } }); await done("Shop suspended.")(); } catch (e) { fail(e); }
        }
        async function reactivate() {
            var ok = await Duka.dialog({ title: "Reactivate " + s.name + "?", message: "It goes back to what its dates say (active, free trial, or expired).", confirmText: "Reactivate" });
            if (!ok) return;
            try { await api("/api/admin/shops/" + id + "/reactivate", { method: "POST", body: {} }); await done("Shop reactivated.")(); } catch (e) { fail(e); }
        }
        async function grant() {
            var v = await Duka.dialog({ title: "Give free days to " + s.name, message: "The days are added to the end of its current time.",
                fields: [{ name: "days", label: "Days (1 to 365)", type: "number", value: "7" }, { name: "reason", label: "Reason" }], confirmText: "Give days" });
            if (!v) return;
            try { await api("/api/admin/shops/" + id + "/grant-days", { method: "POST", body: { days: Number(v.days), reason: v.reason.trim() } }); await done("Days added.")(); } catch (e) { fail(e); }
        }
        var pays = d.payments.map(function (p) {
            return h("div", { class: "row" },
                h("div", { class: "grow" }, h("div", { class: "name" }, p.planName + " · " + p.months + " month" + (p.months > 1 ? "s" : "")),
                    h("div", { class: "sub" }, Duka.fmt.dateTime(p.createdAt) + " · " + p.merchantRef)),
                h("div", { class: "price" }, Duka.fmt.ugx(p.amount), h("div", { class: "sub" }, p.status)));
        });
        var people = d.users.map(function (u) {
            return h("div", { class: "sub" }, u.fullName + " · " + u.phone + " · " + u.role + (u.active ? "" : " (off)"));
        });
        modal = Duka.modal(h("div", {},
            h("h2", {}, s.name),
            h("div", { class: "sub-status" }, badge(s.state), h("span", { class: "muted" }, s.planName || "No plan")),
            h("dl", { class: "sub-facts" },
                h("div", {}, h("dt", {}, "Owner"), h("dd", {}, (s.ownerName || "-") + (s.ownerPhone ? " " + s.ownerPhone : ""))),
                h("div", {}, h("dt", {}, s.allowed ? "Ends on" : "Ended on"), h("dd", {}, s.endsAt ? Duka.fmt.date(s.endsAt) : "-")),
                h("div", {}, h("dt", {}, "Users"), h("dd", {}, s.users + (s.maxUsers ? " of " + s.maxUsers : ""))),
                h("div", {}, h("dt", {}, "Joined"), h("dd", {}, s.joinedAt ? Duka.fmt.date(s.joinedAt) : "-"))),
            d.suspendedReason ? h("p", { class: "muted" }, "Suspended: " + d.suspendedReason) : null,
            h("div", { class: "row-actions" },
                s.state === "suspended"
                    ? h("button", { type: "button", class: "btn", onclick: reactivate }, "Reactivate")
                    : h("button", { type: "button", class: "btn ghost danger", onclick: suspend }, "Suspend"),
                h("button", { type: "button", class: "btn ghost", onclick: grant }, "Give free days")),
            h("h3", {}, "Staff"), h("div", {}, people),
            h("h3", {}, "Payments"), pays.length ? h("div", {}, pays) : h("p", { class: "empty" }, "No payments."),
            h("button", { type: "button", class: "btn ghost block", onclick: function () { modal.close(); } }, "Close")
        ), { wide: true });
    }

    // ---------- page ----------
    function render() {
        root.replaceChildren.apply(root, [overviewCard(), pendingCard(), shopsCard()].filter(Boolean));
    }
    root.append(h("p", { class: "empty" }, "Loading..."));
    try {
        await Promise.all([loadOverview(), loadShops(true)]);
        render();
    } catch (error) {
        root.replaceChildren(h("p", { class: "empty" }, error.message));
    }
})();
