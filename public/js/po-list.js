/* po-list.js - all purchase orders, with a shortcut to start a new one from the low-stock items. */
(async function () {
    "use strict";
    var h = Duka.h;
    var page = await Duka.initPage({ title: "Purchase orders" });
    var isOwner = page.user.role === "owner";

    var STATUS = { draft: "Draft", sent: "Sent to supplier", received: "Received", cancelled: "Cancelled" };
    var BADGE = { draft: "badge warn", sent: "badge", received: "badge", cancelled: "badge off" };
    var state = { status: "open", search: "" };
    var pageNo = 1;
    var requestId = 0;

    var status = h("select", { class: "input", "aria-label": "Show orders" },
        [["open", "Open orders (draft and sent)"], ["draft", "Drafts"], ["sent", "Sent to supplier"],
         ["received", "Received"], ["cancelled", "Cancelled"], ["all", "All orders"]]
            .map(function (o) { return h("option", { value: o[0] }, o[1]); }));
    var searchBox = h("input", { class: "input", type: "search", placeholder: "Order number or supplier", autocomplete: "off", "aria-label": "Search orders" });
    var lowCard = h("div", { class: "card", hidden: true });
    var list = h("div", { class: "card" });
    var more = h("button", { type: "button", class: "btn ghost block", hidden: true }, "Show more");

    function row(o) {
        var title = "PO-" + String(o.orderNumber).padStart(4, "0") + " · " + (o.supplierName || "No supplier yet");
        var sub = Duka.fmt.date(o.orderDate) + " · " + o.itemCount + (o.itemCount === 1 ? " product" : " products") +
            (o.expectedDate ? " · expected " + Duka.fmt.date(o.expectedDate) : "");
        return h("a", { class: "row link", href: "/order.html?id=" + o.id },
            h("div", { class: "grow" },
                h("div", { class: "name" }, title),
                h("div", { class: "sub" }, sub),
                h("div", { class: "badges" }, h("span", { class: BADGE[o.status] }, STATUS[o.status]))),
            isOwner ? h("div", { class: "price" }, Duka.fmt.ugx(o.total), h("small", {}, "estimated")) : null);
    }

    async function load(reset) {
        var mine = ++requestId;
        if (reset) { pageNo = 1; more.hidden = true; list.replaceChildren(h("p", { class: "empty" }, "Loading...")); }
        var q = new URLSearchParams({ status: state.status, page: pageNo, limit: 30 });
        if (state.search) q.set("search", state.search);
        try {
            var data = await Duka.api("/api/orders?" + q.toString());
            if (mine !== requestId) return;
            if (reset) list.replaceChildren();
            data.orders.forEach(function (o) { list.appendChild(row(o)); });
            if (data.total === 0) list.replaceChildren(h("p", { class: "empty" }, "No orders found. Tap “New purchase order” to start one."));
            more.hidden = !data.hasMore;
            more.textContent = "Show more (" + (data.total - data.page * data.limit) + " left)";
        } catch (error) {
            if (mine !== requestId) return;
            list.replaceChildren(h("p", { class: "form-error" }, error.message),
                h("button", { type: "button", class: "btn ghost", onclick: function () { load(true); } }, "Try again"));
        }
    }

    async function loadLow() {
        try {
            var items = (await Duka.api("/api/orders/low-stock")).items;
            if (!items.length) { lowCard.hidden = true; return; }
            var out = items.filter(function (i) { return i.isOut; }).length;
            lowCard.replaceChildren(
                h("h2", {}, "Running low"),
                h("p", {}, items.length + (items.length === 1 ? " product is" : " products are") + " low on stock" + (out ? " (" + out + " out of stock)" : "") + ": " +
                    items.slice(0, 4).map(function (i) { return i.name; }).join(", ") + (items.length > 4 ? " and more" : "") + "."),
                h("a", { class: "btn", href: "/order-form.html" }, "Order them now"));
            lowCard.hidden = false;
        } catch (e) { /* the list still works without this card */ }
    }

    status.addEventListener("change", function () { state.status = status.value; load(true); });
    var timer;
    searchBox.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(function () { state.search = searchBox.value.trim(); load(true); }, 300); });
    more.addEventListener("click", function () { pageNo++; load(false); });

    page.main.append(h("div", {},
        h("div", { class: "page-head" }, h("h1", {}, "Purchase orders"), h("p", {}, "Lists of what to buy from your suppliers. Print them or send them.")),
        h("div", { class: "page-actions" },
            h("a", { class: "btn", href: "/order-form.html" }, "New purchase order"),
            h("a", { class: "btn ghost", href: "/order-form.html?blank=1" }, "Start with an empty order")),
        lowCard,
        h("div", { class: "toolbar2" }, status, searchBox),
        list, more));

    loadLow();
    load(true);
})();
