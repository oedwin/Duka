/* stock-take.js - count what is really on the shelf and let Duka correct the system.
   Type the counted amount next to each product you counted. Products you leave empty are not touched. */
(async function () {
    "use strict";
    var h = Duka.h;
    var page = await Duka.initPage({ title: "Stock-take", roles: ["owner"] });

    var counts = new Map(); // productId -> { productId, name, system, base, qty, unitId }
    var uuid = Duka.uuid(); // one id for this stock-take, so saving twice cannot count twice
    var pageNo = 1;
    var requestId = 0;
    var shownSystem = new Map(); // what the system said when we showed the row

    function sortedUnits(p) { return p.units.slice().sort(function (a, b) { return a.factor - b.factor; }); }

    var search = h("input", { class: "input", type: "search", placeholder: "Search product or barcode", autocomplete: "off", "aria-label": "Search products" });
    var list = h("div", { class: "card" });
    var more = h("button", { type: "button", class: "btn ghost block", hidden: true }, "Show more");
    var note = h("input", { class: "input", type: "text", maxlength: "300", placeholder: "Note (optional), e.g. Monthly count", "aria-label": "Note" });
    var countedText = h("strong", {}, "0 products counted");
    var errorBox = h("p", { class: "form-error", role: "alert", hidden: true });
    var save = h("button", { type: "button", class: "btn block big", disabled: true }, "Save stock-take");
    var result = h("div", {});

    function updateBar() {
        countedText.textContent = counts.size + (counts.size === 1 ? " product counted" : " products counted");
        save.disabled = counts.size === 0;
    }

    function row(p) {
        var units = sortedUnits(p);
        var saved = counts.get(p.id);
        shownSystem.set(p.id, p.stockBase);

        var qty = h("input", { class: "input qty-input", type: "number", inputmode: "numeric", min: "0", step: "1", placeholder: "Counted", "aria-label": "Counted quantity for " + p.name,
            value: saved ? String(saved.qty) : "" });
        var unit = h("select", { class: "input", "aria-label": "Unit" }, units.map(function (u) { return h("option", { value: String(u.id) }, u.name); }));
        if (saved) unit.value = String(saved.unitId);
        var diff = h("div", { class: "sub" });

        function update() {
            var raw = qty.value.trim();
            if (raw === "") { counts.delete(p.id); diff.textContent = ""; diff.className = "sub"; updateBar(); return; }
            var n = Number(raw);
            if (!Number.isInteger(n) || n < 0) { counts.delete(p.id); diff.textContent = "Enter a whole number."; diff.className = "sub down"; updateBar(); return; }
            var u = units.filter(function (x) { return String(x.id) === unit.value; })[0];
            var base = n * u.factor;
            counts.set(p.id, { productId: p.id, name: p.name, system: p.stockBase, base: base, qty: n, unitId: u.id, units: p.units });
            var d = base - p.stockBase;
            diff.className = "sub " + (d === 0 ? "" : d > 0 ? "up" : "down");
            diff.textContent = d === 0 ? "Matches the system" : (d > 0 ? "+" : "-") + Duka.fmt.stock(Math.abs(d), p.units) + " compared with the system";
            updateBar();
        }
        qty.addEventListener("input", update);
        unit.addEventListener("change", update);
        var el = h("div", { class: "row" },
            h("div", { class: "grow" },
                h("div", { class: "name" }, p.name),
                h("div", { class: "sub" }, "System says: " + Duka.fmt.stock(p.stockBase, p.units)),
                diff),
            h("div", { class: "pair" }, qty, unit));
        if (saved) update();
        return el;
    }

    async function load(reset) {
        var mine = ++requestId;
        if (reset) { pageNo = 1; more.hidden = true; list.replaceChildren(h("p", { class: "empty" }, "Loading...")); }
        var query = new URLSearchParams({ page: pageNo, limit: 30 });
        if (search.value.trim()) query.set("search", search.value.trim());
        try {
            var data = await Duka.api("/api/products?" + query.toString());
            if (mine !== requestId) return;
            if (reset) list.replaceChildren();
            data.products.forEach(function (p) { list.appendChild(row(p)); });
            if (data.total === 0) list.replaceChildren(h("p", { class: "empty" }, "No products match."));
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
    more.addEventListener("click", function () { pageNo++; load(false); });

    save.addEventListener("click", async function () {
        errorBox.hidden = true;
        var entries = Array.from(counts.values());
        var different = entries.filter(function (c) { return c.base !== c.system; }).length;
        var ok = await Duka.dialog({
            title: "Save this stock-take?",
            message: entries.length + " products counted, " + different + " differ from the system. Stock will be changed to match your count, and every change is kept in the movement log.",
            confirmText: "Save stock-take"
        });
        if (!ok) return;

        Duka.busy(save, true, "Saving...");
        try {
            var data = await Duka.api("/api/stock/stock-take", {
                method: "POST", safeToRetry: true, timeout: 60000,
                body: { clientUuid: uuid, note: note.value.trim(), counts: entries.map(function (c) { return { productId: c.productId, countedBase: c.base }; }) }
            });
            showResult(data);
            counts.clear();
            uuid = Duka.uuid();
            updateBar();
            load(true);
        } catch (error) {
            errorBox.textContent = error.message;
            errorBox.hidden = false;
        }
        Duka.busy(save, false);
        save.disabled = counts.size === 0;
    });

    function showResult(data) {
        var changes = data.changes || [];
        result.replaceChildren(h("div", { class: "card done" },
            h("h2", {}, "Stock-take saved"),
            h("p", {}, changes.length + " product(s) corrected, " + data.unchanged + " already matched."),
            changes.map(function (c) {
                return h("div", { class: "row" },
                    h("div", { class: "grow" }, h("div", { class: "name" }, c.name), h("div", { class: "sub" }, "System had " + c.system + ", you counted " + c.counted + " (smallest unit)")),
                    h("div", { class: "price " + (c.difference > 0 ? "up" : "down") }, (c.difference > 0 ? "+" : "") + c.difference));
            }),
            h("a", { class: "btn ghost", href: "/stock.html" }, "Back to stock")));
        window.scrollTo(0, 0);
    }

    page.main.append(h("div", {},
        h("p", {}, h("a", { href: "/stock.html" }, "\u2190 Back to stock")),
        h("div", { class: "page-head" }, h("h1", {}, "Stock-take"),
            h("p", {}, "Count what is really on the shelf and type it next to each product. Leave a product empty if you did not count it.")),
        result, search, list, more,
        h("div", { class: "sticky-save" }, countedText, h("div", { class: "field" }, note), errorBox, save)));
    load(true);
})();
