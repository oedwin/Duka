/* customers.js - your customers and who owes you money: how much, how old, who is overdue */
(async function () {
    "use strict";
    var h = Duka.h;
    var page = await Duka.initPage({ title: "Customers", roles: ["owner"] });
    var shopName = page.user.shopName;

    var filter = "all";
    var pageNo = 1;
    var requestId = 0;

    var summary = h("div", { class: "card" }, h("p", { class: "empty" }, "Loading..."));
    var search = h("input", { class: "input", type: "search", placeholder: "Search name or phone", autocomplete: "off", "aria-label": "Search customers" });
    var sort = h("select", { class: "input", "aria-label": "Sort by" },
        [["balance", "Most owed first"], ["oldest", "Oldest debt first"], ["name", "Name A to Z"]].map(function (o) { return h("option", { value: o[0] }, o[1]); }));
    var chips = [["all", "Everyone"], ["owing", "Owing"], ["overdue", "Overdue"]].map(function (f) {
        var b = h("button", { type: "button", class: "seg" }, f[1]);
        b.dataset.key = f[0];
        b.addEventListener("click", function () { filter = f[0]; syncChips(); load(true); });
        return b;
    });
    var list = h("div", { class: "card" });
    var count = h("p", { class: "muted" });
    var more = h("button", { type: "button", class: "btn ghost block", hidden: true }, "Show more");

    function syncChips() { chips.forEach(function (b) { b.classList.toggle("on", b.dataset.key === filter); }); }
    function stat(label, value, bad) {
        return h("div", { class: "stat-box" }, h("div", { class: "muted" }, label), h("div", { class: "stat" + (bad ? " bad" : "") }, value));
    }

    function row(c) {
        var sub = [c.phoneDisplay, c.location, c.customerType === "wholesale" ? "Wholesale" : null].filter(Boolean).join(" \u00b7 ");
        var owes = c.balance > 0;
        var age = owes && c.daysOwed !== null
            ? "Owed since " + Duka.fmt.date(c.debtSince) + " (" + c.daysOwed + (c.daysOwed === 1 ? " day" : " days") + ")" : "";
        var badges = [];
        if (c.overdue) badges.push(h("span", { class: "badge off" }, "Overdue"));
        if (c.creditLimit !== null && c.balance > c.creditLimit) badges.push(h("span", { class: "badge warn" }, "Over credit limit"));

        return h("div", { class: "row" },
            h("a", { class: "grow row-link", href: "/customer.html?id=" + c.id },
                h("div", { class: "name" }, c.name),
                sub ? h("div", { class: "sub" }, sub) : null,
                age ? h("div", { class: "sub" }, age) : null,
                badges.length ? h("div", { class: "badges" }, badges) : null),
            h("div", { class: "price" + (owes ? " down" : "") }, owes ? Duka.fmt.ugx(c.balance) : "", h("small", {}, owes ? "owes you" : "Nothing owed")),
            owes ? h("div", { class: "row-actions" },
                h("button", { type: "button", class: "btn small", onclick: function () { Duka.receivePayment(c); } }, "Receive payment"),
                Duka.reminderLinks(c, shopName)) : null);
    }

    async function load(reset) {
        var mine = ++requestId;
        if (reset) { pageNo = 1; more.hidden = true; list.replaceChildren(h("p", { class: "empty" }, "Loading...")); }
        var query = new URLSearchParams({ filter: filter, sort: sort.value, page: pageNo, limit: 30 });
        if (search.value.trim()) query.set("search", search.value.trim());
        try {
            var data = await Duka.api("/api/customers/overview?" + query.toString());
            if (mine !== requestId) return;
            if (reset) {
                list.replaceChildren();
                var t = data.totals;
                summary.replaceChildren(h("h2", {}, "Money customers owe you"),
                    h("div", { class: "stats" },
                        stat("Total owed to you", Duka.fmt.ugx(t.totalOwed), t.totalOwed > 0),
                        stat("Customers owing", Duka.fmt.number(t.owing)),
                        stat("Overdue (more than " + data.overdueDays + " days)", t.overdue > 0 ? Duka.fmt.ugx(t.overdueAmount) + " \u00b7 " + t.overdue : "None", t.overdue > 0)));
            }
            data.customers.forEach(function (c) { list.appendChild(row(c)); });
            if (data.total === 0) {
                list.replaceChildren(h("p", { class: "empty" }, filter === "all" && !search.value.trim()
                    ? "No customers yet. Tap \"Add customer\"." : filter === "overdue" ? "Nobody is overdue." : "No customers match."));
            }
            count.textContent = data.total + (data.total === 1 ? " customer" : " customers");
            more.hidden = !data.hasMore;
            more.textContent = "Show more (" + (data.total - data.page * data.limit) + " left)";
        } catch (error) {
            if (mine !== requestId) return;
            list.replaceChildren(h("p", { class: "form-error" }, error.message),
                h("button", { type: "button", class: "btn ghost", onclick: function () { load(true); } }, "Try again"));
        }
    }

    async function addCustomer() {
        var values = await Duka.customerDialog({ isOwner: true });
        if (!values) return;
        try {
            var data = await Duka.api("/api/customers", { method: "POST", body: values });
            Duka.flash("Customer added");
            window.location.href = "/customer.html?id=" + data.customer.id;
        } catch (error) {
            Duka.toast(error.message, "error");
        }
    }

    var timer;
    search.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(function () { load(true); }, 250); });
    sort.addEventListener("change", function () { load(true); });
    more.addEventListener("click", function () { pageNo++; load(false); });

    page.main.append(h("div", {},
        h("div", { class: "page-head" }, h("h1", {}, "Customers")),
        h("div", { class: "page-actions" }, h("button", { type: "button", class: "btn", onclick: addCustomer }, "Add customer")),
        summary,
        h("div", { class: "seg-group" }, chips),
        h("div", { class: "toolbar2" }, search, sort),
        count, list, more));
    syncChips();
    load(true);
})();
