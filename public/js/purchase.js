/* purchase.js - one purchase: what came in, what was paid, what is still owed, and cancelling a mistake */
(async function () {
    "use strict";
    var h = Duka.h;
    var page = await Duka.initPage({ title: "Purchase", roles: ["owner"] });

    var id = new URLSearchParams(window.location.search).get("id");
    if (!id) { window.location.replace("/purchases.html"); return; }

    var METHOD = { cash: "Cash", mobile_money: "Mobile Money", bank: "Bank" };
    var box = h("div", {});
    page.main.append(box);
    var purchase = null;

    async function load() {
        try {
            purchase = (await Duka.api("/api/purchases/" + encodeURIComponent(id))).purchase;
            draw();
        } catch (error) {
            box.replaceChildren(h("p", { class: "form-error" }, error.message),
                h("a", { class: "btn ghost", href: "/purchases.html" }, "Back to purchases"));
        }
    }

    async function voidPurchase() {
        var values = await Duka.dialog({
            title: "Cancel this purchase?",
            message: "The stock it added is taken off again, and anything you still owed the supplier for it is removed. It stays in your records, marked as cancelled. Cost prices that were updated are not changed back.",
            fields: [{ name: "reason", label: "Why is it being cancelled?" }],
            confirmText: "Cancel purchase", cancelText: "Keep it", danger: true
        });
        if (!values) return;
        try {
            var data = await Duka.api("/api/purchases/" + purchase.id + "/void", { method: "POST", body: { reason: values.reason } });
            purchase = data.purchase;
            Duka.toast(data.refundDue > 0 ? "Cancelled. Ask the supplier to return " + Duka.fmt.ugx(data.refundDue) : "Purchase cancelled");
            draw();
        } catch (error) {
            Duka.toast(error.message, "error");
        }
    }

    function draw() {
        var p = purchase;
        var title = p.reference === "OPENING" ? "Balance brought forward" : "Purchase" + (p.reference ? " " + p.reference : "");
        var parts = [h("p", {}, h("a", { href: "/purchases.html" }, "\u2190 All purchases"))];

        if (p.status === "voided") {
            parts.push(h("div", { class: "card" },
                h("h2", {}, "This purchase was cancelled"),
                h("p", {}, p.voidReason || ""),
                p.paid > 0 ? h("p", { class: "help bad" }, "You had paid " + Duka.fmt.ugx(p.paid) + ". Ask the supplier to give it back.") : null));
        }

        parts.push(h("div", { class: "card" },
            h("h1", {}, title),
            h("p", {}, Duka.fmt.date(p.date) + (p.by ? " \u00b7 recorded by " + p.by : "")),
            p.supplier ? h("p", {}, "Supplier: ", h("a", { href: "/supplier.html?id=" + p.supplier.id }, p.supplier.name)) : h("p", { class: "muted" }, "No supplier (paid on the spot)"),
            p.note ? h("p", { class: "muted" }, p.note) : null,
            h("div", { class: "stats" },
                h("div", { class: "stat-box" }, h("div", { class: "muted" }, "Total"), h("div", { class: "stat" }, Duka.fmt.ugx(p.total))),
                h("div", { class: "stat-box" }, h("div", { class: "muted" }, "Paid"), h("div", { class: "stat" }, Duka.fmt.ugx(p.paid))),
                h("div", { class: "stat-box" }, h("div", { class: "muted" }, "Still owed"), h("div", { class: "stat" + (p.status === "completed" && p.balanceDue > 0 ? " bad" : "") }, Duka.fmt.ugx(p.status === "completed" ? p.balanceDue : 0))))));

        if (p.items.length) {
            parts.push(h("div", { class: "card" },
                h("h2", {}, "What came in"),
                p.items.map(function (i) {
                    return h("div", { class: "row" },
                        h("div", { class: "grow" },
                            h("div", { class: "name" }, i.productName),
                            h("div", { class: "sub" }, i.quantity + " " + i.unitName + " at " + Duka.fmt.ugx(i.unitCost) + " each")),
                        h("div", { class: "price" }, Duka.fmt.ugx(i.lineTotal)));
                })));
        }

        if (p.payments.length) {
            parts.push(h("div", { class: "card" },
                h("h2", {}, "Payments"),
                p.payments.map(function (x) {
                    return h("div", { class: "row" },
                        h("div", { class: "grow" },
                            h("div", { class: "name" }, (METHOD[x.method] || x.method) + (x.reference ? " \u00b7 " + x.reference : "")),
                            h("div", { class: "sub" }, Duka.fmt.dateTime(x.paidAt) + (x.atPurchase ? " \u00b7 paid when the stock arrived" : "")),
                            x.voided ? h("div", { class: "sub down" }, "Cancelled: " + (x.voidReason || "")) : null),
                        h("div", { class: "price" + (x.voided ? " struck" : "") }, Duka.fmt.ugx(x.amount)));
                })));
        }

        if (p.status === "completed") {
            parts.push(h("div", { class: "card" },
                h("div", { class: "actions" },
                    p.supplier && p.balanceDue > 0 ? h("a", { class: "btn", href: "/supplier.html?id=" + p.supplier.id }, "Pay supplier") : null,
                    h("button", { type: "button", class: "btn ghost danger", onclick: voidPurchase }, "Cancel this purchase"))));
        }

        box.replaceChildren.apply(box, parts);
    }

    load();
})();
