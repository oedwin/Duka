/* pos.js - the till. Search or scan, tap to add, change unit / quantity / price,
   choose a customer, take payment (cash, mobile money, bank, or credit), print the receipt.

   Safety: every sale has its own unique id (state.uuid) made BEFORE the first tap on
   "Complete sale" and kept until the sale is saved. Pressing the button twice, or retrying
   after a bad connection, therefore cannot save the sale twice. The cart is also kept on
   this phone, so a refresh does not lose it. */
(async function () {
    "use strict";
    var h = Duka.h;
    var page = await Duka.initPage({ title: "Sell" });
    var user = page.user;
    var STORE = "duka_cart";

    var allowNegative = false;
    try { allowNegative = (await Duka.api("/api/settings")).settings.allowNegativeStock; } catch (e) { /* the server still checks */ }

    var state = {
        cart: [], customer: null, saleType: "retail",
        discountType: "amount", discountValue: "",
        uuid: Duka.uuid(), heldId: null
    };
    var lineKey = 0;
    var lastResults = [];
    var searchId = 0;

    // ---------- small helpers ----------
    function sortedUnits(product) { return product.units.slice().sort(function (a, b) { return a.factor - b.factor; }); }
    function retailShown(product) {
        var base = sortedUnits(product)[0];
        var price = product.prices.filter(function (p) { return p.unitId === base.id && p.level === "retail" && !p.customerId; })[0];
        return price ? price.price : null;
    }
    function numInput(attrs) {
        return h("input", Object.assign({ class: "input", type: "number", inputmode: "numeric", min: "0", step: "1" }, attrs || {}));
    }
    function customerId() { return state.customer ? state.customer.id : null; }

    // ---------- totals ----------
    function subtotal() { return state.cart.reduce(function (sum, l) { return sum + l.qty * l.price; }, 0); }
    function discountAmount() {
        var sub = subtotal();
        var value = Number(state.discountValue);
        if (!(value > 0)) return 0;
        if (state.discountType === "percent") return Math.round((sub * Math.min(value, 100)) / 100);
        return Math.min(Math.round(value), sub);
    }
    function total() { return subtotal() - discountAmount(); }

    // ---------- the page skeleton ----------
    var search = h("input", {
        class: "input", id: "search", type: "search", autocomplete: "off",
        placeholder: "Search product or scan barcode", "aria-label": "Search products"
    });
    var resultsBox = h("div", { class: "card results" });

    var typeRetail = h("button", { type: "button", class: "seg" }, "Retail");
    var typeWholesale = h("button", { type: "button", class: "seg" }, "Wholesale");
    var customerButton = h("button", { type: "button", class: "btn ghost block cust-btn" });
    var linesBox = h("div", {});
    var emptyCart = h("p", { class: "empty" }, "Nothing added yet. Tap a product to add it.");

    var discountSelect = h("select", { class: "input", "aria-label": "Discount type" },
        h("option", { value: "amount" }, "UGX"), h("option", { value: "percent" }, "%"));
    var discountInput = numInput({ "aria-label": "Discount", placeholder: "0" });
    var subtotalEl = h("span", {});
    var discountRow = h("div", { class: "tot-row", hidden: true }, h("span", {}, "Discount"), h("span", {}));
    var totalEl = h("span", { class: "tot-big" });

    var holdButton = h("button", { type: "button", class: "btn ghost" }, "Hold sale");
    var heldButton = h("button", { type: "button", class: "btn ghost" }, "Held sales");
    var clearButton = h("button", { type: "button", class: "btn ghost danger" }, "Clear");
    var checkoutButton = h("button", { type: "button", class: "btn block big" }, "Take payment");

    var cartbarText = h("span", {});
    var cartbarButton = h("button", { type: "button", class: "btn small" }, "View cart");
    var pos = h("div", { class: "pos" });

    var productsPane = h("section", { class: "pane pane-products" }, search, resultsBox);
    var cartPane = h("section", { class: "pane pane-cart" },
        h("div", { class: "card" },
            h("div", { class: "seg-group", role: "group", "aria-label": "Sale type" }, typeRetail, typeWholesale),
            customerButton),
        h("div", { class: "card" }, h("h2", {}, "Cart"), emptyCart, linesBox),
        h("div", { class: "card" },
            h("div", { class: "tot-row" }, h("span", {}, "Subtotal"), subtotalEl),
            h("div", { class: "field" }, h("label", {}, "Discount"),
                h("div", { class: "pair" }, discountInput, h("div", {}, discountSelect))),
            discountRow,
            h("div", { class: "tot-row total" }, h("span", {}, "TOTAL"), totalEl)),
        checkoutButton,
        h("div", { class: "actions split" }, holdButton, heldButton, clearButton));

    pos.append(productsPane, cartPane);
    page.main.append(pos, h("div", { class: "cartbar" }, cartbarText, cartbarButton));

    // ---------- cart lines ----------
    function repriceLine(line) {
        if (line.mode !== "auto" || line.qty < 1) return;
        var picked = Duka.pricing.pick(line.product, line.unit, line.qty, state.saleType, customerId());
        line.price = picked.price;
        line.label = picked.label;
    }

    function refreshLine(line) {
        var e = line.els;
        e.unit.value = String(line.unit.id);
        if (document.activeElement !== e.qty) e.qty.value = String(line.qty);
        if (document.activeElement !== e.price) e.price.value = String(line.price);
        e.label.textContent = line.label || "";
        e.auto.hidden = line.mode === "auto";
        e.total.textContent = Duka.fmt.ugx(line.qty * line.price);
    }

    function buildLine(line) {
        var units = sortedUnits(line.product);
        var e = {
            unit: h("select", { class: "input", "aria-label": "Unit" },
                units.map(function (u) { return h("option", { value: String(u.id) }, u.name); })),
            qty: numInput({ class: "input qty-input", min: "1", "aria-label": "Quantity" }),
            price: numInput({ "aria-label": "Price per " + line.unit.name }),
            label: h("small", { class: "muted" }),
            auto: h("button", { type: "button", class: "linkish", hidden: true }, "Use suggested price"),
            total: h("strong", {}),
            warn: h("span", { class: "help bad" })
        };
        var minus = h("button", { type: "button", class: "btn ghost small qty-btn", "aria-label": "One less" }, "\u2212");
        var plus = h("button", { type: "button", class: "btn ghost small qty-btn", "aria-label": "One more" }, "+");
        var remove = h("button", { type: "button", class: "x", "aria-label": "Remove " + line.product.name }, "\u00d7");

        e.root = h("div", { class: "cart-line" },
            h("div", { class: "cl-top" }, h("div", { class: "name" }, line.product.name), remove),
            h("div", { class: "cl-controls" },
                h("div", { class: "field" }, e.unit),
                h("div", { class: "qty" }, minus, e.qty, plus)),
            h("div", { class: "field" },
                h("label", {}, "Price (UGX) for 1"), e.price, e.label, e.auto),
            h("div", { class: "cl-bottom" }, e.warn, e.total));
        line.els = e;

        function changed(reprice) {
            if (reprice) repriceLine(line);
            refreshLine(line);
            recalc();
        }
        e.unit.addEventListener("change", function () {
            line.unit = line.product.units.filter(function (u) { return String(u.id) === e.unit.value; })[0];
            changed(true);
        });
        e.qty.addEventListener("input", function () {
            var value = parseInt(e.qty.value, 10);
            line.qty = Number.isInteger(value) && value > 0 ? value : 0;
            changed(true);
        });
        e.qty.addEventListener("change", function () {
            if (line.qty < 1) { line.qty = 1; changed(true); }
        });
        minus.addEventListener("click", function () { line.qty = Math.max(1, line.qty - 1); changed(true); });
        plus.addEventListener("click", function () { line.qty += 1; changed(true); });
        e.price.addEventListener("input", function () {
            var value = Number(e.price.value);
            line.price = Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
            line.mode = "manual";
            line.label = "Price changed by hand";
            changed(false);
        });
        e.auto.addEventListener("click", function () { line.mode = "auto"; changed(true); });
        remove.addEventListener("click", function () {
            state.cart.splice(state.cart.indexOf(line), 1);
            e.root.remove();
            recalc();
        });

        refreshLine(line);
        return e.root;
    }

    function addLine(product, unit, qty, price, mode, label) {
        var line = { key: ++lineKey, product: product, unit: unit, qty: qty, price: price, mode: mode, label: label || "", els: null };
        if (mode === "auto") repriceLine(line);
        state.cart.push(line);
        linesBox.appendChild(buildLine(line));
        return line;
    }

    function addProduct(product) {
        var unit = Duka.pricing.defaultUnit(product, state.saleType);
        var existing = state.cart.filter(function (l) { return l.product.id === product.id && l.unit.id === unit.id; })[0];
        if (existing) {
            existing.qty += 1;
            repriceLine(existing);
            refreshLine(existing);
        } else {
            addLine(product, unit, 1, 0, "auto");
        }
        recalc();
        Duka.toast("Added: " + product.name);
    }

    // ---------- keep everything in step ----------
    function updateWarnings() {
        var need = {};
        state.cart.forEach(function (l) { need[l.product.id] = (need[l.product.id] || 0) + l.qty * l.unit.factor; });
        state.cart.forEach(function (l) {
            var short = need[l.product.id] > l.product.stockBase;
            l.short = short;
            l.els.warn.textContent = short
                ? "Only " + Duka.fmt.stock(Math.max(l.product.stockBase, 0), l.product.units) + " in stock"
                : "";
        });
    }

    function persist() {
        try {
            if (state.cart.length === 0 && !state.heldId) { localStorage.removeItem(STORE); return; }
            localStorage.setItem(STORE, JSON.stringify({
                user: user.id, uuid: state.uuid, heldId: state.heldId, customer: state.customer,
                saleType: state.saleType, discountType: state.discountType, discountValue: state.discountValue,
                items: state.cart.map(function (l) {
                    return { productId: l.product.id, unitId: l.unit.id, qty: l.qty, price: l.price, mode: l.mode };
                })
            }));
        } catch (e) { /* storage full or blocked: the till still works */ }
    }

    function recalc() {
        updateWarnings();
        var sub = subtotal();
        var discount = discountAmount();
        subtotalEl.textContent = Duka.fmt.ugx(sub);
        discountRow.hidden = discount === 0;
        discountRow.lastChild.textContent = "-" + Duka.fmt.ugx(discount);
        totalEl.textContent = Duka.fmt.ugx(sub - discount);

        var empty = state.cart.length === 0;
        emptyCart.hidden = !empty;
        checkoutButton.disabled = empty;
        holdButton.disabled = empty;
        clearButton.disabled = empty && !state.heldId;
        var count = state.cart.reduce(function (n, l) { return n + 1; }, 0);
        cartbarText.textContent = count + (count === 1 ? " item" : " items") + " \u00b7 " + Duka.fmt.ugx(sub - discount);

        typeRetail.classList.toggle("on", state.saleType === "retail");
        typeWholesale.classList.toggle("on", state.saleType === "wholesale");
        customerButton.textContent = state.customer
            ? state.customer.name + (state.customer.balance > 0 ? " \u00b7 owes " + Duka.fmt.ugx(state.customer.balance) : "") + "  (change)"
            : "Walk-in customer  (tap to choose)";
        persist();
    }

    function repriceAll() {
        state.cart.forEach(function (l) { repriceLine(l); refreshLine(l); });
        recalc();
    }

    typeRetail.addEventListener("click", function () { state.saleType = "retail"; repriceAll(); });
    typeWholesale.addEventListener("click", function () { state.saleType = "wholesale"; repriceAll(); });
    discountSelect.addEventListener("change", function () { state.discountType = discountSelect.value; recalc(); });
    discountInput.addEventListener("input", function () { state.discountValue = discountInput.value; recalc(); });

    function setCustomer(customer) {
        state.customer = customer;
        if (customer && customer.customerType === "wholesale") state.saleType = "wholesale";
        repriceAll();
    }

    // ---------- finding products ----------
    function renderResults() {
        if (lastResults.length === 0) {
            resultsBox.replaceChildren(h("p", { class: "empty" }, "No products found."));
            return;
        }
        resultsBox.replaceChildren.apply(resultsBox, lastResults.map(function (p) {
            var out = p.stockBase <= 0 && !allowNegative;
            var price = retailShown(p);
            return h("button", {
                type: "button", class: "row product-btn" + (out ? " disabled" : ""), disabled: out,
                onclick: function () { addProduct(p); }
            },
                h("div", { class: "grow" },
                    h("div", { class: "name" }, p.name),
                    h("div", { class: "sub" }, out ? "Out of stock" : "In stock: " + Duka.fmt.stock(p.stockBase, p.units))),
                h("div", { class: "price" },
                    price === null ? "" : Duka.fmt.ugx(price),
                    price === null ? null : h("small", {}, "per " + sortedUnits(p)[0].name)));
        }));
    }

    async function loadResults() {
        var mine = ++searchId;
        var query = new URLSearchParams();
        if (search.value.trim()) query.set("search", search.value.trim());
        if (customerId()) query.set("customerId", customerId());
        try {
            var data = await Duka.api("/api/sales/catalog?" + query.toString());
            if (mine !== searchId) return;
            lastResults = data.products;
            renderResults();
        } catch (error) {
            if (mine !== searchId) return;
            resultsBox.replaceChildren(
                h("p", { class: "form-error" }, error.message),
                h("button", { type: "button", class: "btn ghost", onclick: loadResults }, "Try again"));
        }
    }

    var searchTimer;
    search.addEventListener("input", function () { clearTimeout(searchTimer); searchTimer = setTimeout(loadResults, 250); });

    // A barcode scanner types the code and presses Enter.
    search.addEventListener("keydown", async function (event) {
        if (event.key !== "Enter") return;
        event.preventDefault();
        var code = search.value.trim();
        if (!code) return;
        try {
            var query = new URLSearchParams({ barcode: code });
            if (customerId()) query.set("customerId", customerId());
            var data = await Duka.api("/api/sales/catalog?" + query.toString());
            var found = data.products[0] || (lastResults.length === 1 ? lastResults[0] : null);
            if (!found) return Duka.toast("No product found for " + code, "error");
            if (found.stockBase <= 0 && !allowNegative) {
                Duka.toast(found.name + " is out of stock", "error");
            } else {
                addProduct(found);
            }
            search.value = "";
            loadResults();
            search.focus();
        } catch (error) {
            Duka.toast(error.message, "error");
        }
    });

    // ---------- choosing a customer ----------
    function pickCustomer(onDone) {
        var modal;
        function choose(customer) { setCustomer(customer); if (typeof onDone === "function") onDone(); modal.close(); }
        var box = h("input", { class: "input", type: "search", placeholder: "Search name or phone", autocomplete: "off", "aria-label": "Search customers" });
        var list = h("div", {});

        function render(customers) {
            list.replaceChildren.apply(list, customers.length ? customers.map(function (c) {
                var sub = [c.phoneDisplay, c.customerType === "wholesale" ? "Wholesale" : null,
                    c.balance > 0 ? "Owes " + Duka.fmt.ugx(c.balance) : null].filter(Boolean).join(" \u00b7 ");
                return h("button", { type: "button", class: "row product-btn", onclick: function () { choose(c); } },
                    h("div", { class: "grow" }, h("div", { class: "name" }, c.name), sub ? h("div", { class: "sub" }, sub) : null));
            }) : [h("p", { class: "empty" }, "No customers found.")]);
        }
        async function load() {
            var query = new URLSearchParams();
            if (box.value.trim()) query.set("search", box.value.trim());
            try { render((await Duka.api("/api/customers?" + query.toString())).customers); }
            catch (error) { list.replaceChildren(h("p", { class: "form-error" }, error.message)); }
        }
        var timer;
        box.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(load, 250); });

        // quick add
        var newName = h("input", { class: "input", type: "text", autocomplete: "off", maxlength: "150", "aria-label": "Customer name" });
        var newPhone = h("input", { class: "input", type: "tel", inputmode: "tel", placeholder: "0772 123 456 (optional)", "aria-label": "Phone" });
        var newType = h("select", { class: "input", "aria-label": "Customer type" },
            h("option", { value: "retail" }, "Retail customer"), h("option", { value: "wholesale" }, "Wholesale customer"));
        var formError = h("p", { class: "form-error", hidden: true });
        var saveNew = h("button", { type: "submit", class: "btn block" }, "Save and use");
        var form = h("form", { novalidate: true, hidden: true, class: "unit-box" },
            h("div", { class: "field" }, h("label", {}, "Name"), newName),
            h("div", { class: "field" }, h("label", {}, "Phone"), newPhone),
            h("div", { class: "field" }, newType), formError, saveNew);
        form.addEventListener("submit", async function (event) {
            event.preventDefault();
            formError.hidden = true;
            Duka.busy(saveNew, true, "Saving...");
            try {
                var data = await Duka.api("/api/customers", {
                    method: "POST", body: { name: newName.value, phone: newPhone.value, customerType: newType.value }
                });
                choose(data.customer);
            } catch (error) {
                formError.textContent = error.message;
                formError.hidden = false;
                Duka.busy(saveNew, false);
            }
        });

        var addButton = h("button", { type: "button", class: "btn ghost block", onclick: function () { form.hidden = !form.hidden; if (!form.hidden) newName.focus(); } }, "+ New customer");
        var walkin = h("button", { type: "button", class: "btn ghost block", onclick: function () { choose(null); } }, "Walk-in customer (no name)");
        modal = Duka.modal(h("div", {}, h("h2", {}, "Customer"), box, list, walkin, addButton, form));
        load();
    }
    customerButton.addEventListener("click", function () { pickCustomer(); });

    // ---------- held sales ----------
    async function refreshHeldCount() {
        try {
            var data = await Duka.api("/api/sales/held");
            heldButton.textContent = data.held.length ? "Held sales (" + data.held.length + ")" : "Held sales";
        } catch (e) { /* not important */ }
    }

    async function fillCart(items) {
        var ids = [];
        items.forEach(function (i) { if (ids.indexOf(i.productId) === -1) ids.push(i.productId); });
        var products = new Map();
        if (ids.length) {
            var data = await Duka.api("/api/sales/catalog?limit=100&ids=" + ids.join(",") + (customerId() ? "&customerId=" + customerId() : ""));
            data.products.forEach(function (p) { products.set(p.id, p); });
        }
        state.cart = [];
        linesBox.replaceChildren();
        var skipped = 0;
        items.forEach(function (i) {
            var product = products.get(i.productId);
            var unit = product && product.units.filter(function (u) { return u.id === i.unitId; })[0];
            if (!unit) { skipped++; return; }
            addLine(product, unit, i.qty, i.price, i.mode, i.mode === "auto" ? "" : "Saved price");
        });
        recalc();
        if (skipped) Duka.toast(skipped + " product(s) are no longer available and were left out.", "error");
    }

    async function resumeHeld(id) {
        var sale = (await Duka.api("/api/sales/" + id)).sale;
        state.customer = sale.customer ? { id: sale.customer.id, name: sale.customer.name, balance: sale.customer.balance, customerType: null } : null;
        state.saleType = sale.saleType;
        state.discountType = "amount";
        state.discountValue = sale.discountAmount > 0 ? String(sale.discountAmount) : "";
        discountSelect.value = "amount";
        discountInput.value = state.discountValue;
        state.heldId = sale.id;
        state.uuid = Duka.uuid();
        await fillCart(sale.items.map(function (i) {
            return { productId: i.productId, unitId: i.unitId, qty: i.quantity, price: i.unitPrice, mode: "manual" };
        }));
    }

    async function openHeld() {
        var list = h("div", {}, h("p", { class: "empty" }, "Loading..."));
        var modal = Duka.modal(h("div", {}, h("h2", {}, "Held sales"), list));

        async function load() {
            try {
                var data = await Duka.api("/api/sales/held");
                heldButton.textContent = data.held.length ? "Held sales (" + data.held.length + ")" : "Held sales";
                list.replaceChildren.apply(list, data.held.length ? data.held.map(function (s) {
                    return h("div", { class: "row" },
                        h("div", { class: "grow" },
                            h("div", { class: "name" }, (s.customerName || "Walk-in") + " \u00b7 " + Duka.fmt.ugx(s.total)),
                            h("div", { class: "sub" }, s.itemCount + " items \u00b7 " + Duka.fmt.dateTime(s.createdAt))),
                        h("div", { class: "actions" },
                            h("button", { type: "button", class: "btn small", onclick: async function () {
                                if (state.cart.length) {
                                    var ok = await Duka.dialog({ title: "Replace the current sale?", message: "The items in your cart now will be removed. Put them on hold first if you want to keep them.", confirmText: "Replace", danger: true });
                                    if (!ok) return;
                                }
                                try { await resumeHeld(s.id); modal.close(); showCart(); } catch (error) { Duka.toast(error.message, "error"); }
                            } }, "Resume"),
                            h("button", { type: "button", class: "btn ghost small danger", onclick: async function () {
                                var ok = await Duka.dialog({ title: "Remove this held sale?", message: "It was never sold, so nothing else changes.", confirmText: "Remove", danger: true });
                                if (!ok) return;
                                try { await Duka.api("/api/sales/held/" + s.id, { method: "DELETE" }); if (state.heldId === s.id) state.heldId = null; load(); }
                                catch (error) { Duka.toast(error.message, "error"); }
                            } }, "Remove")));
                }) : [h("p", { class: "empty" }, "No held sales.")]);
            } catch (error) {
                list.replaceChildren(h("p", { class: "form-error" }, error.message));
            }
        }
        load();
    }
    heldButton.addEventListener("click", openHeld);

    // ---------- building what the server needs ----------
    function buildPayload(status) {
        var payload = {
            clientUuid: state.uuid, status: status, saleType: state.saleType, customerId: customerId(),
            items: state.cart.map(function (l) {
                return { productId: l.product.id, unitId: l.unit.id, quantity: l.qty, unitPrice: l.price };
            }),
            discount: discountAmount() > 0 ? { type: state.discountType, value: Number(state.discountValue) } : null
        };
        if (state.heldId) payload.resumeHeldId = state.heldId;
        return payload;
    }

    function resetSale() {
        state.cart = [];
        state.customer = null;
        state.heldId = null;
        state.discountValue = "";
        state.uuid = Duka.uuid();
        discountInput.value = "";
        linesBox.replaceChildren();
        recalc();
        refreshHeldCount();
    }

    function cartProblem() {
        if (state.cart.length === 0) return "Add a product first.";
        for (var i = 0; i < state.cart.length; i++) {
            var l = state.cart[i];
            if (l.qty < 1) return "Check the quantity of " + l.product.name + ".";
        }
        if (!allowNegative && state.cart.some(function (l) { return l.short; })) {
            return "Some products do not have enough stock. Lower the quantity first.";
        }
        return null;
    }

    holdButton.addEventListener("click", async function () {
        var problem = state.cart.length === 0 ? "Add a product first." : state.cart.some(function (l) { return l.qty < 1; }) ? "Check the quantities." : null;
        if (problem) return Duka.toast(problem, "error");
        Duka.busy(holdButton, true, "Holding...");
        try {
            await Duka.api("/api/sales", { method: "POST", body: buildPayload("held"), safeToRetry: true });
            Duka.toast("Sale put on hold");
            resetSale();
        } catch (error) {
            Duka.toast(error.message, "error");
        }
        Duka.busy(holdButton, false);
    });

    clearButton.addEventListener("click", async function () {
        var ok = await Duka.dialog({ title: "Clear this sale?", message: "Everything in the cart will be removed.", confirmText: "Clear", danger: true });
        if (!ok) return;
        if (state.heldId) state.heldId = null; // the held copy stays in the held list
        resetSale();
    });

    // ---------- taking payment ----------
    function openCheckout() {
        var problem = cartProblem();
        if (problem) return Duka.toast(problem, "error");

        var due = total();
        var flags = {};
        var rows = [];
        var rowsBox = h("div", {});
        var paidEl = h("strong", {});
        var creditEl = h("strong", {});
        var noteEl = h("p", { class: "help" });
        var errorBox = h("p", { class: "form-error", role: "alert", hidden: true });
        var given = numInput({ "aria-label": "Cash given by the customer", placeholder: "e.g. 50000" });
        var changeEl = h("p", { class: "help good" });
        var custEl = h("p", { class: "muted" });
        var notes = h("input", { class: "input", type: "text", maxlength: "300", placeholder: "Note (optional)", "aria-label": "Note" });
        var cancel = h("button", { type: "button", class: "btn ghost" }, "Cancel");
        var complete = h("button", { type: "button", class: "btn big" }, "Complete sale");
        var modal;

        function amountOf(row) { return parseInt(row.amount.value, 10) || 0; }

        function update() {
            var paid = rows.reduce(function (s, r) { return s + amountOf(r); }, 0);
            var left = due - paid;
            custEl.textContent = state.customer ? "Customer: " + state.customer.name : "Customer: walk-in";
            chooseCustomer.hidden = !!state.customer;
            paidEl.textContent = Duka.fmt.ugx(paid);
            creditEl.textContent = Duka.fmt.ugx(Math.max(left, 0));
            noteEl.className = "help";
            if (left > 0) {
                noteEl.textContent = state.customer
                    ? Duka.fmt.ugx(left) + " will be written down as owed by " + state.customer.name + "."
                    : "Choose a customer to sell on credit, or take the full payment.";
                if (!state.customer) noteEl.className = "help bad";
            } else if (left < 0) {
                noteEl.textContent = "The payments are " + Duka.fmt.ugx(-left) + " more than the total.";
                noteEl.className = "help bad";
            } else {
                noteEl.textContent = "";
            }
            var cashApplied = rows.filter(function (r) { return r.method.value === "cash"; })
                .reduce(function (s, r) { return s + amountOf(r); }, 0);
            var gave = parseInt(given.value, 10) || 0;
            changeEl.textContent = gave > cashApplied && cashApplied > 0
                ? "Change to give back: " + Duka.fmt.ugx(gave - cashApplied) : "";
        }

        function addRow(method, amount) {
            var row = {
                method: h("select", { class: "input", "aria-label": "Payment method" },
                    h("option", { value: "cash" }, "Cash"),
                    h("option", { value: "mobile_money" }, "Mobile Money"),
                    h("option", { value: "bank" }, "Bank")),
                amount: numInput({ "aria-label": "Amount", placeholder: "Amount" }),
                provider: h("select", { class: "input", "aria-label": "Mobile money network" },
                    h("option", { value: "mtn" }, "MTN"), h("option", { value: "airtel" }, "Airtel")),
                reference: h("input", { class: "input", type: "text", maxlength: "80", placeholder: "Reference number", "aria-label": "Reference number" })
            };
            row.method.value = method || "cash";
            if (amount) row.amount.value = String(amount);
            var extra = h("div", { class: "pair" }, row.provider, row.reference);
            var remove = h("button", { type: "button", class: "btn ghost small danger" }, "Remove");
            row.el = h("div", { class: "unit-box" },
                h("div", { class: "pair" }, row.method, row.amount), extra, remove);
            function showExtra() { extra.hidden = row.method.value !== "mobile_money"; }
            showExtra();
            row.method.addEventListener("change", function () { showExtra(); update(); });
            row.amount.addEventListener("input", update);
            remove.addEventListener("click", function () { rows.splice(rows.indexOf(row), 1); row.el.remove(); update(); });
            rows.push(row);
            rowsBox.appendChild(row.el);
            update();
        }
        given.addEventListener("input", update);

        var fullCash = h("button", { type: "button", class: "btn ghost small" }, "Full amount, cash");
        fullCash.addEventListener("click", function () { rows.splice(0).forEach(function (r) { r.el.remove(); }); addRow("cash", due); });
        var allCredit = h("button", { type: "button", class: "btn ghost small" }, "Pay later (credit)");
        allCredit.addEventListener("click", function () { rows.splice(0).forEach(function (r) { r.el.remove(); }); update(); });
        var addPayment = h("button", { type: "button", class: "btn ghost small" }, "+ Another payment");
        addPayment.addEventListener("click", function () {
            var paid = rows.reduce(function (s, r) { return s + amountOf(r); }, 0);
            addRow("cash", Math.max(due - paid, 0) || undefined);
        });
        var chooseCustomer = h("button", { type: "button", class: "btn ghost small" }, "Choose customer");
        chooseCustomer.addEventListener("click", function () { pickCustomer(update); });

        function fail(message) { errorBox.textContent = message; errorBox.hidden = false; errorBox.scrollIntoView({ block: "nearest" }); }

        async function send() {
            errorBox.hidden = true;
            var payments = [];
            for (var i = 0; i < rows.length; i++) {
                var r = rows[i];
                var amount = amountOf(r);
                if (amount <= 0) continue;
                payments.push({
                    method: r.method.value, amount: amount,
                    provider: r.method.value === "mobile_money" ? r.provider.value : undefined,
                    reference: r.method.value === "mobile_money" ? r.reference.value.trim() : undefined
                });
            }
            var paid = payments.reduce(function (s, p) { return s + p.amount; }, 0);
            if (paid > due) return fail("The payments are more than the total. Please correct the amounts.");
            if (paid < due && !state.customer) return fail("Choose a customer to sell on credit, or take the full payment.");

            var payload = buildPayload("completed");
            payload.payments = payments;
            payload.notes = notes.value.trim() || undefined;
            Object.assign(payload, flags);

            Duka.busy(complete, true, "Saving...");
            cancel.disabled = true;
            try {
                var data = await Duka.api("/api/sales", { method: "POST", body: payload, safeToRetry: true, timeout: 30000 });
                try { localStorage.removeItem(STORE); } catch (e) { /* ignore */ }
                window.location.href = "/receipt.html?id=" + data.sale.id + "&new=1";
            } catch (error) {
                Duka.busy(complete, false);
                cancel.disabled = false;
                if (error.code === "BELOW_COST") {
                    var yes = await Duka.dialog({
                        title: "Selling below cost",
                        message: "You are selling for less than it cost you: " + (error.details || []).join(", ") + ". Sell anyway?",
                        confirmText: "Sell anyway", danger: true
                    });
                    if (yes) { flags.allowBelowCost = true; send(); }
                } else if (error.code === "CREDIT_LIMIT" && error.details && error.details.canOverride) {
                    var go = await Duka.dialog({ title: "Over the credit limit", message: error.message + " Allow it?", confirmText: "Allow", danger: true });
                    if (go) { flags.allowOverCreditLimit = true; send(); }
                } else if (error.network) {
                    fail("We could not confirm the sale because of the connection. Press Complete sale again: it is safe and will not be saved twice.");
                } else {
                    fail(error.message);
                }
            }
        }
        complete.addEventListener("click", send);

        cancel.addEventListener("click", function () { modal.close(); });
        addRow("cash", due);

        modal = Duka.modal(h("div", {},
            h("h2", {}, "Take payment"),
            h("p", { class: "stat" }, Duka.fmt.ugx(due)),
            custEl,
            h("div", { class: "actions" }, fullCash, allCredit, chooseCustomer),
            rowsBox,
            h("div", { class: "actions" }, addPayment),
            h("div", { class: "card tight" },
                h("div", { class: "tot-row" }, h("span", {}, "Paid"), paidEl),
                h("div", { class: "tot-row" }, h("span", {}, "On credit"), creditEl),
                noteEl),
            h("div", { class: "field" }, h("label", {}, "Customer gives (cash), to work out change"), given, changeEl),
            h("div", { class: "field" }, notes),
            errorBox,
            h("div", { class: "actions" }, cancel, complete)), { sticky: true, wide: true });
    }
    checkoutButton.addEventListener("click", openCheckout);

    // ---------- phone layout: switch between products and cart ----------
    function showCart() { pos.classList.add("show-cart"); cartbarButton.textContent = "Back to products"; window.scrollTo(0, 0); }
    function showProducts() { pos.classList.remove("show-cart"); cartbarButton.textContent = "View cart"; window.scrollTo(0, 0); }
    cartbarButton.addEventListener("click", function () { pos.classList.contains("show-cart") ? showProducts() : showCart(); });

    // ---------- start ----------
    recalc();
    loadResults();
    refreshHeldCount();

    // Bring back a cart that was in progress (refresh, phone call, battery died ...)
    try {
        var saved = JSON.parse(localStorage.getItem(STORE) || "null");
        if (saved && saved.user === user.id && Array.isArray(saved.items)) {
            state.customer = saved.customer || null;
            state.saleType = saved.saleType === "wholesale" ? "wholesale" : "retail";
            state.discountType = saved.discountType === "percent" ? "percent" : "amount";
            state.discountValue = saved.discountValue || "";
            state.uuid = saved.uuid || state.uuid;
            state.heldId = saved.heldId || null;
            discountSelect.value = state.discountType;
            discountInput.value = state.discountValue;
            if (saved.items.length) {
                fillCart(saved.items).then(function () { Duka.toast("Your sale in progress was restored."); }).catch(function () {});
            }
        }
    } catch (e) { /* ignore a damaged saved cart */ }

    // "Sell to this customer" on the customer page opens the till with that customer chosen.
    var presetCustomer = new URLSearchParams(window.location.search).get("customerId");
    if (presetCustomer && !state.customer) {
        Duka.api("/api/customers/" + encodeURIComponent(presetCustomer))
            .then(function (info) { setCustomer(info.customer); })
            .catch(function () { /* the customer can still be chosen by hand */ });
    }
})();
