/* stock-movements.js - the full history of every change to stock: who, when, why. */
(async function () {
    "use strict";
    var h = Duka.h;
    var page = await Duka.initPage({ title: "Stock movements", roles: ["owner"] });

    var TYPES = [["", "All changes"], ["sale", "Sold"], ["sale_void", "Sale cancelled"], ["return", "Customer return"],
        ["purchase", "Stock received"], ["purchase_void", "Purchase cancelled"], ["adjustment", "Adjustment"],
        ["stock_take", "Stock-take correction"], ["opening", "Opening stock"]];
    var TYPE_NAME = {};
    TYPES.forEach(function (t) { TYPE_NAME[t[0]] = t[1]; });

    var productId = new URLSearchParams(window.location.search).get("productId") || "";
    var state = { preset: "30", from: "", to: "", type: "" };
    var pageNo = 1;
    var requestId = 0;

    var PRESETS = [["today", "Today"], ["7", "Last 7 days"], ["30", "Last 30 days"], ["custom", "Pick dates"]];
    function range() {
        var today = Duka.fmt.today();
        if (state.preset === "today") return { from: today, to: today };
        if (state.preset === "7") return { from: Duka.fmt.addDays(today, -6), to: today };
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
    var typeSelect = h("select", { class: "input", "aria-label": "Type of change" }, TYPES.map(function (t) { return h("option", { value: t[0] }, t[1]); }));
    typeSelect.addEventListener("change", function () { state.type = typeSelect.value; load(true); });

    var productNote = h("div", { class: "card", hidden: true });
    var summary = h("p", { class: "muted" });
    var list = h("div", { class: "card" });
    var more = h("button", { type: "button", class: "btn ghost block", hidden: true }, "Show more");

    function sync() {
        presetButtons.forEach(function (b) { b.classList.toggle("on", b.dataset.key === state.preset); });
        customRow.hidden = state.preset !== "custom";
    }

    function row(m) {
        var up = m.change > 0;
        return h("div", { class: "row" },
            h("div", { class: "grow" },
                h("div", { class: "name" }, m.productName),
                h("div", { class: "sub" }, TYPE_NAME[m.type] + " \u00b7 " + Duka.fmt.dateTime(m.createdAt) + (m.by ? " \u00b7 " + m.by : "")),
                m.note ? h("div", { class: "sub" }, m.note) : null),
            h("div", { class: "price" },
                h("span", { class: up ? "up" : "down" }, (up ? "+" : "-") + Duka.fmt.stock(Math.abs(m.change), m.units)),
                h("small", {}, "Left: " + Duka.fmt.stock(m.stockAfter, m.units))));
    }

    async function load(reset) {
        var mine = ++requestId;
        if (reset) { pageNo = 1; more.hidden = true; list.replaceChildren(h("p", { class: "empty" }, "Loading...")); }
        var r = range();
        var query = new URLSearchParams({ from: r.from, to: r.to, page: pageNo, limit: 40 });
        if (state.type) query.set("type", state.type);
        if (productId) query.set("productId", productId);
        try {
            var data = await Duka.api("/api/stock/movements?" + query.toString());
            if (mine !== requestId) return;
            if (reset) list.replaceChildren();
            data.movements.forEach(function (m) { list.appendChild(row(m)); });
            if (data.total === 0) list.replaceChildren(h("p", { class: "empty" }, "No stock changes in this period."));
            if (productId && data.movements[0]) {
                productNote.hidden = false;
                productNote.replaceChildren(h("div", { class: "row" },
                    h("div", { class: "grow" }, h("div", { class: "name" }, "Showing only: " + data.movements[0].productName)),
                    h("a", { class: "btn ghost small", href: "/stock-movements.html" }, "Show all products")));
            }
            summary.textContent = data.total + (data.total === 1 ? " change" : " changes");
            more.hidden = !data.hasMore;
            more.textContent = "Show more (" + (data.total - data.page * data.limit) + " left)";
        } catch (error) {
            if (mine !== requestId) return;
            list.replaceChildren(h("p", { class: "form-error" }, error.message),
                h("button", { type: "button", class: "btn ghost", onclick: function () { load(true); } }, "Try again"));
        }
    }
    more.addEventListener("click", function () { pageNo++; load(false); });

    page.main.append(h("div", {},
        h("p", {}, h("a", { href: "/stock.html" }, "\u2190 Back to stock")),
        h("div", { class: "page-head" }, h("h1", {}, "Stock movements"),
            h("p", {}, "Every time stock went up or down, and why.")),
        productNote,
        h("div", { class: "card" }, h("div", { class: "seg-group wrap", role: "group", "aria-label": "Period" }, presetButtons), customRow, typeSelect),
        summary, list, more));
    sync();
    load(true);
})();
