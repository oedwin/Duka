/* dashboard.js - Home: today at a glance. Big numbers, plain words.
   Green = good, red = needs your attention. Cashiers see only their own sales and the low-stock list. */
(async function () {
    "use strict";
    var h = Duka.h;
    var page = await Duka.initPage({ title: "Home" });
    var user = page.user;
    var isOwner = user.role === "owner";
    var firstName = (user.fullName || "").split(" ")[0];

    var box = h("div", {}, h("p", { class: "empty" }, "Loading..."));
    page.main.append(h("div", {},
        h("div", { class: "page-head" }, h("h1", {}, "Hello, " + firstName), h("p", { id: "dateLine" }, "")),
        h("div", { class: "page-actions" },
            h("a", { class: "btn big", href: "/pos.html" }, "Sell"),
            isOwner ? h("a", { class: "btn ghost", href: "/expenses.html" }, "Record expense") : null,
            isOwner ? h("a", { class: "btn ghost", href: "/purchase-form.html" }, "Receive stock") : null,
            h("a", { class: "btn ghost", href: "/closing.html" }, "Close the day")),
        box));

    function stat(label, value, kind, note) {
        return h("div", { class: "stat-box" + (kind ? " " + kind : "") },
            h("div", { class: "muted" }, label),
            h("div", { class: "stat" }, value),
            note ? h("div", { class: "sub" }, note) : null);
    }

    function lowStockCard(low) {
        if (low.items.length === 0) {
            return h("div", { class: "card" }, h("h2", {}, "Stock"), h("p", { class: "up" }, "Nothing is running low. Good."));
        }
        return h("div", { class: "card" },
            h("h2", {}, "Running low"),
            h("p", { class: "muted" }, low.out + " out of stock, " + low.low + " low"),
            low.items.map(function (i) {
                return h("div", { class: "row" },
                    h("div", { class: "grow" }, h("div", { class: "name" }, i.name)),
                    h("div", { class: "price " + (i.isOut ? "down" : "") }, i.isOut ? "Out of stock" : Duka.fmt.stock(i.stockBase, i.units)));
            }),
            h("div", { class: "actions" }, isOwner
                ? [h("a", { class: "btn ghost small", href: "/stock.html" }, "See stock"), h("a", { class: "btn ghost small", href: "/purchase-form.html" }, "Receive stock")]
                : h("a", { class: "btn ghost small", href: "/products.html" }, "See products")));
    }

    function chartCard(chart) {
        var holder = h("div", {});
        var days = 7;
        var seven = h("button", { type: "button", class: "seg on" }, "Last 7 days");
        var thirty = h("button", { type: "button", class: "seg" }, "Last 30 days");
        function draw() {
            seven.classList.toggle("on", days === 7);
            thirty.classList.toggle("on", days === 30);
            var slice = chart.slice(-days);
            var total = slice.reduce(function (s, d) { return s + d.total; }, 0);
            holder.replaceChildren(
                h("p", { class: "muted" }, "Sold in this period: " + Duka.fmt.ugx(total)),
                Duka.barChart({
                    title: "Sales per day", format: Duka.fmt.ugx,
                    data: slice.map(function (d) { return { label: Duka.fmt.date(d.day).replace(/ \d{4}$/, ""), value: d.total }; })
                }));
        }
        seven.addEventListener("click", function () { days = 7; draw(); });
        thirty.addEventListener("click", function () { days = 30; draw(); });
        draw();
        return h("div", { class: "card" }, h("h2", {}, "Sales per day"), h("div", { class: "chart-toggle" }, seven, thirty), holder);
    }

    try {
        var d = await Duka.api("/api/dashboard");
        document.getElementById("dateLine").textContent = isOwner
            ? "Today, " + Duka.fmt.date(d.today) + ", for the whole shop" : "Today, " + Duka.fmt.date(d.today) + ". These are your own sales.";

        var parts = [];
        var money = [
            stat("Sold today", Duka.fmt.ugx(d.sales.total), "", d.sales.count + (d.sales.count === 1 ? " sale" : " sales")),
            stat("Cash in", Duka.fmt.ugx(d.collected.cash)),
            stat("Mobile Money in", Duka.fmt.ugx(d.collected.mobile_money))
        ];
        if (d.collected.bank > 0) money.push(stat("Bank in", Duka.fmt.ugx(d.collected.bank)));
        money.push(stat("Given on credit", Duka.fmt.ugx(d.sales.credit), d.sales.credit > 0 ? "bad" : ""));
        if (isOwner) {
            money.push(stat("Spent today", Duka.fmt.ugx(d.expenses)));
            money.push(stat("Profit today", Duka.fmt.ugx(d.profit), d.profit >= 0 ? "good" : "bad",
                d.refunds > 0 ? "after " + Duka.fmt.ugx(d.refunds) + " returned" : ""));
        }
        parts.push(h("div", { class: "card" }, h("h2", {}, "Today"), h("div", { class: "stats" }, money)));

        if (isOwner) {
            parts.push(h("div", { class: "stats" },
                h("a", { class: "card tile-link", href: "/customers.html" },
                    h("div", { class: "muted" }, "Customers owe you"),
                    h("div", { class: "stat" + (d.owedToUs.total > 0 ? " bad" : "") }, Duka.fmt.ugx(d.owedToUs.total)),
                    h("div", { class: "sub" }, d.owedToUs.customers + (d.owedToUs.customers === 1 ? " customer" : " customers"))),
                h("a", { class: "card tile-link", href: "/suppliers.html" },
                    h("div", { class: "muted" }, "You owe suppliers"),
                    h("div", { class: "stat" + (d.weOwe.total > 0 ? " bad" : "") }, Duka.fmt.ugx(d.weOwe.total)),
                    h("div", { class: "sub" }, d.weOwe.suppliers + (d.weOwe.suppliers === 1 ? " supplier" : " suppliers")))));
        }

        parts.push(lowStockCard(d.lowStock));

        if (isOwner) {
            parts.push(h("div", { class: "card" },
                h("h2", {}, "Best sellers this week"),
                d.bestSelling.length ? d.bestSelling.map(function (b, i) {
                    return h("div", { class: "row" },
                        h("div", { class: "grow" }, h("div", { class: "name" }, (i + 1) + ". " + b.name), h("div", { class: "sub" }, "Sold " + Duka.fmt.stock(b.qtyBase, b.units))),
                        h("div", { class: "price" }, Duka.fmt.ugx(b.revenue)));
                }) : h("p", { class: "empty" }, "No sales yet this week.")));
            parts.push(chartCard(d.chart));
            parts.push(h("div", { class: "actions" }, h("a", { class: "btn ghost", href: "/reports.html" }, "Full reports")));
        }
        box.replaceChildren.apply(box, parts);
    } catch (error) {
        box.replaceChildren(h("p", { class: "form-error" }, error.message),
            h("button", { type: "button", class: "btn ghost", onclick: function () { window.location.reload(); } }, "Try again"));
    }
})();
