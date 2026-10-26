/* reports.js - how the shop is doing for any period: profit and loss in plain words,
   money received, retail vs wholesale, cashiers, profit per product, fast and slow sellers.
   "Print / Save as PDF" uses the phone's or computer's print window (choose "Save as PDF").
   "Download for Excel" gives a CSV file that opens in Excel and Google Sheets. */
(async function () {
    "use strict";
    var h = Duka.h;
    var page = await Duka.initPage({ title: "Reports", roles: ["owner"] });
    var shopName = page.user.shopName;

    var state = { preset: "today", from: "", to: "", sort: "profit" };
    var requestId = 0;
    var last = null; // the figures on screen, for the CSV

    // ---------- choosing the period ----------
    var PRESETS = [["today", "Today"], ["yesterday", "Yesterday"], ["week", "Last 7 days"], ["month", "This month"],
                   ["lastmonth", "Last month"], ["custom", "Pick dates"]];
    function range() {
        var today = Duka.fmt.today();
        if (state.preset === "yesterday") { var y = Duka.fmt.addDays(today, -1); return { from: y, to: y }; }
        if (state.preset === "week") return { from: Duka.fmt.addDays(today, -6), to: today };
        if (state.preset === "month") return { from: today.slice(0, 8) + "01", to: today };
        if (state.preset === "lastmonth") {
            var firstThis = today.slice(0, 8) + "01";
            var lastDay = Duka.fmt.addDays(firstThis, -1);
            return { from: lastDay.slice(0, 8) + "01", to: lastDay };
        }
        if (state.preset === "custom") return { from: state.from || today, to: state.to || state.from || today };
        return { from: today, to: today };
    }
    var presetButtons = PRESETS.map(function (p) {
        var b = h("button", { type: "button", class: "seg" }, p[1]);
        b.dataset.key = p[0];
        b.addEventListener("click", function () { state.preset = p[0]; sync(); load(); });
        return b;
    });
    var fromInput = h("input", { class: "input", type: "date", "aria-label": "From" });
    var toInput = h("input", { class: "input", type: "date", "aria-label": "To" });
    var customRow = h("div", { class: "pair", hidden: true }, fromInput, toInput);
    fromInput.addEventListener("change", function () { state.from = fromInput.value; load(); });
    toInput.addEventListener("change", function () { state.to = toInput.value; load(); });
    function sync() {
        presetButtons.forEach(function (b) { b.classList.toggle("on", b.dataset.key === state.preset); });
        customRow.hidden = state.preset !== "custom";
    }

    var out = h("div", {}, h("p", { class: "empty" }, "Loading..."));

    // ---------- small builders ----------
    function row(label, value, cls) { return h("div", { class: "pl-row" + (cls ? " " + cls : "") }, h("span", {}, label), h("span", {}, value)); }
    function periodText(r) { return r.from === r.to ? Duka.fmt.date(r.from) : Duka.fmt.date(r.from) + " to " + Duka.fmt.date(r.to); }
    function profitSpan(n) { return h("span", { class: n >= 0 ? "up" : "down" }, Duka.fmt.ugx(n)); }

    function explain(s) {
        var parts = ["You sold " + Duka.fmt.ugx(s.salesNet)];
        if (s.refunds > 0) parts[0] += " (after giving back " + Duka.fmt.ugx(s.refunds) + " for returned goods)";
        parts.push("The goods you sold cost " + Duka.fmt.ugx(s.costOfGoods) + ", so your gross profit is " + Duka.fmt.ugx(s.grossProfit));
        parts.push("Your expenses were " + Duka.fmt.ugx(s.expenses.total));
        var end = s.netProfit >= 0
            ? "so you made " + Duka.fmt.ugx(s.netProfit) + "."
            : "so you made a loss of " + Duka.fmt.ugx(-s.netProfit) + ".";
        return parts.join(". ") + ", " + end;
    }

    function render(s, pr) {
        var r = s.range;
        var parts = [];

        parts.push(h("div", { class: "print-only" }, h("h1", {}, shopName), h("p", {}, "Report for " + periodText(r))));
        parts.push(h("div", { class: "card" },
            h("h2", {}, "In plain words"),
            h("p", { class: "explain" }, explain(s)),
            h("p", { class: "muted" }, periodText(r) + " \u00b7 " + s.sales.count + (s.sales.count === 1 ? " sale" : " sales"))));

        // profit and loss
        var pl = [row("Sales (" + s.sales.count + ")", Duka.fmt.ugx(s.sales.total))];
        if (s.sales.discounts > 0) pl.push(row("(after discounts of " + Duka.fmt.ugx(s.sales.discounts) + ")", "", "sub"));
        if (s.refunds > 0) pl.push(row("Given back for returns", "-" + Duka.fmt.ugx(s.refunds)));
        pl.push(row("Sales, after returns", Duka.fmt.ugx(s.salesNet)));
        pl.push(row("What the goods cost you", "-" + Duka.fmt.ugx(s.costOfGoods)));
        pl.push(row("Gross profit", profitSpan(s.grossProfit)));
        pl.push(row("Expenses", "-" + Duka.fmt.ugx(s.expenses.total)));
        s.expenses.byCategory.forEach(function (c) { pl.push(row(c.category, Duka.fmt.ugx(c.total), "sub")); });
        pl.push(row("Net profit", profitSpan(s.netProfit), "total"));
        parts.push(h("div", { class: "card" }, h("h2", {}, "Profit and loss"), pl,
            h("p", { class: "muted" }, "Returned goods are counted on the day they came back.")));

        // money received
        var m = [
            row("Cash", Duka.fmt.ugx(s.collected.cash)),
            row("Mobile Money", Duka.fmt.ugx(s.collected.mobile_money)),
            row("Bank", Duka.fmt.ugx(s.collected.bank)),
            row("Taken at the till", Duka.fmt.ugx(s.collected.total), "total"),
            row("Given on credit (not paid yet)", h("span", { class: s.sales.credit > 0 ? "down" : "" }, Duka.fmt.ugx(s.sales.credit))),
            row("Debts customers paid back", Duka.fmt.ugx(s.debtPayments.total))
        ];
        parts.push(h("div", { class: "card" }, h("h2", {}, "Money received"), m));

        // retail vs wholesale, cashiers
        function group(title, items, nameOf) {
            return h("div", { class: "card" }, h("h2", {}, title),
                items.length ? items.map(function (x) {
                    return h("div", { class: "row" },
                        h("div", { class: "grow" }, h("div", { class: "name" }, nameOf(x)), h("div", { class: "sub" }, x.count + (x.count === 1 ? " sale" : " sales"))),
                        h("div", { class: "price" }, Duka.fmt.ugx(x.total), h("small", {}, "profit " + Duka.fmt.ugx(x.profit))));
                }) : h("p", { class: "empty" }, "No sales."));
        }
        parts.push(group("Retail and wholesale", s.byType, function (x) { return x.type === "wholesale" ? "Wholesale" : "Retail"; }));
        parts.push(group("Sales by cashier", s.byCashier, function (x) { return x.name; }));

        // sales per day
        if (r.from !== r.to) {
            var byDay = new Map(s.daily.map(function (d) { return [d.day, d.total]; }));
            var days = [];
            for (var day = r.from; day <= r.to; day = Duka.fmt.addDays(day, 1)) {
                days.push({ label: Duka.fmt.date(day).replace(/ \d{4}$/, ""), value: byDay.get(day) || 0 });
            }
            parts.push(h("div", { class: "card" }, h("h2", {}, "Sales per day"),
                Duka.barChart({ title: "Sales per day", data: days, format: Duka.fmt.ugx })));
        }

        // profit per product
        var sortSelect = h("select", { class: "input", "aria-label": "Sort products by" },
            [["profit", "Most profit first"], ["revenue", "Most sales first"], ["quantity", "Sold most often"], ["name", "Name A to Z"]]
                .map(function (o) { return h("option", { value: o[0] }, o[1]); }));
        sortSelect.value = state.sort;
        sortSelect.addEventListener("change", function () { state.sort = sortSelect.value; load(); });

        parts.push(h("div", { class: "card" },
            h("h2", {}, "Profit per product"),
            h("div", { class: "no-print" }, sortSelect),
            pr.products.length ? pr.products.map(function (p) {
                return h("div", { class: "row" },
                    h("div", { class: "grow" },
                        h("div", { class: "name" }, p.name),
                        h("div", { class: "sub" }, p.category + " \u00b7 sold " + Duka.fmt.stock(p.qtyBase, p.units) + " \u00b7 margin " + p.margin + "%")),
                    h("div", { class: "price" }, profitSpan(p.profit), h("small", {}, "of " + Duka.fmt.ugx(p.revenue))));
            }) : h("p", { class: "empty" }, "No sales in this period."),
            h("p", { class: "muted" }, "Product figures are before sale discounts and returns.")));

        parts.push(h("div", { class: "card" },
            h("h2", {}, "Profit per category"),
            pr.categories.length ? pr.categories.map(function (c) {
                return h("div", { class: "row" },
                    h("div", { class: "grow" }, h("div", { class: "name" }, c.category), h("div", { class: "sub" }, c.products + (c.products === 1 ? " product" : " products"))),
                    h("div", { class: "price" }, profitSpan(c.profit), h("small", {}, "of " + Duka.fmt.ugx(c.revenue))));
            }) : h("p", { class: "empty" }, "No sales in this period.")));

        parts.push(h("div", { class: "card" },
            h("h2", {}, "Selling fast"),
            pr.fast.length ? pr.fast.map(function (p) {
                return h("div", { class: "row" },
                    h("div", { class: "grow" }, h("div", { class: "name" }, p.name), h("div", { class: "sub" }, "In " + p.timesSold + (p.timesSold === 1 ? " sale" : " sales"))),
                    h("div", { class: "price" }, Duka.fmt.ugx(p.revenue)));
            }) : h("p", { class: "empty" }, "No sales in this period.")));

        parts.push(h("div", { class: "card" },
            h("h2", {}, "Not selling"),
            h("p", { class: "muted" }, "In stock, but nothing sold in this period."),
            pr.slow.length ? pr.slow.map(function (p) {
                return h("div", { class: "row" },
                    h("div", { class: "grow" }, h("div", { class: "name" }, p.name),
                        h("div", { class: "sub" }, p.lastSold ? "Last sold " + Duka.fmt.date(p.lastSold) : "Never sold")),
                    h("div", { class: "price" }, Duka.fmt.stock(p.stockBase, p.units), h("small", {}, "worth " + Duka.fmt.ugx(p.stockValue) + " at cost")));
            }) : h("p", { class: "up" }, "Everything in stock has sold. Good.")));

        out.replaceChildren.apply(out, parts);
        last = { s: s, pr: pr };
    }

    async function load() {
        var mine = ++requestId;
        out.replaceChildren(h("p", { class: "empty" }, "Loading..."));
        var r = range();
        var query = new URLSearchParams({ from: r.from, to: r.to });
        try {
            var results = await Promise.all([
                Duka.api("/api/reports/summary?" + query.toString()),
                Duka.api("/api/reports/products?" + query.toString() + "&sort=" + state.sort)
            ]);
            if (mine !== requestId) return;
            render(results[0], results[1]);
        } catch (error) {
            if (mine !== requestId) return;
            out.replaceChildren(h("p", { class: "form-error" }, error.message),
                h("button", { type: "button", class: "btn ghost", onclick: load }, "Try again"));
        }
    }

    // ---------- download for Excel ----------
    function csvCell(value) {
        var text = value === null || value === undefined ? "" : String(value);
        return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    }
    function downloadCsv() {
        if (!last) return;
        var s = last.s, pr = last.pr, r = s.range;
        var lines = [
            ["Duka report", shopName, r.from, r.to], [],
            ["Profit and loss"],
            ["Sales", s.sales.total], ["Given back for returns", s.refunds], ["Sales after returns", s.salesNet],
            ["Cost of goods", s.costOfGoods], ["Gross profit", s.grossProfit], ["Expenses", s.expenses.total], ["Net profit", s.netProfit], [],
            ["Expenses by category"]
        ].concat(s.expenses.byCategory.map(function (c) { return [c.category, c.total]; }), [[],
            ["Money received"],
            ["Cash", s.collected.cash], ["Mobile Money", s.collected.mobile_money], ["Bank", s.collected.bank],
            ["Given on credit", s.sales.credit], ["Debts paid back", s.debtPayments.total], [],
            ["Retail and wholesale", "Sales", "Total", "Profit"]
        ], s.byType.map(function (x) { return [x.type, x.count, x.total, x.profit]; }), [[],
            ["Cashier", "Sales", "Total", "Profit"]
        ], s.byCashier.map(function (x) { return [x.name, x.count, x.total, x.profit]; }), [[],
            ["Product", "Category", "Quantity sold (smallest unit)", "Times sold", "Sales", "Cost", "Profit", "Margin %"]
        ], pr.products.map(function (p) { return [p.name, p.category, p.qtyBase, p.timesSold, p.revenue, p.cost, p.profit, p.margin]; }));

        var text = lines.map(function (l) { return l.map(csvCell).join(","); }).join("\r\n");
        var blob = new Blob(["\uFEFF" + text], { type: "text/csv;charset=utf-8" });
        var url = URL.createObjectURL(blob);
        var link = h("a", { href: url, download: "duka-report-" + r.from + (r.from === r.to ? "" : "-to-" + r.to) + ".csv" });
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    page.main.append(h("div", {},
        h("div", { class: "page-head no-print" }, h("h1", {}, "Reports"), h("p", {}, "Choose a period to see how the shop did.")),
        h("div", { class: "card no-print" },
            h("div", { class: "seg-group wrap", role: "group", "aria-label": "Period" }, presetButtons), customRow),
        h("div", { class: "page-actions no-print" },
            h("button", { type: "button", class: "btn", onclick: function () { window.print(); } }, "Print / Save as PDF"),
            h("button", { type: "button", class: "btn ghost", onclick: downloadCsv }, "Download for Excel"),
            h("a", { class: "btn ghost", href: "/stock.html" }, "Stock value"),
            h("a", { class: "btn ghost", href: "/customers.html" }, "Debtors"),
            h("a", { class: "btn ghost", href: "/suppliers.html" }, "Supplier balances")),
        out));
    sync();
    load();
})();
