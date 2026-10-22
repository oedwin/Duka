/* stock.js - what is on the shelf: levels, alerts, value, and fixing mistakes (damaged, lost, found).
   Stock only changes through sales, purchases, returns, adjustments and stock-taking,
   so every change has a record and a reason. */
(async function () {
    "use strict";
    var h = Duka.h;
    var page = await Duka.initPage({ title: "Stock", roles: ["owner"] });

    var view = "all";
    var pageNo = 1;
    var requestId = 0;

    function sortedUnits(p) { return p.units.slice().sort(function (a, b) { return a.factor - b.factor; }); }
    function numInput(attrs) { return h("input", Object.assign({ class: "input", type: "number", inputmode: "numeric", min: "0", step: "1" }, attrs || {})); }

    var alertsBox = h("div", { class: "page-actions" });
    var valueBox = h("div", { class: "card" }, h("p", { class: "empty" }, "Loading..."));
    var search = h("input", { class: "input", type: "search", placeholder: "Search product or barcode", autocomplete: "off", "aria-label": "Search products" });
    var category = h("select", { class: "input", "aria-label": "Category" }, h("option", { value: "" }, "All categories"));
    var viewSelect = h("select", { class: "input", "aria-label": "Show" },
        [["all", "All products"], ["low", "Low stock"], ["out", "Out of stock"], ["expiring", "Expiring soon"]]
            .map(function (o) { return h("option", { value: o[0] }, o[1]); }));
    var summary = h("p", { class: "muted" });
    var list = h("div", { class: "card" });
    var more = h("button", { type: "button", class: "btn ghost block", hidden: true }, "Show more");

    // ---------- top of the page: alerts and value ----------
    async function loadSummary() {
        try {
            var data = await Duka.api("/api/stock/summary");
            var a = data.alerts;
            function chip(label, count, key, bad) {
                var b = h("button", { type: "button", class: "seg" + (view === key ? " on" : "") }, label + " (" + count + ")");
                b.addEventListener("click", function () { view = view === key ? "all" : key; viewSelect.value = view; loadSummary(); load(true); });
                if (bad && count > 0 && view !== key) b.classList.add("alert");
                return b;
            }
            alertsBox.replaceChildren(chip("Low stock", a.low, "low", true), chip("Out of stock", a.out, "out", true), chip("Expiring soon", a.expiring, "expiring", true));

            var v = data.value;
            valueBox.replaceChildren(
                h("h2", {}, "What your stock is worth"),
                h("div", { class: "stats" },
                    h("div", { class: "stat-box" }, h("div", { class: "muted" }, "At what it cost you"), h("div", { class: "stat" }, Duka.fmt.ugx(v.costValue))),
                    h("div", { class: "stat-box" }, h("div", { class: "muted" }, "At your selling price"), h("div", { class: "stat" }, Duka.fmt.ugx(v.retailValue))),
                    h("div", { class: "stat-box" }, h("div", { class: "muted" }, "Profit if all sold"), h("div", { class: "stat" }, Duka.fmt.ugx(v.expectedProfit)))),
                h("details", {},
                    h("summary", {}, "By category"),
                    v.byCategory.map(function (c) {
                        return h("div", { class: "row" },
                            h("div", { class: "grow" }, h("div", { class: "name" }, c.category), h("div", { class: "sub" }, c.products + " products")),
                            h("div", { class: "price" }, Duka.fmt.ugx(c.costValue), h("small", {}, "sells for " + Duka.fmt.ugx(c.retailValue))));
                    })));
        } catch (error) {
            valueBox.replaceChildren(h("p", { class: "form-error" }, error.message));
        }
    }

    // ---------- list ----------
    function badge(text, kind) { return h("span", { class: "badge" + (kind ? " " + kind : "") }, text); }

    function row(p) {
        var badges = [];
        if (p.isOut) badges.push(badge("Out of stock", "off"));
        else if (p.isLow) badges.push(badge("Low stock", "warn"));
        if (p.isExpired) badges.push(badge("Expired", "off"));
        else if (p.expiringSoon) badges.push(badge("Expires " + Duka.fmt.date(p.expiryDate), "warn"));

        var worth = p.stockBase > 0
            ? "Worth " + Duka.fmt.ugx(p.stockBase * p.costPrice) + " at cost" + (p.retailPrice !== null ? ", " + Duka.fmt.ugx(p.stockBase * p.retailPrice) + " at selling price" : "")
            : "";
        return h("div", { class: "row" },
            h("div", { class: "grow" },
                h("div", { class: "name" }, p.name),
                h("div", { class: "sub" }, [p.categoryName, "In stock: " + Duka.fmt.stock(p.stockBase, p.units)].filter(Boolean).join(" \u00b7 ")),
                worth ? h("div", { class: "sub" }, worth) : null,
                badges.length ? h("div", { class: "badges" }, badges) : null),
            h("div", { class: "row-actions" },
                h("button", { type: "button", class: "btn ghost small", onclick: function () { adjust(p); } }, "Adjust"),
                h("a", { class: "btn ghost small", href: "/stock-movements.html?productId=" + p.id }, "History")));
    }

    async function load(reset) {
        var mine = ++requestId;
        if (reset) { pageNo = 1; more.hidden = true; list.replaceChildren(h("p", { class: "empty" }, "Loading...")); }
        var query = new URLSearchParams({ page: pageNo, limit: 30 });
        if (search.value.trim()) query.set("search", search.value.trim());
        if (category.value) query.set("categoryId", category.value);
        if (view !== "all") query.set("filter", view);
        try {
            var data = await Duka.api("/api/products?" + query.toString());
            if (mine !== requestId) return;
            if (reset) list.replaceChildren();
            data.products.forEach(function (p) { list.appendChild(row(p)); });
            if (data.total === 0) list.replaceChildren(h("p", { class: "empty" }, view === "all" && !search.value.trim() ? "No products yet." : "No products match."));
            summary.textContent = data.total + (data.total === 1 ? " product" : " products");
            more.hidden = !data.hasMore;
            more.textContent = "Show more (" + (data.total - data.page * data.limit) + " left)";
        } catch (error) {
            if (mine !== requestId) return;
            list.replaceChildren(h("p", { class: "form-error" }, error.message),
                h("button", { type: "button", class: "btn ghost", onclick: function () { load(true); } }, "Try again"));
        }
    }

    var timer;
    search.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(function () { load(true); }, 250); });
    category.addEventListener("change", function () { load(true); });
    viewSelect.addEventListener("change", function () { view = viewSelect.value; loadSummary(); load(true); });
    more.addEventListener("click", function () { pageNo++; load(false); });

    // ---------- adjust: damaged / expired / lost goes out, found stock comes in ----------
    var REASONS = {
        out: [["damaged", "Damaged"], ["expired", "Expired"], ["lost", "Lost or stolen"], ["other", "Other (write why)"]],
        in: [["found", "Found extra stock"], ["other", "Other (write why)"]]
    };

    function adjust(p) {
        var uuid = Duka.uuid(); // one id for this change, so pressing Save twice cannot change stock twice
        var direction = "out";
        var units = sortedUnits(p);
        var out = h("button", { type: "button", class: "seg on" }, "Take out");
        var inn = h("button", { type: "button", class: "seg" }, "Add");
        var qty = numInput({ min: "1", "aria-label": "Quantity" });
        var unit = h("select", { class: "input", "aria-label": "Unit" }, units.map(function (u) { return h("option", { value: String(u.id) }, u.name); }));
        var reason = h("select", { class: "input", "aria-label": "Reason" });
        var note = h("input", { class: "input", type: "text", maxlength: "300", placeholder: "Note", "aria-label": "Note" });
        var preview = h("p", { class: "help" });
        var errorBox = h("p", { class: "form-error", role: "alert", hidden: true });
        var cancel = h("button", { type: "button", class: "btn ghost" }, "Cancel");
        var save = h("button", { type: "button", class: "btn" }, "Save");

        function factor() { return units.filter(function (u) { return String(u.id) === unit.value; })[0].factor; }
        function fillReasons() {
            reason.replaceChildren.apply(reason, REASONS[direction].map(function (r) { return h("option", { value: r[0] }, r[1]); }));
        }
        function update() {
            var q = parseInt(qty.value, 10) || 0;
            var change = (direction === "out" ? -1 : 1) * q * factor();
            preview.textContent = q > 0
                ? "Stock now " + Duka.fmt.stock(p.stockBase, p.units) + "  \u2192  after " + Duka.fmt.stock(p.stockBase + change, p.units)
                : "Stock now: " + Duka.fmt.stock(p.stockBase, p.units);
        }
        function setDirection(next) {
            direction = next;
            out.classList.toggle("on", next === "out");
            inn.classList.toggle("on", next === "in");
            fillReasons();
            update();
        }
        out.addEventListener("click", function () { setDirection("out"); });
        inn.addEventListener("click", function () { setDirection("in"); });
        qty.addEventListener("input", update);
        unit.addEventListener("change", update);
        fillReasons();
        update();

        var modal = Duka.modal(h("div", {},
            h("h2", {}, "Adjust " + p.name),
            h("div", { class: "seg-group" }, out, inn),
            h("div", { class: "pair" }, h("div", { class: "field" }, h("label", {}, "How many"), qty), h("div", { class: "field" }, h("label", {}, "Unit"), unit)),
            h("div", { class: "field" }, h("label", {}, "Reason"), reason),
            h("div", { class: "field" }, h("label", {}, "Note (needed for \"Other\")"), note),
            preview, errorBox,
            h("div", { class: "actions" }, cancel, save)), { sticky: true });
        cancel.addEventListener("click", function () { modal.close(); });
        qty.focus();

        save.addEventListener("click", async function () {
            errorBox.hidden = true;
            if (!(parseInt(qty.value, 10) > 0)) { errorBox.textContent = "Enter how many."; errorBox.hidden = false; return; }
            Duka.busy(save, true, "Saving...");
            try {
                await Duka.api("/api/stock/adjustments", {
                    method: "POST", safeToRetry: true,
                    body: { clientUuid: uuid, productId: p.id, unitId: Number(unit.value), quantity: parseInt(qty.value, 10),
                            direction: direction, reason: reason.value, note: note.value.trim() }
                });
                modal.close();
                Duka.toast("Stock updated");
                loadSummary();
                load(true);
            } catch (error) {
                errorBox.textContent = error.message;
                errorBox.hidden = false;
                Duka.busy(save, false);
            }
        });
    }

    page.main.append(h("div", {},
        h("div", { class: "page-head" }, h("h1", {}, "Stock")),
        h("div", { class: "page-actions" },
            h("a", { class: "btn", href: "/purchase-form.html" }, "Receive stock"),
            h("a", { class: "btn ghost", href: "/stock-take.html" }, "Stock-take"),
            h("a", { class: "btn ghost", href: "/stock-movements.html" }, "Movement log")),
        alertsBox, valueBox,
        h("div", { class: "toolbar" }, search, category, viewSelect),
        summary, list, more));

    Duka.api("/api/categories").then(function (data) {
        data.categories.forEach(function (c) { category.appendChild(h("option", { value: String(c.id) }, c.name)); });
    }).catch(function () { /* the filter stays on "All categories" */ });

    loadSummary();
    load(true);
})();
