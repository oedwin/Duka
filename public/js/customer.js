/* customer.js - one customer: what they owe, how old it is, the debt ledger, payments and reminders */
(async function () {
    "use strict";
    var h = Duka.h;
    var page = await Duka.initPage({ title: "Customer", roles: ["owner"] });
    var shopName = page.user.shopName;

    var id = new URLSearchParams(window.location.search).get("id");
    if (!id) { window.location.replace("/customers.html"); return; }

    var box = h("div", {});
    page.main.append(box);
    var data = null;

    async function load() {
        try {
            data = await Duka.api("/api/customers/" + encodeURIComponent(id));
            draw();
        } catch (error) {
            box.replaceChildren(h("p", { class: "form-error" }, error.message),
                h("a", { class: "btn ghost", href: "/customers.html" }, "Back to customers"));
        }
    }

    async function edit() {
        var values = await Duka.customerDialog({ customer: data.customer, isOwner: true });
        if (!values) return;
        try {
            await Duka.api("/api/customers/" + data.customer.id, { method: "PATCH", body: values });
            Duka.toast("Saved");
            load();
        } catch (error) {
            Duka.toast(error.message, "error");
        }
    }

    async function switchOff() {
        var c = data.customer;
        var ok = await Duka.dialog({
            title: "Switch off " + c.name + "?",
            message: "They will no longer appear at the till. Their sales and history are kept.",
            confirmText: "Switch off", danger: true
        });
        if (!ok) return;
        try {
            await Duka.api("/api/customers/" + c.id, { method: "PATCH", body: { isActive: false } });
            Duka.flash("Customer switched off");
            window.location.href = "/customers.html";
        } catch (error) {
            Duka.toast(error.message, "error");
        }
    }

    async function cancelPayment(entry) {
        var values = await Duka.dialog({
            title: "Cancel this payment?",
            message: Duka.fmt.ugx(-entry.amount) + " will be owed by " + data.customer.name + " again. The payment stays in the list, marked as cancelled.",
            fields: [{ name: "reason", label: "Why is it being cancelled?" }],
            confirmText: "Cancel payment", cancelText: "Keep it", danger: true
        });
        if (!values) return;
        try {
            await Duka.api("/api/customers/" + data.customer.id + "/payments/" + entry.paymentId + "/void", { method: "POST", body: { reason: values.reason } });
            Duka.toast("Payment cancelled");
            load();
        } catch (error) {
            Duka.toast(error.message, "error");
        }
    }

    function entryRow(e) {
        var label, link = null, struck = false;
        if (e.type === "credit_sale") { label = "Sale on credit"; link = e.saleId ? "/receipt.html?id=" + e.saleId : null; struck = e.saleVoided; }
        else if (e.type === "payment") { label = "Payment received"; link = e.paymentId ? "/payment-receipt.html?customerId=" + id + "&id=" + e.paymentId : null; struck = e.paymentVoided; }
        else if (e.type === "void_reversal") { label = e.paymentId ? "Payment cancelled" : "Sale cancelled"; }
        else if (e.type === "refund") { label = "Returned goods, taken off the debt"; }
        else if (e.type === "opening_balance") { label = "Balance brought forward"; }
        else { label = "Adjustment"; }

        var ref = e.saleReceipt ? "No. " + e.saleReceipt : e.paymentReceipt ? "Receipt " + e.paymentReceipt : "";
        var up = e.amount > 0;
        var text = [
            h("div", { class: "name" }, label + (struck ? " (cancelled)" : "")),
            h("div", { class: "sub" }, [Duka.fmt.dateTime(e.createdAt), ref, e.by].filter(Boolean).join(" \u00b7 ")),
            e.note && e.type !== "credit_sale" && e.type !== "payment" ? h("div", { class: "sub" }, e.note) : null
        ];
        return h("div", { class: "row" },
            link ? h("a", { class: "grow row-link", href: link }, text) : h("div", { class: "grow" }, text),
            h("div", { class: "price" + (struck ? " struck" : "") },
                h("span", { class: up ? "down" : "up" }, (up ? "+" : "-") + Duka.fmt.ugx(Math.abs(e.amount))),
                h("small", {}, "Owed after: " + Duka.fmt.ugx(e.balanceAfter))),
            e.type === "payment" && !e.paymentVoided
                ? h("button", { type: "button", class: "btn ghost small danger no-print", onclick: function () { cancelPayment(e); } }, "Cancel") : null);
    }

    function draw() {
        var c = data.customer;
        var d = data.debt;
        var owes = c.balance > 0;
        var available = c.creditLimit !== null ? Math.max(c.creditLimit - c.balance, 0) : null;

        var parts = [h("p", { class: "no-print" }, h("a", { href: "/customers.html" }, "\u2190 All customers"))];

        parts.push(h("div", { class: "card" },
            h("h1", {}, c.name),
            h("p", { class: "muted" }, [c.customerType === "wholesale" ? "Wholesale customer" : "Retail customer", c.phoneDisplay, c.location].filter(Boolean).join(" \u00b7 ")),
            c.notes ? h("p", {}, c.notes) : null,
            h("p", { class: "muted" },
                data.stats.sales + (data.stats.sales === 1 ? " sale" : " sales") + " worth " + Duka.fmt.ugx(data.stats.totalSold) +
                (c.creditLimit !== null ? " \u00b7 credit limit " + Duka.fmt.ugx(c.creditLimit) + " (" + Duka.fmt.ugx(available) + " left)" : " \u00b7 no credit limit")),
            h("div", { class: "actions no-print" },
                h("a", { class: "btn", href: "/pos.html?customerId=" + c.id }, "Sell to this customer"),
                h("button", { type: "button", class: "btn ghost", onclick: edit }, "Edit"),
                h("button", { type: "button", class: "btn ghost", onclick: function () { window.print(); } }, "Print statement"),
                !owes && c.balance === 0 ? h("button", { type: "button", class: "btn ghost danger", onclick: switchOff }, "Switch off") : null)));

        parts.push(h("div", { class: "card" },
            h("h2", {}, c.balance < 0 ? "They have credit with you" : "They owe you"),
            h("p", { class: "big-owed" + (owes ? " bad" : "") }, Duka.fmt.ugx(Math.abs(c.balance))),
            owes && d.since ? h("p", {}, "Owed since " + Duka.fmt.date(d.since) + " (" + d.daysOwed + (d.daysOwed === 1 ? " day" : " days") + ")") : null,
            d.overdue ? h("p", {}, h("span", { class: "badge off" }, "Overdue: more than " + d.overdueDays + " days")) : null,
            d.lastPaymentAt ? h("p", { class: "muted" }, "Last payment: " + Duka.fmt.date(d.lastPaymentAt)) : null,
            owes ? h("div", { class: "actions no-print" },
                h("button", { type: "button", class: "btn", onclick: function () { Duka.receivePayment(c); } }, "Receive payment"),
                Duka.reminderLinks(c, shopName)) : null));

        parts.push(h("div", { class: "card" },
            h("h2", {}, "Debt ledger"),
            h("p", { class: "muted" }, "Red adds to what they owe. Green is money they paid or goods they returned."),
            data.ledger.length ? data.ledger.map(entryRow) : h("p", { class: "empty" }, "Nothing yet. Sales on credit and payments will appear here.")));

        box.replaceChildren.apply(box, parts);
    }

    load();
})();
