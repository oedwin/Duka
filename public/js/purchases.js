/* purchases.js - stock you bought: pick days, see what you spent and what you still owe */
(async function () {
    "use strict";
    var h = Duka.h;
    var page = await Duka.initPage({ title: "Purchases", roles: ["owner"] });

    var state = { preset: "30", from: "", to: "", supplierId: "", status: "completed", search: "" };
    var pageNo = 1;
    var requestId = 0;

    var PRESETS = [["today", "Today"], ["month", "This month"], ["30", "Last 30 days"], ["custom", "Pick dates"]];
    function range() {
        var today = Duka.fmt.today();
        if (state.preset === "today") return { from: today, to: today };
        if (state.preset === "month") return { from: today.slice(0, 8) + "01", to: today };
        if (state.preset === "custom") return { from: state.from || today, to: state.to || state.from || today };
        return { from: Duka.fmt.addDays(today, -29), to: today };
    }

    var presetButtons = PRESETS.map(function (p) {
        var b = h("button", { type: "button", class: "seg" }, p[1]);
        b.dataset.key = p[0];
        b.addEventListener("click", function () { state.preset = p[0]; sync(); load(true); });
        return b;
    });
    var fromInput = h("input", { class: "input", type: "date", "aria-label": "From" });
    var toInput = h("input", { class: "input", type: "date", "aria-label": "To" });
    var customRow = h("div", { class: "pair", hidden: true }, fromInput, toInput);
    fromInput.addEventListener("change", function () { state.from = fromInput.value; load(true); });
    toInput.addEventListener("change", function () { state.to = toInput.value; load(true); });

    var supplier = h("select", { class: "input", "aria-label": "Supplier" }, h("option", { value: "" }, "All suppliers"));
    var status = h("select", { class: "input", "aria-label": "Status" },
        [["completed", "Active purchases"], ["voided", "Cancelled"], ["all", "All"]].map(function (o) { return h("option", { value: o[0] }, o[1]); }));
    var searchBox = h("input", { class: "input", type: "search", placeholder: "Invoice number or supplier", autocomplete: "off", "aria-label": "Search purchases" });
    var summary = h("div", { class: "card" });
    var list = h("div", { class: "card" });
    var more = h("button", { type: "button", class: "btn ghost block", hidden: true }, "Show more");

    function sync() {
        presetButtons.forEach(function (b) { b.classList.toggle("on", b.dataset.key === state.preset); });
        customRow.hidden = state.preset !== "custom";
    }
    function stat(label, value, bad) {
        return h("div", { class: "stat-box" }, h("div", { class: "muted" }, label), h("div", { class: "stat" + (bad ? " bad" : "") }, value));
    }

    function row(p) {
        var title = p.reference === "OPENING" ? "Balance brought forward" : (p.supplierName || "No supplier") + (p.reference ? " \u00b7 " + p.reference : "");
        var badges = [];
        if (p.status === "voided") badges.push(h("span", { class: "badge off" }, "Cancelled"));
        else if (p.balanceDue > 0) badges.push(h("span", { class: "badge warn" }, "Still owed " + Duka.fmt.ugx(p.balanceDue)));
        return h("a", { class: "row link", href: "/purchase.html?id=" + p.id },
            h("div", { class: "grow" },
                h("div", { class: "name" }, title),
                h("div", { class: "sub" }, Duka.fmt.date(p.date) + " \u00b7 " + p.itemCount + (p.itemCount === 1 ? " item" : " items")),
                badges.length ? h("div", { class: "badges" }, badges) : null),
            h("div", { class: "price" + (p.status === "voided" ? " struck" : "") }, Duka.fmt.ugx(p.total), h("small", {}, "paid " + Duka.fmt.ugx(p.paid))));
    }

    async function load(reset) {
        var mine = ++requestId;
        if (reset) { pageNo = 1; more.hidden = true; list.replaceChildren(h("p", { class: "empty" }, "Loading...")); }
        var r = range();
        var query = new URLSearchParams({ from: r.from, to: r.to, status: state.status, page: pageNo, limit: 30 });
        if (state.supplierId) query.set("supplierId", state.supplierId);
        if (state.search) query.set("search", state.search);
        try {
            var data = await Duka.api("/api/purchases?" + query.toString());
            if (mine !== requestId) return;
            if (reset) {
                list.replaceChildren();
                summary.replaceChildren(h("div", { class: "stats" },
                    stat("Purchases", Duka.fmt.number(data.totals.purchases)),
                    stat("Bought for", Duka.fmt.ugx(data.totals.total)),
                    stat("Paid", Duka.fmt.ugx(data.totals.paid)),
                    stat("Still owed", Duka.fmt.ugx(data.totals.owed), data.totals.owed > 0)));
            }
            data.purchases.forEach(function (p) { list.appendChild(row(p)); });
            if (data.total === 0) list.replaceChildren(h("p", { class: "empty" }, "No purchases found for these choices."));
            more.hidden = !data.hasMore;
            more.textContent = "Show more (" + (data.total - data.page * data.limit) + " left)";
        } catch (error) {
            if (mine !== requestId) return;
            list.replaceChildren(h("p", { class: "form-error" }, error.message),
                h("button", { type: "button", class: "btn ghost", onclick: function () { load(true); } }, "Try again"));
        }
    }

    supplier.addEventListener("change", function () { state.supplierId = supplier.value; load(true); });
    status.addEventListener("change", function () { state.status = status.value; load(true); });
    var timer;
    searchBox.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(function () { state.search = searchBox.value.trim(); load(true); }, 300); });
    more.addEventListener("click", function () { pageNo++; load(false); });

    page.main.append(h("div", {},
        h("div", { class: "page-head" }, h("h1", {}, "Purchases"), h("p", {}, "Stock you bought from suppliers.")),
        h("div", { class: "page-actions" },
            h("a", { class: "btn", href: "/purchase-form.html" }, "Record a purchase"),
            h("a", { class: "btn ghost", href: "/suppliers.html" }, "Suppliers")),
        h("div", { class: "card" }, h("div", { class: "seg-group wrap", role: "group", "aria-label": "Days" }, presetButtons), customRow),
        h("div", { class: "toolbar" }, supplier, status), searchBox, summary, list, more));

    Duka.api("/api/suppliers?status=all").then(function (data) {
        data.suppliers.forEach(function (s) { supplier.appendChild(h("option", { value: String(s.id) }, s.name)); });
    }).catch(function () { /* the filter stays on "All suppliers" */ });

    sync();
    load(true);
})();
