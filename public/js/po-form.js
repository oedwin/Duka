/* po-form.js - make or change a purchase order (what you plan to buy from a supplier).
   Layout follows the purchase screen: Supplier, What to order, and the summary on the left,
   Products on the right. Low-stock products are added by themselves when you start a new order;
   remove any you do not want. An order is only a plan: it never changes stock or money.
   Cashiers use the same screen but never see prices. */
(async function () {
    "use strict";
    var h = Duka.h;
    var page = await Duka.initPage({ title: "Purchase order" });
    var isOwner = page.user.role === "owner";
    var query = new URLSearchParams(window.location.search);
    var editId = query.get("id");

    var state = { lines: [], uuid: Duka.uuid(), status: "draft", number: null, autoCount: 0 };
    var lineKey = 0;
    var searchId = 0;

    function sortedUnits(p) { return p.units.slice().sort(function (a, b) { return a.factor - b.factor; }); }
    function numInput(attrs) { return h("input", Object.assign({ class: "input", type: "number", inputmode: "numeric", min: "0", step: "1" }, attrs || {})); }
    function unitById(p, id) { return p.units.filter(function (u) { return u.id === id; })[0] || null; }
    function poNumber(n) { return "PO-" + String(n).padStart(4, "0"); }

    // ---------- an order being changed ----------
    var existing = null;
    if (editId) {
        try {
            existing = (await Duka.api("/api/orders/" + encodeURIComponent(editId))).order;
        } catch (error) {
            page.main.append(h("p", { class: "form-error" }, error.message), h("a", { class: "btn ghost", href: "/orders.html" }, "Back to orders"));
            return;
        }
        if (existing.status !== "draft" && existing.status !== "sent") {
            page.main.append(h("div", { class: "card" },
                h("h2", {}, "This order cannot be changed"),
                h("p", {}, poNumber(existing.orderNumber) + " is marked as " + existing.status + ". Reopen it first if you need to change it."),
                h("a", { class: "btn", href: "/order.html?id=" + existing.id }, "Open the order")));
            return;
        }
        state.status = existing.status;
        state.number = existing.orderNumber;
    }

    // ---------- supplier, dates ----------
    var suppliers = [];
    try { suppliers = (await Duka.api("/api/orders/suppliers")).suppliers; } catch (error) { Duka.toast(error.message, "error"); }

    var supplierSelect = h("select", { class: "input", id: "supplier", "aria-label": "Supplier" });
    function fillSuppliers(selectedId) {
        supplierSelect.replaceChildren(h("option", { value: "" }, "Not chosen yet"));
        suppliers.forEach(function (s) { supplierSelect.appendChild(h("option", { value: String(s.id) }, s.name)); });
        supplierSelect.value = selectedId ? String(selectedId) : "";
    }
    fillSuppliers(existing && existing.supplier ? existing.supplier.id : (query.get("supplierId") || ""));

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
        } catch (error) { Duka.toast(error.message, "error"); }
    }

    var dateInput = h("input", { class: "input", id: "odate", type: "date", value: existing ? existing.orderDate : Duka.fmt.today() });
    var expectedInput = h("input", { class: "input", id: "edate", type: "date", value: existing && existing.expectedDate ? existing.expectedDate : "" });

    // ---------- finding products ----------
    var search = h("input", { class: "input", type: "search", placeholder: "Search the product", autocomplete: "off", "aria-label": "Search products" });
    var results = h("div", { class: "card results" });
    var lowButton = h("button", { type: "button", class: "btn ghost small" }, "Add all low-stock items");

    async function loadResults() {
        var mine = ++searchId;
        var q = new URLSearchParams();
        if (search.value.trim()) q.set("search", search.value.trim());
        try {
            var data = await Duka.api("/api/orders/catalog?" + q.toString());
            if (mine !== searchId) return;
            results.replaceChildren.apply(results, data.products.length ? data.products.map(function (p) {
                var base = sortedUnits(p)[0];
                return h("button", { type: "button", class: "row product-btn", onclick: function () { addProduct(p); } },
                    h("div", { class: "grow" },
                        h("div", { class: "name" }, p.name),
                        h("div", { class: "sub" }, (p.isOut ? "Out of stock" : "In stock: " + Duka.fmt.stock(p.stockBase, p.units))),
                        p.isLow ? h("div", { class: "badges" }, h("span", { class: "badge warn" }, p.isOut ? "Out of stock" : "Low stock")) : null),
                    isOwner && base ? h("div", { class: "price" }, Duka.fmt.ugx(p.costPrice), h("small", {}, "cost per " + base.name)) : null);
            }) : [h("p", { class: "empty" }, "No products found. Add the product first from Products.")]);
        } catch (error) {
            if (mine !== searchId) return;
            results.replaceChildren(h("p", { class: "form-error" }, error.message));
        }
    }
    var timer;
    search.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(loadResults, 250); });

    // ---------- lines ----------
    var linesBox = h("div", {});
    var emptyLines = h("p", { class: "empty" }, "Nothing here yet. Low-stock products are added for you; you can also search and tap a product.");
    var autoNote = h("p", { class: "hint", hidden: true });
    var head = h("div", { class: "po-head", "aria-hidden": "true", hidden: true },
        [h("span", {}, "Product"), h("span", {}, "Unit"), h("span", {}, "Qty")]
            .concat(isOwner ? [h("span", {}, "Estimated cost"), h("span", {}, "Amount")] : [])
            .concat([h("span", {})]));

    function lineTotal(l) { return l.qty * l.cost; }
    function total() { return state.lines.reduce(function (sum, l) { return sum + lineTotal(l); }, 0); }

    function addLine(product, o) {
        o = o || {};
        var units = sortedUnits(product);
        var unit = o.unit || units[units.length - 1];       // you usually buy by the biggest unit
        var l = {
            key: ++lineKey, product: product, unit: unit, qty: o.qty || 1, auto: !!o.auto, touched: o.cost !== undefined, els: null,
            cost: o.cost !== undefined ? o.cost : (product.costPrice || 0) * unit.factor
        };

        var unitSelect = h("select", { class: "input", "aria-label": "Unit for " + product.name },
            units.map(function (u) { return h("option", { value: String(u.id) }, u.name); }));
        unitSelect.value = String(unit.id);
        var qty = numInput({ min: "1", value: String(l.qty), "aria-label": "How many " + product.name });
        var els = { qty: qty };
        var remove = h("button", { type: "button", class: "x", "aria-label": "Remove " + product.name }, "×");

        var cells = [
            h("div", { class: "po-name" },
                h("div", { class: "name" }, product.name),
                h("div", { class: "sub" }, "In stock: " + Duka.fmt.stock(product.stockBase, product.units)),
                l.auto ? h("div", { class: "badges" }, h("span", { class: "badge warn" }, "Low stock")) : null),
            h("div", { class: "po-unit" }, h("span", { class: "pr-lab" }, "Unit"), unitSelect),
            h("div", { class: "po-qty" }, h("span", { class: "pr-lab" }, "How many"), qty)
        ];
        var cost = null;
        if (isOwner) {
            cost = numInput({ value: String(l.cost), "aria-label": "Estimated cost for 1 " + product.name });
            els.total = h("strong", { class: "po-amount" });
            cells.push(h("div", { class: "po-cost" }, h("span", { class: "pr-lab" }, "Estimated cost (UGX) for 1"), cost), els.total);
        }
        cells.push(remove);
        var root = h("div", { class: "cart-line po-line" }, h("div", { class: "po-row" }, cells));
        els.root = root;
        l.els = els;

        function refresh() { if (isOwner) els.total.textContent = Duka.fmt.ugx(lineTotal(l)); updateSummary(); }

        unitSelect.addEventListener("change", function () {
            l.unit = units.filter(function (u) { return String(u.id) === unitSelect.value; })[0];
            if (isOwner && !l.touched) { l.cost = (product.costPrice || 0) * l.unit.factor; cost.value = String(l.cost); }
            refresh();
        });
        qty.addEventListener("input", function () { var v = parseInt(qty.value, 10); l.qty = Number.isInteger(v) && v > 0 ? v : 0; refresh(); });
        qty.addEventListener("focus", function () { qty.select(); });
        if (cost) cost.addEventListener("input", function () { var v = Number(cost.value); l.cost = Number.isFinite(v) && v >= 0 ? Math.round(v) : 0; l.touched = true; refresh(); });
        remove.addEventListener("click", function () { state.lines.splice(state.lines.indexOf(l), 1); root.remove(); updateSummary(); });

        state.lines.push(l);
        linesBox.appendChild(root);
        refresh();
        return l;
    }

    function addProduct(product) {
        var units = sortedUnits(product);
        var unit = units[units.length - 1];
        var same = state.lines.filter(function (l) { return l.product.id === product.id && l.unit.id === unit.id; })[0];
        if (same) {
            same.qty += 1;
            same.els.qty.value = String(same.qty);
            same.els.qty.dispatchEvent(new Event("input"));
        } else {
            addLine(product, { unit: unit });
        }
        Duka.toast("Added: " + product.name);
    }

    /* Adds every low-stock product that is not on the order yet, with a suggested quantity. */
    async function addLowStock(quiet) {
        try {
            var data = await Duka.api("/api/orders/low-stock");
            var added = 0;
            data.items.forEach(function (p) {
                if (state.lines.some(function (l) { return l.product.id === p.id; })) return;
                var unit = unitById(p, p.suggestedUnitId) || sortedUnits(p)[sortedUnits(p).length - 1];
                if (!unit) return;
                addLine(p, { unit: unit, qty: p.suggestedQty, auto: true });
                added++;
            });
            state.autoCount += added;
            if (state.autoCount > 0) {
                autoNote.textContent = state.autoCount + (state.autoCount === 1 ? " low-stock product was" : " low-stock products were") +
                    " added for you with a suggested quantity. Change the quantity or tap × to remove any you do not need.";
                autoNote.hidden = false;
            }
            if (!quiet) Duka.toast(added ? added + " low-stock " + (added === 1 ? "product" : "products") + " added" : "No more low-stock products to add");
        } catch (error) {
            Duka.toast(error.message, "error");
        }
    }
    lowButton.addEventListener("click", function () { addLowStock(false); });

    // ---------- summary and saving ----------
    var totalEl = h("p", { class: "stat" });
    var countEl = h("p", { class: "muted" });
    var statusSelect = h("select", { class: "input", id: "status", "aria-label": "Status" },
        h("option", { value: "draft" }, "Draft (still deciding)"), h("option", { value: "sent" }, "Sent to the supplier"));
    statusSelect.value = state.status;
    var noteInput = h("input", { class: "input", type: "text", maxlength: "500", placeholder: "Note for the supplier (optional)", "aria-label": "Note", value: existing ? existing.note : "" });
    var errorBox = h("p", { class: "form-error", role: "alert", hidden: true });
    var save = h("button", { type: "button", class: "btn block big" }, "Save order");
    var savePrint = h("button", { type: "button", class: "btn ghost block" }, "Save and print");

    function updateSummary() {
        var n = state.lines.length;
        emptyLines.hidden = n > 0;
        head.hidden = n === 0;
        countEl.textContent = n + (n === 1 ? " product" : " products") + " on this order";
        if (isOwner) totalEl.textContent = "Estimated total: " + Duka.fmt.ugx(total());
    }

    function fail(message) { errorBox.textContent = message; errorBox.hidden = false; errorBox.scrollIntoView({ block: "center" }); }

    async function submit(button, thenPrint) {
        errorBox.hidden = true;
        if (state.lines.length === 0) return fail("Add at least one product to the order.");
        for (var i = 0; i < state.lines.length; i++) {
            if (state.lines[i].qty < 1) return fail("Check the quantity of " + state.lines[i].product.name + ".");
        }
        var payload = {
            clientUuid: state.uuid,
            supplierId: supplierSelect.value ? Number(supplierSelect.value) : null,
            orderDate: dateInput.value || null,
            expectedDate: expectedInput.value || null,
            status: statusSelect.value,
            note: noteInput.value.trim(),
            items: state.lines.map(function (l) {
                var item = { productId: l.product.id, unitId: l.unit.id, quantity: l.qty, autoAdded: l.auto };
                if (isOwner) item.unitCost = l.cost;
                return item;
            })
        };
        Duka.busy(button, true, "Saving...");
        save.disabled = true; savePrint.disabled = true;
        try {
            var data = await Duka.api(existing ? "/api/orders/" + existing.id : "/api/orders", {
                method: existing ? "PUT" : "POST", body: payload, safeToRetry: true, timeout: 30000
            });
            Duka.flash("Order saved.");
            window.location.href = "/order.html?id=" + data.order.id + (thenPrint ? "&print=1" : "");
        } catch (error) {
            Duka.busy(button, false);
            save.disabled = false; savePrint.disabled = false;
            fail(error.network ? "We could not confirm the order because of the connection. Press Save again: it is safe and will not be saved twice." : error.message);
        }
    }
    save.addEventListener("click", function () { submit(save, false); });
    savePrint.addEventListener("click", function () { submit(savePrint, true); });

    // ---------- the page ----------
    page.main.append(h("div", { class: "pf-wrap" },
        h("p", {}, h("a", { href: existing ? "/order.html?id=" + existing.id : "/orders.html" }, existing ? "← Back to the order" : "← Back to orders")),
        h("div", { class: "page-head" },
            h("h1", {}, existing ? "Change " + poNumber(existing.orderNumber) : "New purchase order"),
            h("p", {}, "What you plan to buy from a supplier. Saving an order does not change your stock.")),
        h("div", { class: "pf" },
            h("div", { class: "card pf-supplier" },
                h("h2", {}, "Supplier"),
                h("div", { class: "field" }, supplierSelect,
                    isOwner ? h("div", {}, h("button", { type: "button", class: "btn ghost small", onclick: newSupplier }, "New supplier")) : null),
                h("div", { class: "pair" },
                    h("div", { class: "field" }, h("label", { for: "odate" }, "Order date"), dateInput),
                    h("div", { class: "field" }, h("label", { for: "edate" }, "Expected delivery (optional)"), expectedInput))),
            h("div", { class: "card pf-products" },
                h("h2", {}, "Products"),
                h("div", { class: "field" }, lowButton),
                search, results),
            h("div", { class: "card pf-received po-table" + (isOwner ? "" : " nocost") },
                h("h2", {}, "What to order"), autoNote, emptyLines, head, linesBox),
            h("div", { class: "card pf-payment" },
                h("h2", {}, "Order summary"),
                totalEl, countEl,
                isOwner ? h("p", { class: "help" }, "Costs are estimates taken from your cost prices. Change them if the supplier quotes differently.") : null,
                h("div", { class: "field" }, h("label", { for: "status" }, "Status"), statusSelect),
                h("div", { class: "field" }, noteInput),
                errorBox, save, h("div", { class: "po-gap" }), savePrint))));

    updateSummary();
    loadResults();

    if (existing) {
        existing.items.forEach(function (i) {
            if (!i.product) return;
            var unit = unitById(i.product, i.unitId);
            if (!unit) return;
            addLine(i.product, { unit: unit, qty: i.quantity, cost: isOwner ? i.unitCost : undefined, auto: i.autoAdded });
        });
        updateSummary();
    } else if (query.get("blank") !== "1") {
        await addLowStock(true);      // a new order starts with the low-stock products already on it
    }
})();
