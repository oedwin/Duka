/* sales.js - sales history: pick days, filter, see totals, open a receipt */
(async function () {
    "use strict";
    var h = Duka.h;
    var page = await Duka.initPage({ title: "Sales" });
    var isOwner = page.user.role === "owner";

    var METHOD_NAME = { cash: "Cash", mobile_money: "Mobile Money", bank: "Bank" };
    var state = { preset: "today", from: "", to: "", method: "", status: "completed", cashierId: "", search: "" };
    var pageNo = 1;
    var requestId = 0;

    // ---------- day choices (all in Kampala time) ----------
    var PRESETS = [
        ["today", "Today"], ["yesterday", "Yesterday"], ["week", "Last 7 days"],
        ["month", "This month"], ["custom", "Pick dates"]
    ];
    function range() {
        var today = Duka.fmt.today();
        if (state.preset === "yesterday") { var y = Duka.fmt.addDays(today, -1); return { from: y, to: y }; }
        if (state.preset === "week") return { from: Duka.fmt.addDays(today, -6), to: today };
        if (state.preset === "month") return { from: today.slice(0, 8) + "01", to: today };
        if (state.preset === "custom") return { from: state.from || today, to: state.to || state.from || today };
        return { from: today, to: today };
    }

    var presetButtons = PRESETS.map(function (p) {
        var button = h("button", { type: "button", class: "seg" }, p[1]);
        button.addEventListener("click", function () { state.preset = p[0]; syncControls(); load(true); });
        button.dataset.key = p[0];
        return button;
    });
    var fromInput = h("input", { class: "input", type: "date", "aria-label": "From" });
    var toInput = h("input", { class: "input", type: "date", "aria-label": "To" });
    var customRow = h("div", { class: "pair", hidden: true }, fromInput, toInput);
    fromInput.addEventListener("change", function () { state.from = fromInput.value; load(true); });
    toInput.addEventListener("change", function () { state.to = toInput.value; load(true); });

    var method = h("select", { class: "input", "aria-label": "Payment method" },
        [["", "Any payment"], ["cash", "Cash"], ["mobile_money", "Mobile Money"], ["bank", "Bank"], ["credit", "On credit"]]
            .map(function (o) { return h("option", { value: o[0] }, o[1]); }));
    var status = h("select", { class: "input", "aria-label": "Status" },
        [["completed", "Completed sales"], ["voided", "Voided sales"], ["all", "All"]]
            .map(function (o) { return h("option", { value: o[0] }, o[1]); }));
    var cashier = h("select", { class: "input", "aria-label": "Cashier", hidden: !isOwner }, h("option", { value: "" }, "All cashiers"));
    var searchBox = h("input", { class: "input", type: "search", placeholder: "Receipt number or customer", autocomplete: "off", "aria-label": "Search sales" });

    var summary = h("div", { class: "card" });
    var list = h("div", { class: "card" });
    var more = h("button", { type: "button", class: "btn ghost block", hidden: true }, "Show more");

    function syncControls() {
        presetButtons.forEach(function (b) { b.classList.toggle("on", b.dataset.key === state.preset); });
        customRow.hidden = state.preset !== "custom";
    }

    function stat(label, value, bad) {
        return h("div", { class: "stat-box" }, h("div", { class: "muted" }, label), h("div", { class: "stat" + (bad ? " bad" : "") }, value));
    }

    function row(s) {
        var badges = [];
        if (s.status === "voided") badges.push(h("span", { class: "badge off" }, "Voided"));
        if (s.status === "completed" && s.balanceDue > 0) badges.push(h("span", { class: "badge warn" }, "On credit " + Duka.fmt.ugx(s.balanceDue)));
        if (s.status === "completed" && s.refunded > 0) badges.push(h("span", { class: "badge warn" }, "Returned " + Duka.fmt.ugx(s.refunded)));
        var sub = [Duka.fmt.dateTime(s.createdAt)]
            .concat(s.methods.map(function (m) { return METHOD_NAME[m] || m; }))
            .concat(isOwner && s.servedBy ? ["by " + s.servedBy] : []).join(" \u00b7 ");
        return h("a", { class: "row link", href: "/receipt.html?id=" + s.id },
            h("div", { class: "grow" },
                h("div", { class: "name" }, "No. " + (s.receiptNumber || "-") + " \u00b7 " + (s.customerName || "Walk-in")),
                h("div", { class: "sub" }, sub),
                badges.length ? h("div", { class: "badges" }, badges) : null),
            h("div", { class: "price" + (s.status === "voided" ? " struck" : "") },
                Duka.fmt.ugx(s.totalAmount),
                s.status === "completed" && s.refunded > 0 ? h("small", {}, "Net " + Duka.fmt.ugx(s.totalAmount - s.refunded)) : null));
    }

    async function load(reset) {
        var mine = ++requestId;
        if (reset) {
            pageNo = 1;
            more.hidden = true;
            list.replaceChildren(h("p", { class: "empty" }, "Loading..."));
        }
        var r = range();
        var query = new URLSearchParams({ from: r.from, to: r.to, status: state.status, page: pageNo, limit: 30 });
        if (state.method) query.set("method", state.method);
        if (state.cashierId) query.set("cashierId", state.cashierId);
        if (state.search) query.set("search", state.search);

        try {
            var data = await Duka.api("/api/sales?" + query.toString());
            if (mine !== requestId) return;

            if (reset) {
                list.replaceChildren();
                summary.replaceChildren(h("div", { class: "stats" },
                    stat("Sales", Duka.fmt.number(data.totals.sales)),
                    stat("Total sold", Duka.fmt.ugx(data.totals.total)),
                    stat("Refunds for returns", data.totals.refunds > 0 ? "-" + Duka.fmt.ugx(data.totals.refunds) : Duka.fmt.ugx(0), data.totals.refunds > 0),
                    stat("Net sold", Duka.fmt.ugx(data.totals.net)),
                    stat("Paid at the till", Duka.fmt.ugx(data.totals.paid)),
                    stat("Given on credit", Duka.fmt.ugx(data.totals.credit), data.totals.credit > 0)));
            }
            data.sales.forEach(function (s) { list.appendChild(row(s)); });
            if (data.total === 0) list.replaceChildren(h("p", { class: "empty" }, "No sales found for these choices."));
            more.hidden = !data.hasMore;
            more.textContent = "Show more (" + (data.total - data.page * data.limit) + " left)";
        } catch (error) {
            if (mine !== requestId) return;
            list.replaceChildren(h("p", { class: "form-error" }, error.message),
                h("button", { type: "button", class: "btn ghost", onclick: function () { load(true); } }, "Try again"));
        }
    }

    method.addEventListener("change", function () { state.method = method.value; load(true); });
    status.addEventListener("change", function () { state.status = status.value; load(true); });
    cashier.addEventListener("change", function () { state.cashierId = cashier.value; load(true); });
    var timer;
    searchBox.addEventListener("input", function () {
        clearTimeout(timer);
        timer = setTimeout(function () { state.search = searchBox.value.trim(); load(true); }, 300);
    });
    more.addEventListener("click", function () { pageNo++; load(false); });

    page.main.append(h("div", {},
        h("div", { class: "page-head" }, h("h1", {}, "Sales"),
            h("p", {}, isOwner ? "Every sale in your shop." : "Your sales.")),
        h("div", { class: "card" },
            h("div", { class: "seg-group wrap", role: "group", "aria-label": "Days" }, presetButtons),
            customRow),
        h("div", { class: "toolbar" }, method, status, cashier),
        searchBox, summary, list, more));

    if (isOwner) {
        Duka.api("/api/users").then(function (data) {
            data.staff.forEach(function (u) { cashier.appendChild(h("option", { value: String(u.id) }, u.fullName)); });
        }).catch(function () { /* the cashier filter stays on "All" */ });
    }

    syncControls();
    load(true);
})();
