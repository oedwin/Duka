/* suppliers.js - your suppliers and the total you owe them */
(async function () {
    "use strict";
    var h = Duka.h;
    var page = await Duka.initPage({ title: "Suppliers", roles: ["owner"] });

    var owedBox = h("div", { class: "card" }, h("p", { class: "empty" }, "Loading..."));
    var search = h("input", { class: "input", type: "search", placeholder: "Search suppliers", autocomplete: "off", "aria-label": "Search suppliers" });
    var list = h("div", { class: "card" });
    var requestId = 0;

    function row(s) {
        var sub = [s.phoneDisplay, s.productsSupplied].filter(Boolean).join(" \u00b7 ");
        return h("a", { class: "row link", href: "/supplier.html?id=" + s.id },
            h("div", { class: "grow" },
                h("div", { class: "name" }, s.name),
                sub ? h("div", { class: "sub" }, sub) : null),
            s.balance > 0
                ? h("div", { class: "price down" }, Duka.fmt.ugx(s.balance), h("small", {}, "you owe"))
                : h("div", { class: "price" }, h("small", {}, "Nothing owed")));
    }

    async function load() {
        var mine = ++requestId;
        var query = new URLSearchParams();
        if (search.value.trim()) query.set("search", search.value.trim());
        try {
            var data = await Duka.api("/api/suppliers?" + query.toString());
            if (mine !== requestId) return;
            owedBox.replaceChildren(
                h("h2", {}, "What you owe suppliers"),
                h("p", { class: "big-owed" + (data.totalOwed > 0 ? " bad" : "") }, Duka.fmt.ugx(data.totalOwed)));
            list.replaceChildren.apply(list, data.suppliers.length
                ? data.suppliers.map(row)
                : [h("p", { class: "empty" }, search.value.trim() ? "No suppliers match." : "No suppliers yet. Tap \"Add supplier\".")]);
        } catch (error) {
            if (mine !== requestId) return;
            list.replaceChildren(h("p", { class: "form-error" }, error.message),
                h("button", { type: "button", class: "btn ghost", onclick: load }, "Try again"));
        }
    }

    async function addSupplier() {
        var values = await Duka.dialog({
            title: "Add supplier", confirmText: "Add supplier",
            fields: [
                { name: "name", label: "Supplier name" },
                { name: "phone", label: "Phone number", type: "tel", inputmode: "tel", required: false },
                { name: "productsSupplied", label: "What they supply", required: false, help: "e.g. Sugar, rice, maize flour" },
                { name: "openingBalance", label: "Money you already owe them (UGX)", type: "number", inputmode: "numeric", required: false,
                  help: "Only if you owed them money before you started using Duka." }
            ]
        });
        if (!values) return;
        try {
            await Duka.api("/api/suppliers", { method: "POST", body: values });
            Duka.toast("Supplier added");
            load();
        } catch (error) {
            Duka.toast(error.message, "error");
        }
    }

    var timer;
    search.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(load, 250); });

    page.main.append(h("div", {},
        h("div", { class: "page-head" }, h("h1", {}, "Suppliers")),
        h("div", { class: "page-actions" },
            h("button", { type: "button", class: "btn", onclick: addSupplier }, "Add supplier"),
            h("a", { class: "btn ghost", href: "/purchase-form.html" }, "Record a purchase")),
        owedBox, search, list));
    load();
})();
