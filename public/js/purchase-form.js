/* purchase-form.js - record stock you received from a supplier.
   Pick the products, say how many (in cartons, sacks, pieces...) and what each cost,
   then how much you paid now. Whatever you did not pay is written down as owed to the supplier.
   Stock goes up by itself. Pressing Save twice cannot add the stock twice. */
(async function () {
    "use strict";
    var h = Duka.h;
    var page = await Duka.initPage({ title: "Record a purchase", roles: ["owner"] });

    var presetSupplier = new URLSearchParams(window.location.search).get("supplierId") || "";
    var state = { lines: [], uuid: Duka.uuid() };
    var lineKey = 0;
    var searchId = 0;

    function sortedUnits(p) { return p.units.slice().sort(function (a, b) { return a.factor - b.factor; }); }
    function numInput(attrs) { return h("input", Object.assign({ class: "input", type: "number", inputmode: "numeric", min: "0", step: "1" }, attrs || {})); }

    // ---------- supplier, date, invoice ----------
    var suppliers = [];
    try { suppliers = (await Duka.api("/api/suppliers")).suppliers; } catch (error) { Duka.toast(error.message, "error"); }

    var supplierSelect = h("select", { class: "input", id: "supplier", "aria-label": "Supplier" });
    function fillSuppliers(selectedId) {
        supplierSelect.replaceChildren(h("option", { value: "" }, "No supplier (bought and paid on the spot)"));
        suppliers.forEach(function (s) { supplierSelect.appendChild(h("option", { value: String(s.id) }, s.name)); });
        supplierSelect.value = selectedId ? String(selectedId) : "";
    }
    fillSuppliers(presetSupplier);
    supplierSelect.addEventListener("change", updatePayment);

    async function newSupplier() {
        var values = await Duka.dialog({
            title: "New supplier", confirmText: "Add supplier",
            fields: [{ name: "name", label: "Supplier name" },
                     { name: "phone", label: "Phone number", type: "tel", inputmode: "tel", required: false }]
        });
        if (!values) return;
        try {
            var data = await Duka.api("/api/suppliers", { method: "POST", body: values });
            suppliers.push(data.supplier);
            fillSuppliers(data.supplier.id);
            updatePayment();
        } catch (error) {
            Duka.toast(error.message, "error");
        }
    }

    var dateInput = h("input", { class: "input", id: "date", type: "date", value: Duka.fmt.today() });
    var referenceInput = h("input", { class: "input", id: "reference", type: "text", maxlength: "60", placeholder: "Invoice or delivery note number (optional)" });

    // ---------- finding products ----------
    var search = h("input", { class: "input", type: "search", placeholder: "Search the product you received", autocomplete: "off", "aria-label": "Search products" });
    var results = h("div", { class: "card results" });
    var linesBox = h("div", {});
    var emptyLines = h("p", { class: "empty" }, "Search above and tap a product to add it.");

    async function loadResults() {
        var mine = ++searchId;
        var query = new URLSearchParams({ limit: 20 });
        if (search.value.trim()) query.set("search", search.value.trim());
        try {
            var data = await Duka.api("/api/products?" + query.toString());
            if (mine !== searchId) return;
            results.replaceChildren.apply(results, data.products.length ? data.products.map(function (p) {
                var base = sortedUnits(p)[0];
                return h("button", { type: "button", class: "row product-btn", onclick: function () { addLine(p); } },
                    h("div", { class: "grow" },
                        h("div", { class: "name" }, p.name),
                        h("div", { class: "sub" }, "In stock: " + Duka.fmt.stock(p.stockBase, p.units))),
                    h("div", { class: "price" }, Duka.fmt.ugx(p.costPrice), h("small", {}, "cost per " + base.name)));
            }) : [h("p", { class: "empty" }, "No products found. Add the product first from Products.")]);
        } catch (error) {
            if (mine !== searchId) return;
            results.replaceChildren(h("p", { class: "form-error" }, error.message));
        }
    }
    var timer;
    search.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(loadResults, 250); });

    // ---------- lines ----------
    function lineTotal(l) { return l.qty * l.cost; }
    function total() { return state.lines.reduce(function (sum, l) { return sum + lineTotal(l); }, 0); }

    function refreshLine(l) {
        var e = l.els;
        e.total.textContent = Duka.fmt.ugx(lineTotal(l));
        var base = sortedUnits(l.product)[0];
        var perBase = Math.round(l.cost / l.unit.factor);
        var current = l.product.costPrice;
        if (perBase === current) {
            e.note.textContent = "Cost price stays " + Duka.fmt.ugx(current) + " per " + base.name + ".";
            e.note.className = "help";
        } else {
            e.note.textContent = "Cost price " + (l.update ? "will change" : "would change") + " from " + Duka.fmt.ugx(current) + " to " + Duka.fmt.ugx(perBase) + " per " + base.name + ".";
            e.note.className = "help " + (perBase > current ? "bad" : "good");
        }
    }

    function addLine(product) {
        var units = sortedUnits(product);
        var unit = units[units.length - 1]; // you usually buy by the biggest unit
        var l = { key: ++lineKey, product: product, unit: unit, qty: 1, cost: product.costPrice * unit.factor, touched: false, update: true, els: null };

        var unitSelect = h("select", { class: "input", "aria-label": "Unit" }, units.map(function (u) { return h("option", { value: String(u.id) }, u.name); }));
        unitSelect.value = String(unit.id);
        var qty = numInput({ min: "1", value: "1", "aria-label": "Quantity" });
        var cost = numInput({ value: String(l.cost), "aria-label": "Buying price" });
        var update = h("input", { type: "checkbox", checked: true });
        var els = {
            total: h("strong", {}), note: h("span", { class: "help" }),
        };
        var remove = h("button", { type: "button", class: "x", "aria-label": "Remove " + product.name }, "\u00d7");
        var root = h("div", { class: "cart-line" },
            h("div", { class: "cl-top" }, h("div", { class: "name" }, product.name), remove),
            h("div", { class: "cl-controls" },
                h("div", { class: "field" }, h("label", {}, "Unit"), unitSelect),
                h("div", { class: "field" }, h("label", {}, "How many"), qty)),
            h("div", { class: "field" }, h("label", {}, "Buying price for 1 (UGX)"), cost),
            h("label", { class: "check" }, update, "Update this product's cost price"),
            els.note,
            h("div", { class: "cl-bottom" }, els.total));
        l.els = els;
        els.root = root;

        unitSelect.addEventListener("change", function () {
            l.unit = units.filter(function (u) { return String(u.id) === unitSelect.value; })[0];
            if (!l.touched) { l.cost = product.costPrice * l.unit.factor; cost.value = String(l.cost); }
            refreshLine(l); updatePayment();
        });
        qty.addEventListener("input", function () { var v = parseInt(qty.value, 10); l.qty = Number.isInteger(v) && v > 0 ? v : 0; refreshLine(l); updatePayment(); });
        cost.addEventListener("input", function () { var v = Number(cost.value); l.cost = Number.isFinite(v) && v >= 0 ? Math.round(v) : 0; l.touched = true; refreshLine(l); updatePayment(); });
        update.addEventListener("change", function () { l.update = update.checked; refreshLine(l); });
        remove.addEventListener("click", function () { state.lines.splice(state.lines.indexOf(l), 1); root.remove(); updatePayment(); });

        state.lines.push(l);
        linesBox.appendChild(root);
        refreshLine(l);
        updatePayment();
        Duka.toast("Added: " + product.name);
    }

    // ---------- payment ----------
    var totalEl = h("p", { class: "stat" });
    var paid = numInput({ "aria-label": "Amount paid now", placeholder: "0" });
    var method = h("select", { class: "input", "aria-label": "How you paid" },
        h("option", { value: "cash" }, "Cash"), h("option", { value: "mobile_money" }, "Mobile Money"), h("option", { value: "bank" }, "Bank"));
    var reference = h("input", { class: "input", type: "text", maxlength: "80", placeholder: "Payment reference (optional)", "aria-label": "Reference" });
    var owedEl = h("p", { class: "help" });
    var noteInput = h("input", { class: "input", type: "text", maxlength: "300", placeholder: "Note (optional)", "aria-label": "Note" });
    var errorBox = h("p", { class: "form-error", role: "alert", hidden: true });
    var save = h("button", { type: "button", class: "btn block big" }, "Save purchase");

    function updatePayment() {
        var t = total();
        emptyLines.hidden = state.lines.length > 0;
        totalEl.textContent = "Total: " + Duka.fmt.ugx(t);
        var p = parseInt(paid.value, 10) || 0;
        var owed = t - p;
        owedEl.className = "help";
        if (owed > 0) {
            owedEl.textContent = supplierSelect.value
                ? Duka.fmt.ugx(owed) + " will be written down as owed to " + supplierSelect.options[supplierSelect.selectedIndex].text + "."
                : "Choose a supplier above to buy on credit, or pay the full amount.";
            if (!supplierSelect.value) owedEl.className = "help bad";
        } else if (owed < 0) {
            owedEl.textContent = "You paid " + Duka.fmt.ugx(-owed) + " more than the total.";
            owedEl.className = "help bad";
        } else {
            owedEl.textContent = t > 0 ? "Fully paid." : "";
        }
    }
    paid.addEventListener("input", updatePayment);

    var payAll = h("button", { type: "button", class: "btn ghost small" }, "Paid in full");
    payAll.addEventListener("click", function () { paid.value = String(total()); updatePayment(); });
    var payNone = h("button", { type: "button", class: "btn ghost small" }, "Nothing paid yet (credit)");
    payNone.addEventListener("click", function () { paid.value = ""; updatePayment(); });

    function fail(message) { errorBox.textContent = message; errorBox.hidden = false; errorBox.scrollIntoView({ block: "center" }); }

    save.addEventListener("click", async function () {
        errorBox.hidden = true;
        if (state.lines.length === 0) return fail("Add at least one product you received.");
        for (var i = 0; i < state.lines.length; i++) {
            var l = state.lines[i];
            if (l.qty < 1) return fail("Check the quantity of " + l.product.name + ".");
        }
        var t = total();
        var p = parseInt(paid.value, 10) || 0;
        if (p > t) return fail("You paid more than the total. Please correct the amount.");
        if (p < t && !supplierSelect.value) return fail("Choose a supplier to buy on credit, or pay the full amount.");

        var payload = {
            clientUuid: state.uuid,
            supplierId: supplierSelect.value ? Number(supplierSelect.value) : null,
            referenceNo: referenceInput.value.trim(),
            purchaseDate: dateInput.value || null,
            note: noteInput.value.trim(),
            items: state.lines.map(function (l) {
                return { productId: l.product.id, unitId: l.unit.id, quantity: l.qty, unitCost: l.cost, updateCost: l.update };
            }),
            payment: p > 0 ? { amount: p, method: method.value, reference: reference.value.trim() } : null
        };

        Duka.busy(save, true, "Saving...");
        try {
            var data = await Duka.api("/api/purchases", { method: "POST", body: payload, safeToRetry: true, timeout: 30000 });
            Duka.flash("Purchase saved. Stock has been added.");
            window.location.href = "/purchase.html?id=" + data.purchase.id;
        } catch (error) {
            Duka.busy(save, false);
            fail(error.network
                ? "We could not confirm the purchase because of the connection. Press Save purchase again: it is safe and will not be saved twice."
                : error.message);
        }
    });

    page.main.append(h("div", {},
        h("p", {}, h("a", { href: "/stock.html" }, "\u2190 Back to stock")),
        h("div", { class: "page-head" }, h("h1", {}, "Record a purchase"), h("p", {}, "Stock you received from a supplier.")),
        h("div", { class: "card" },
            h("h2", {}, "Supplier"),
            h("div", { class: "field" }, supplierSelect, h("div", {}, h("button", { type: "button", class: "btn ghost small", onclick: newSupplier }, "New supplier"))),
            h("div", { class: "pair" },
                h("div", { class: "field" }, h("label", { for: "date" }, "Date received"), dateInput),
                h("div", { class: "field" }, h("label", { for: "reference" }, "Invoice number"), referenceInput))),
        h("div", { class: "card" },
            h("h2", {}, "Products received"),
            search, results),
        h("div", { class: "card" }, h("h2", {}, "What you received"), emptyLines, linesBox),
        h("div", { class: "card" },
            h("h2", {}, "Payment"),
            totalEl,
            h("div", { class: "actions" }, payAll, payNone),
            h("div", { class: "field" }, h("label", {}, "Paid now (UGX)"), paid),
            h("div", { class: "pair" }, h("div", { class: "field" }, method), h("div", { class: "field" }, reference)),
            owedEl,
            h("div", { class: "field" }, noteInput)),
        errorBox, save));

    updatePayment();
    loadResults();
})();
