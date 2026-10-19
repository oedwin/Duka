/* products.js - the product list: search as you type, filters, "show more" */
(async function () {
    "use strict";
    var h = Duka.h;
    var page = await Duka.initPage({ title: "Products" });
    var isOwner = page.user.role === "owner";

    var search = h("input", {
        class: "input", type: "search", placeholder: "Search by name or barcode",
        autocomplete: "off", "aria-label": "Search products"
    });
    var category = h("select", { class: "input", "aria-label": "Category" }, h("option", { value: "" }, "All categories"));
    var view = h("select", { class: "input", "aria-label": "Show" },
        [["active", "All products"], ["low", "Low stock"], ["out", "Out of stock"],
         ["expiring", "Expiring soon"], ["inactive", "Removed products"]]
            .map(function (o) { return h("option", { value: o[0] }, o[1]); }));

    var summary = h("p", { class: "muted" });
    var list = h("div", { class: "card" });
    var more = h("button", { class: "btn ghost block", type: "button", hidden: true }, "Show more");

    var pageNo = 1;
    var requestId = 0; // so a slow old answer never overwrites a newer search

    function badge(text, kind) { return h("span", { class: "badge" + (kind ? " " + kind : "") }, text); }

    function productRow(p) {
        var base = (p.units.filter(function (u) { return u.factor === 1; })[0] || {}).name || "";
        var badges = [];
        if (!p.isActive) badges.push(badge("Removed", "off"));
        else if (p.isOut) badges.push(badge("Out of stock", "off"));
        else if (p.isLow) badges.push(badge("Low stock", "warn"));
        if (p.isExpired) badges.push(badge("Expired", "off"));
        else if (p.expiringSoon) badges.push(badge("Expires " + Duka.fmt.date(p.expiryDate), "warn"));

        var sub = [p.categoryName, "In stock: " + Duka.fmt.stock(p.stockBase, p.units)].filter(Boolean).join(" \u00b7 ");
        var info = h("div", { class: "grow" },
            h("div", { class: "name" }, p.name),
            h("div", { class: "sub" }, sub),
            isOwner ? h("div", { class: "sub" }, "Cost: " + Duka.fmt.ugx(p.costPrice) + " per " + base) : null,
            badges.length ? h("div", { class: "badges" }, badges) : null);
        var price = h("div", { class: "price" },
            p.retailPrice === null ? "No price" : Duka.fmt.ugx(p.retailPrice),
            p.retailPrice === null ? null : h("small", {}, "per " + base));

        return isOwner
            ? h("a", { class: "row link", href: "/product-form.html?id=" + p.id }, info, price)
            : h("div", { class: "row" }, info, price);
    }

    async function load(reset) {
        var mine = ++requestId;
        if (reset) {
            pageNo = 1;
            more.hidden = true;
            list.replaceChildren(h("p", { class: "empty" }, "Loading..."));
        }

        var query = new URLSearchParams({ page: pageNo, limit: 30 });
        if (search.value.trim()) query.set("search", search.value.trim());
        if (category.value) query.set("categoryId", category.value);
        if (view.value === "inactive") query.set("status", "inactive");
        else if (view.value !== "active") query.set("filter", view.value);

        try {
            var data = await Duka.api("/api/products?" + query.toString());
            if (mine !== requestId) return;

            if (reset) list.replaceChildren();
            data.products.forEach(function (p) { list.appendChild(productRow(p)); });

            if (data.total === 0) {
                var filtered = search.value.trim() || category.value || view.value !== "active";
                list.replaceChildren(h("p", { class: "empty" },
                    filtered ? "No products match." :
                    isOwner ? "No products yet. Tap \"Add product\" to start." : "No products yet."));
            }
            summary.textContent = data.total + (data.total === 1 ? " product" : " products");
            more.hidden = !data.hasMore;
            more.textContent = "Show more (" + (data.total - data.page * data.limit) + " left)";
        } catch (error) {
            if (mine !== requestId) return;
            list.replaceChildren(
                h("p", { class: "form-error" }, error.message),
                h("button", { class: "btn ghost", type: "button", onclick: function () { load(true); } }, "Try again"));
        }
    }

    // Search as you type (waits a moment so we do not ask the server on every key)
    var timer;
    search.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(function () { load(true); }, 250); });
    category.addEventListener("change", function () { load(true); });
    view.addEventListener("change", function () { load(true); });
    more.addEventListener("click", function () { pageNo++; load(false); });

    // (Element.append would print the word "null", so build the page with Duka.h)
    page.main.append(h("div", {},
        h("div", { class: "page-head" }, h("h1", {}, "Products")),
        isOwner ? h("div", { class: "page-actions" },
            h("a", { class: "btn", href: "/product-form.html" }, "Add product"),
            h("a", { class: "btn ghost", href: "/product-import.html" }, "Import / export")) : null,
        h("div", { class: "toolbar" }, search, category, view),
        summary, list, more));

    // Categories fill in quietly; the list does not wait for them.
    Duka.api("/api/categories").then(function (data) {
        data.categories.forEach(function (c) { category.appendChild(h("option", { value: String(c.id) }, c.name)); });
    }).catch(function () { /* the filter just stays on "All categories" */ });

    load(true);
})();
