/* product-form.js - add or edit a product.
   Quick part: name, unit, cost, selling price, opening stock.
   "More options" (closed at first): bigger units, wholesale prices, barcode, expiry, photo.
   Money is whole UGX. Stock is saved in the smallest unit; this screen does the sums. */
(async function () {
    "use strict";
    var h = Duka.h;
    var page = await Duka.initPage({ title: "Product", roles: ["owner"] });

    var editId = new URLSearchParams(window.location.search).get("id");
    var isEdit = !!editId;

    page.main.append(h("p", { class: "empty" }, "Loading..."));
    var categories, product = null;
    try {
        var loaded = await Promise.all([
            Duka.api("/api/categories"),
            isEdit ? Duka.api("/api/products/" + encodeURIComponent(editId)) : null
        ]);
        categories = loaded[0].categories;
        product = loaded[1] ? loaded[1].product : null;
    } catch (error) {
        page.main.replaceChildren(
            h("p", { class: "form-error" }, error.message),
            h("a", { class: "btn ghost", href: "/products.html" }, "Back to products"));
        return;
    }
    page.main.replaceChildren();

    // ---------- small helpers ----------
    var uid = 0;
    function numInput(id) {
        return h("input", { class: "input", id: id, type: "number", inputmode: "numeric", min: "0", step: "1" });
    }
    function labeled(text, input, help) {
        if (!input.id) input.id = "f" + (++uid);
        return h("div", { class: "field" },
            h("label", { for: input.id }, text), input,
            help ? h("span", { class: "help" }, help) : null);
    }
    function whole(input) { return input.value.trim() === "" ? null : Number(input.value); }
    function need(condition, message) { if (!condition) throw new Error(message); }

    var state = { baseId: undefined, photo: undefined, hidden: [] };

    // ---------- the quick part ----------
    var nameInput = h("input", { class: "input", id: "name", type: "text", autocomplete: "off", maxlength: "200" });
    var categorySelect = h("select", { class: "input", id: "category" });
    function fillCategories(selectedId) {
        categorySelect.replaceChildren(h("option", { value: "" }, "No category"));
        categories.forEach(function (c) { categorySelect.appendChild(h("option", { value: String(c.id) }, c.name)); });
        categorySelect.value = selectedId ? String(selectedId) : "";
    }
    async function addCategory() {
        var values = await Duka.dialog({
            title: "New category", confirmText: "Add",
            fields: [{ name: "name", label: "Category name" }]
        });
        if (!values) return;
        try {
            var data = await Duka.api("/api/categories", { method: "POST", body: { name: values.name } });
            categories.push(data.category);
            fillCategories(data.category.id);
        } catch (error) {
            Duka.toast(error.message, "error");
        }
    }

    var baseUnitInput = h("input", {
        class: "input", id: "baseUnit", type: "text", list: "unitList", value: "Piece",
        autocomplete: "off", maxlength: "50"
    });
    var unitList = h("datalist", { id: "unitList" },
        ["Piece", "Kg", "Bottle", "Pack", "Packet", "Litre", "Dozen", "Bag", "Tin", "Metre"]
            .map(function (u) { return h("option", { value: u }); }));

    var costInput = numInput("cost");
    var costUnit = h("select", { class: "input", id: "costUnit", "aria-label": "Cost is for one" });
    var costNote = h("span", { class: "help" });
    var retailInput = numInput("retail");
    var profitNote = h("span", { class: "help" });
    var stockInput = numInput("stockQty");
    var stockUnit = h("select", { class: "input", id: "stockUnit", "aria-label": "Stock counted in" });
    var stockNote = h("span", { class: "help" });

    // ---------- more options ----------
    var wholesaleInput = numInput("wholesale");
    var wholesaleMin = numInput("wholesaleMin");
    wholesaleMin.placeholder = "1";
    var reorderInput = numInput("reorder");
    var barcodeInput = h("input", { class: "input", id: "barcode", type: "text", autocomplete: "off", maxlength: "60" });
    var skuInput = h("input", { class: "input", id: "sku", type: "text", autocomplete: "off", maxlength: "60" });
    var expiryInput = h("input", { class: "input", id: "expiry", type: "date" });

    var photoPreview = h("img", { class: "logo-preview", alt: "Product photo", hidden: true });
    var photoFile = h("input", { type: "file", id: "photoFile", accept: "image/png,image/jpeg" });
    var photoRemove = h("button", { class: "btn ghost small", type: "button", hidden: true }, "Remove photo");
    photoFile.addEventListener("change", async function () {
        if (!photoFile.files[0]) return;
        try {
            state.photo = await Duka.resizeImage(photoFile.files[0], 480, true);
            photoPreview.src = state.photo;
            photoPreview.hidden = false;
            photoRemove.hidden = false;
        } catch (error) {
            Duka.toast(error.message, "error");
        }
    });
    photoRemove.addEventListener("click", function () {
        state.photo = "";
        photoPreview.hidden = true;
        photoRemove.hidden = true;
        photoFile.value = "";
    });

    // ---------- bigger units (carton, sack, pack ...) ----------
    var extras = [];
    var extrasBox = h("div", {});

    function baseName() { return baseUnitInput.value.trim() || "unit"; }

    function addExtra(data) {
        data = data || {};
        var row = {
            id: data.id,
            name: h("input", { class: "input", type: "text", autocomplete: "off", maxlength: "50", placeholder: "e.g. Carton, Sack, Pack", value: data.name || "" }),
            factor: numInput(""),
            retail: numInput(""),
            wholesale: numInput(""),
            insideLabel: h("label", {}, "")
        };
        row.factor.id = "";
        row.factor.min = "2";
        if (data.factor) row.factor.value = data.factor;
        if (data.retail) row.retail.value = data.retail;
        if (data.wholesale) row.wholesale.value = data.wholesale;
        row.factor.id = "ef" + (++uid);
        row.insideLabel.setAttribute("for", row.factor.id);

        var remove = h("button", { class: "btn ghost small danger", type: "button" }, "Remove this unit");
        remove.addEventListener("click", function () {
            extras.splice(extras.indexOf(row), 1);
            row.el.remove();
            refresh();
        });

        row.el = h("div", { class: "unit-box" },
            labeled("Unit name", row.name),
            h("div", { class: "field" }, row.insideLabel, row.factor),
            h("div", { class: "pair" },
                labeled("Selling price (retail), optional", row.retail, "Left empty = the single price \u00d7 how many inside."),
                labeled("Wholesale price, optional", row.wholesale)),
            remove);
        extras.push(row);
        extrasBox.appendChild(row.el);
        [row.name, row.factor, row.retail, row.wholesale].forEach(function (input) { input.addEventListener("input", refresh); });
        refresh();
    }

    var addUnitButton = h("button", { class: "btn ghost", type: "button", onclick: function () { addExtra(); } },
        "Add a bigger unit (carton, sack, pack...)");

    // ---------- live sums ----------
    function unitOptions() {
        var list = [{ name: baseName(), factor: 1 }];
        extras.forEach(function (r) {
            list.push({ name: r.name.value.trim() || "(new unit)", factor: Number(r.factor.value) || 0 });
        });
        return list;
    }

    function fillSelect(select) {
        var index = Math.max(0, select.selectedIndex);
        var options = unitOptions();
        select.replaceChildren.apply(select, options.map(function (o, i) { return h("option", { value: String(i) }, o.name); }));
        select.selectedIndex = Math.min(index, options.length - 1);
    }

    /* Cost per ONE base unit, from whatever unit the shopkeeper typed it for. */
    function costPerBase() {
        var amount = whole(costInput);
        if (amount === null) return { value: null, note: "" };
        var option = unitOptions()[costUnit.selectedIndex];
        if (!option || option.factor < 1) {
            return { value: null, note: "First fill in how many " + baseName() + " are inside the " + (option ? option.name : "unit") + "." };
        }
        var perBase = Math.round(amount / option.factor);
        var note = "";
        if (costUnit.selectedIndex > 0) {
            note = "That is " + Duka.fmt.ugx(perBase) + " for each " + baseName() + (perBase * option.factor === amount ? "." : " (rounded to a whole shilling).");
        }
        return { value: perBase, note: note };
    }

    function refresh() {
        extras.forEach(function (r) {
            r.insideLabel.textContent = "How many " + baseName() + " are inside 1 " + (r.name.value.trim() || "of this unit") + "?";
        });
        fillSelect(costUnit);
        fillSelect(stockUnit);

        var cost = costPerBase();
        costNote.textContent = cost.note;
        costNote.className = "help";

        var retail = whole(retailInput);
        profitNote.textContent = "";
        profitNote.className = "help";
        if (cost.value !== null && retail !== null) {
            var gain = retail - cost.value;
            profitNote.textContent = gain >= 0
                ? "Profit on each " + baseName() + ": " + Duka.fmt.ugx(gain)
                : "You would lose " + Duka.fmt.ugx(-gain) + " on each " + baseName() + ". Check the prices.";
            profitNote.className = "help " + (gain >= 0 ? "good" : "bad");
        }

        var qty = whole(stockInput);
        var stockOption = unitOptions()[stockUnit.selectedIndex];
        stockNote.textContent = qty !== null && stockOption && stockOption.factor > 0 && stockUnit.selectedIndex > 0
            ? "= " + Duka.fmt.number(qty * stockOption.factor) + " " + baseName() : "";
    }

    [baseUnitInput, costInput, retailInput, stockInput].forEach(function (i) { i.addEventListener("input", refresh); });
    [costUnit, stockUnit].forEach(function (s) { s.addEventListener("change", refresh); });

    // ---------- build what we send to the server ----------
    function buildPayload() {
        var name = nameInput.value.trim();
        need(name, "Enter the product name.");
        var base = baseUnitInput.value.trim();
        need(base, "Enter the unit you sell in, for example Piece or Kg.");

        var units = [{ id: state.baseId, name: base, factor: 1 }];
        extras.forEach(function (r) {
            var unitName = r.name.value.trim();
            var factor = whole(r.factor);
            need(unitName, "Give each bigger unit a name, or remove it.");
            need(factor !== null && Number.isInteger(factor) && factor >= 2,
                "For " + unitName + ", enter how many " + base + " are inside (2 or more).");
            units.push({ id: r.id, name: unitName, factor: factor });
        });

        need(costInput.value.trim() !== "", "Enter the cost price. It is used to work out your profit.");
        var cost = costPerBase();
        need(cost.value !== null, cost.note || "Check the cost price.");

        var retail = whole(retailInput);
        need(retail !== null && Number.isInteger(retail) && retail > 0, "Enter the selling price.");

        var prices = [{ unit: base, level: "retail", price: retail, minQty: 1 }];
        var wholesale = whole(wholesaleInput);
        if (wholesale !== null) {
            need(Number.isInteger(wholesale) && wholesale > 0, "The wholesale price must be a whole number above 0.");
            prices.push({ unit: base, level: "wholesale", price: wholesale, minQty: whole(wholesaleMin) || 1 });
        }
        extras.forEach(function (r, i) {
            var unitName = units[i + 1].name;
            var r1 = whole(r.retail);
            var w1 = whole(r.wholesale);
            if (r1 !== null) { need(r1 > 0, "Prices must be above 0."); prices.push({ unit: unitName, level: "retail", price: r1, minQty: 1 }); }
            if (w1 !== null) { need(w1 > 0, "Prices must be above 0."); prices.push({ unit: unitName, level: "wholesale", price: w1, minQty: 1 }); }
        });

        // Extra price tiers this screen cannot show: send them back unchanged so nothing is lost.
        var names = new Map();
        if (state.baseId) names.set(state.baseId, base);
        extras.forEach(function (r) { if (r.id) names.set(r.id, r.name.value.trim()); });
        state.hidden.forEach(function (p) {
            if (names.has(p.unitId)) prices.push({ unit: names.get(p.unitId), level: p.level, price: p.price, minQty: p.minQty });
        });

        var reorder = whole(reorderInput);
        need(reorder === null || (Number.isInteger(reorder) && reorder >= 0), "The low stock level must be 0 or more.");

        var payload = {
            name: name,
            categoryId: categorySelect.value || null,
            barcode: barcodeInput.value.trim(),
            sku: skuInput.value.trim(),
            costPrice: cost.value,
            reorderLevel: reorder || 0,
            expiryDate: expiryInput.value || null,
            units: units,
            prices: prices,
            _retail: retail
        };
        if (state.photo !== undefined) payload.photo = state.photo;

        if (!isEdit) {
            var qty = whole(stockInput);
            need(qty === null || (Number.isInteger(qty) && qty >= 0), "The opening stock must be 0 or more.");
            var stockOption = unitOptions()[stockUnit.selectedIndex];
            need(qty === null || stockOption.factor >= 1, "First fill in how many " + base + " are inside the " + stockOption.name + ".");
            payload.openingStock = (qty || 0) * stockOption.factor;
        }
        return payload;
    }

    // ---------- the page ----------
    var errorBox = h("p", { class: "form-error", role: "alert", hidden: true });
    var saveButton = h("button", { class: "btn block", type: "submit" }, isEdit ? "Save changes" : "Save product");
    var againButton = isEdit ? null : h("button", { class: "btn ghost block", type: "button" }, "Save and add another");

    var form = h("form", { novalidate: true },
        h("div", { class: "card" },
            h("h2", {}, "Product"),
            labeled("Product name", nameInput),
            h("div", { class: "field" },
                h("label", { for: "category" }, "Category"), categorySelect,
                h("div", {}, h("button", { class: "btn ghost small", type: "button", onclick: addCategory }, "New category"))),
            labeled("Unit you sell in", baseUnitInput, "The smallest unit, e.g. Piece, Kg or Bottle. Stock is counted in this."),
            unitList),
        h("div", { class: "card" },
            h("h2", {}, "Prices" + (isEdit ? "" : " and stock")),
            h("div", { class: "field" },
                h("label", { for: "cost" }, "Cost price (what you pay)"),
                h("div", { class: "pair" }, costInput, h("div", {}, costUnit)),
                h("span", { class: "help" }, "Per one of the unit chosen. Used to work out your profit."),
                costNote),
            labeled("Selling price (UGX) for one of the unit above", retailInput),
            profitNote,
            isEdit ? null : h("div", { class: "field" },
                h("label", { for: "stockQty" }, "Stock you have now"),
                h("div", { class: "pair" }, stockInput, h("div", {}, stockUnit)),
                stockNote)),
        h("details", { class: "card" },
            h("summary", {}, "More options"),
            h("h3", {}, "Bigger units"),
            h("p", { class: "muted" }, "If you also sell or buy by the carton, sack or pack, add it here. Stock is then shown like \"3 Cartons, 5 Pieces\"."),
            extrasBox, addUnitButton,
            h("h3", {}, "Wholesale price"),
            h("div", { class: "pair" },
                labeled("Wholesale price (UGX) for one of the unit above", wholesaleInput),
                labeled("Applies from quantity", wholesaleMin, "Leave empty for any quantity.")),
            h("h3", {}, "Other details"),
            labeled("Warn me when stock is at or below", reorderInput, "Empty = use the shop setting."),
            h("div", { class: "pair" },
                labeled("Barcode", barcodeInput),
                labeled("Your own code (SKU)", skuInput)),
            labeled("Expiry date", expiryInput, "You will be warned before it expires."),
            h("div", { class: "field" },
                h("span", { class: "label" }, "Photo"), photoPreview, photoFile, h("div", {}, photoRemove))),
        errorBox, saveButton, againButton);

    function fail(message) {
        errorBox.textContent = message;
        errorBox.hidden = false;
        errorBox.scrollIntoView({ block: "center" });
    }

    async function save(andAnother) {
        errorBox.hidden = true;
        var payload;
        try { payload = buildPayload(); } catch (error) { return fail(error.message); }

        // Forgiving: selling below cost is allowed, but only after a confirmation.
        if (payload._retail < payload.costPrice) {
            var ok = await Duka.dialog({
                title: "Selling below cost",
                message: "The selling price (" + Duka.fmt.ugx(payload._retail) + ") is lower than the cost (" + Duka.fmt.ugx(payload.costPrice) + "). You would lose money on every sale. Save anyway?",
                confirmText: "Save anyway", danger: true
            });
            if (!ok) return;
        }
        delete payload._retail;

        Duka.busy(saveButton, true, "Saving...");
        if (againButton) againButton.disabled = true;
        try {
            if (isEdit) {
                await Duka.api("/api/products/" + product.id, { method: "PATCH", body: payload });
                Duka.flash("Saved");
                window.location.href = "/products.html";
            } else {
                await Duka.api("/api/products", { method: "POST", body: payload });
                Duka.flash("Product added");
                window.location.href = andAnother ? "/product-form.html" : "/products.html";
            }
        } catch (error) {
            fail(error.message);
            Duka.busy(saveButton, false);
            if (againButton) againButton.disabled = false;
        }
    }

    form.addEventListener("submit", function (event) { event.preventDefault(); save(false); });
    if (againButton) againButton.addEventListener("click", function () { save(true); });

    // ---------- fill the form when editing ----------
    fillCategories(product ? product.categoryId : null);

    if (product) {
        nameInput.value = product.name;
        var sorted = product.units.slice().sort(function (a, b) { return a.factor - b.factor; });
        var base = sorted[0];
        state.baseId = base.id;
        baseUnitInput.value = base.name;

        var normal = product.prices.filter(function (p) {
            return !p.customerId && (p.level === "retail" || p.level === "wholesale");
        });
        function tiers(unitId, level) {
            return normal.filter(function (p) { return p.unitId === unitId && p.level === level; })
                .sort(function (a, b) { return a.minQty - b.minQty; });
        }
        function keepHidden(list) { list.slice(1).forEach(function (p) { state.hidden.push(p); }); }

        var baseRetail = tiers(base.id, "retail");
        retailInput.value = baseRetail[0] ? baseRetail[0].price : "";
        keepHidden(baseRetail);
        var baseWholesale = tiers(base.id, "wholesale");
        if (baseWholesale[0]) {
            wholesaleInput.value = baseWholesale[0].price;
            wholesaleMin.value = baseWholesale[0].minQty > 1 ? baseWholesale[0].minQty : "";
        }
        keepHidden(baseWholesale);

        sorted.slice(1).forEach(function (u) {
            var r = tiers(u.id, "retail");
            var w = tiers(u.id, "wholesale");
            keepHidden(r);
            keepHidden(w);
            addExtra({ id: u.id, name: u.name, factor: u.factor, retail: r[0] && r[0].price, wholesale: w[0] && w[0].price });
        });

        costInput.value = product.costPrice;
        reorderInput.value = product.reorderLevel > 0 ? product.reorderLevel : "";
        barcodeInput.value = product.barcode || "";
        skuInput.value = product.sku || "";
        expiryInput.value = product.expiryDate || "";
        if (product.photo) {
            photoPreview.src = product.photo;
            photoPreview.hidden = false;
            photoRemove.hidden = false;
        }
        var details = form.querySelector("details");
        if (extras.length || baseWholesale[0] || product.reorderLevel || product.barcode || product.sku || product.expiryDate || product.photo) {
            details.open = true;
        }
    }
    refresh();

    // ---------- assemble the page ----------
    page.main.append(
        h("p", {}, h("a", { href: "/products.html" }, "\u2190 Back to products")),
        h("div", { class: "page-head" }, h("h1", {}, isEdit ? "Edit product" : "Add product"),
            isEdit ? null : h("p", {}, "Only the name, prices and stock are needed. Everything else is optional.")));

    if (isEdit) {
        page.main.append(
            h("div", { class: "card" },
                h("h2", {}, "Stock now"),
                h("p", { class: "stat" }, Duka.fmt.stock(product.stockBase, product.units)),
                h("p", { class: "muted" }, "Stock changes through purchases, stock-taking and adjustments, so every change is recorded. These arrive in the next steps."),
                product.costHistory && product.costHistory.length > 1
                    ? h("div", {}, h("h3", {}, "Cost price history"),
                        h("ul", { class: "result-list" }, product.costHistory.map(function (c) {
                            return h("li", {}, Duka.fmt.ugx(c.costPrice) + " per " + base.name + " \u2013 " + Duka.fmt.date(c.at));
                        })))
                    : null));
    }

    page.main.append(form);

    if (isEdit) {
        var toggle = h("button", { class: "btn ghost block" + (product.isActive ? " danger" : ""), type: "button" },
            product.isActive ? "Remove this product" : "Put this product back");
        toggle.addEventListener("click", async function () {
            var removing = product.isActive;
            var ok = await Duka.dialog({
                title: removing ? "Remove " + product.name + "?" : "Put " + product.name + " back?",
                message: removing
                    ? "It will no longer appear when selling. Past sales and stock history are kept, and you can put it back any time."
                    : "It will appear again when selling.",
                confirmText: removing ? "Remove" : "Put back", danger: removing
            });
            if (!ok) return;
            try {
                await Duka.api("/api/products/" + product.id, { method: "PATCH", body: { isActive: !removing } });
                Duka.flash(removing ? "Product removed" : "Product put back");
                window.location.href = "/products.html";
            } catch (error) {
                Duka.toast(error.message, "error");
            }
        });
        page.main.append(h("div", { class: "card" }, toggle));
    }
})();
