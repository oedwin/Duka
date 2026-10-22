/* receipt-page.js - one sale: the receipt, print / WhatsApp / picture,
   and (owner only) returns and voiding. */
(async function () {
    "use strict";
    var h = Duka.h;
    var page = await Duka.initPage({ title: "Receipt" });
    var isOwner = page.user.role === "owner";

    var params = new URLSearchParams(window.location.search);
    var id = params.get("id");
    var justSold = params.get("new") === "1";
    if (!id) { window.location.replace("/sales.html"); return; }

    var METHOD_NAME = { cash: "Cash", mobile_money: "Mobile Money", bank: "Bank" };
    var box = h("div", {});
    page.main.append(box);
    var sale = null;

    async function load() {
        try {
            sale = (await Duka.api("/api/sales/" + encodeURIComponent(id))).sale;
            draw();
        } catch (error) {
            box.replaceChildren(
                h("p", { class: "form-error" }, error.message),
                h("a", { class: "btn ghost", href: "/sales.html" }, "Back to sales"));
        }
    }

    // ---------- printing, sharing ----------
    function setPaperSize() {
        var paper = sale.shop.paper;
        var css = paper === "A4" ? "@page { size: A4; margin: 12mm; }" : "@page { size: " + paper + " auto; margin: 2mm; }";
        var style = document.getElementById("pageStyle");
        if (!style) { style = document.createElement("style"); style.id = "pageStyle"; document.head.appendChild(style); }
        style.textContent = css;
    }

    function whatsapp() {
        var phone = sale.customer && sale.customer.phone ? sale.customer.phone : "";
        var url = "https://wa.me/" + phone + "?text=" + encodeURIComponent(Duka.receipt.toText(sale));
        window.open(url, "_blank", "noopener");
    }

    async function sharePicture() {
        try {
            var blob = await Duka.receipt.toImage(sale);
            var name = "receipt-" + (sale.receiptNumber || sale.id) + ".png";
            var file = new File([blob], name, { type: "image/png" });
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                await navigator.share({ files: [file], title: "Receipt " + (sale.receiptNumber || "") });
            } else {
                var url = URL.createObjectURL(blob);
                var link = h("a", { href: url, download: name });
                document.body.appendChild(link);
                link.click();
                link.remove();
                setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
            }
        } catch (error) {
            if (error && error.name === "AbortError") return; // the person closed the share sheet
            Duka.toast(error.message || "The picture could not be shared.", "error");
        }
    }

    // ---------- void ----------
    async function voidSale() {
        var values = await Duka.dialog({
            title: "Void sale " + sale.receiptNumber + "?",
            message: "The stock goes back on the shelf and any debt from this sale is taken off the customer. The sale stays in your records, marked as voided.",
            fields: [{ name: "reason", label: "Why is it being voided?" }],
            confirmText: "Void sale", danger: true
        });
        if (!values) return;
        try {
            var data = await Duka.api("/api/sales/" + sale.id + "/void", { method: "POST", body: { reason: values.reason } });
            sale = data.sale;
            Duka.toast("Sale voided");
            draw();
        } catch (error) {
            Duka.toast(error.message, "error");
        }
    }

    // ---------- returns ----------
    function returnItems() {
        var returnId = Duka.uuid(); // one id for this return, so sending it twice cannot refund twice
        var rows = [];
        var estimate = h("p", { class: "stat" });
        var errorBox = h("p", { class: "form-error", role: "alert", hidden: true });
        var reason = h("input", { class: "input", type: "text", maxlength: "300", "aria-label": "Reason" });

        var methods = [["cash", "Cash"], ["mobile_money", "Mobile Money"], ["bank", "Bank"]];
        if (sale.customer) methods.push(["credit_note", "Take it off what they owe"]);
        var method = h("select", { class: "input", "aria-label": "Refund method" },
            methods.map(function (m) { return h("option", { value: m[0] }, m[1]); }));
        method.value = sale.customer && sale.balanceDue > 0 ? "credit_note" : "cash";

        function refundFor(item, qty) {
            return sale.subtotal > 0 ? Math.round((qty * item.unitPrice * sale.totalAmount) / sale.subtotal) : 0;
        }
        function update() {
            var total = rows.reduce(function (sum, r) { return sum + refundFor(r.item, parseInt(r.qty.value, 10) || 0); }, 0);
            estimate.textContent = "Money back: " + Duka.fmt.ugx(total);
        }

        var itemsBox = h("div", {});
        sale.items.forEach(function (item) {
            var left = item.quantity - item.returnedQty;
            if (left <= 0) return;
            var qty = h("input", { class: "input qty-input", type: "number", inputmode: "numeric", min: "0", max: String(left), step: "1", value: "0", "aria-label": "Quantity returned" });
            qty.addEventListener("input", update);
            rows.push({ item: item, qty: qty, left: left });
            itemsBox.appendChild(h("div", { class: "row" },
                h("div", { class: "grow" },
                    h("div", { class: "name" }, item.productName),
                    h("div", { class: "sub" }, "Sold " + item.quantity + " " + item.unitName + (item.returnedQty ? " \u00b7 already returned " + item.returnedQty : ""))),
                qty));
        });

        var cancel = h("button", { type: "button", class: "btn ghost" }, "Cancel");
        var save = h("button", { type: "button", class: "btn" }, "Save return");
        var modal = Duka.modal(h("div", {},
            h("h2", {}, "Return items"),
            h("p", { class: "muted" }, "Enter how many of each item the customer brings back."),
            itemsBox, estimate,
            h("div", { class: "field" }, h("label", {}, "Give the money back as"), method),
            h("div", { class: "field" }, h("label", {}, "Reason for the return"), reason),
            errorBox,
            h("div", { class: "actions" }, cancel, save)), { sticky: true });

        cancel.addEventListener("click", function () { modal.close(); });
        save.addEventListener("click", async function () {
            errorBox.hidden = true;
            var items = [];
            for (var i = 0; i < rows.length; i++) {
                var qty = parseInt(rows[i].qty.value, 10) || 0;
                if (qty > rows[i].left) { errorBox.textContent = "You can return at most " + rows[i].left + " of " + rows[i].item.productName + "."; errorBox.hidden = false; return; }
                if (qty > 0) items.push({ saleItemId: rows[i].item.id, quantity: qty });
            }
            if (items.length === 0) { errorBox.textContent = "Enter the quantity of at least one item."; errorBox.hidden = false; return; }
            if (!reason.value.trim()) { errorBox.textContent = "Please write the reason for the return."; errorBox.hidden = false; return; }

            Duka.busy(save, true, "Saving...");
            try {
                var data = await Duka.api("/api/sales/" + sale.id + "/returns", {
                    method: "POST", safeToRetry: true,
                    body: { clientUuid: returnId, items: items, refundMethod: method.value, reason: reason.value.trim() }
                });
                sale = data.sale;
                modal.close();
                Duka.toast(data.duplicate ? "This return was already saved" : "Return saved");
                draw();
            } catch (error) {
                errorBox.textContent = error.message;
                errorBox.hidden = false;
                Duka.busy(save, false);
            }
        });
        update();
    }

    // ---------- the page ----------
    function draw() {
        setPaperSize();
        var parts = [];

        if (justSold && sale.status === "completed") {
            parts.push(h("div", { class: "card done no-print" },
                h("h2", {}, "Sale saved"),
                h("p", { class: "stat" }, Duka.fmt.ugx(sale.totalAmount)),
                sale.balanceDue > 0 && sale.customer
                    ? h("p", { class: "help bad" }, Duka.fmt.ugx(sale.balanceDue) + " on credit to " + sale.customer.name) : null,
                h("a", { class: "btn block big", href: "/pos.html" }, "New sale")));
        }

        parts.push(h("div", { class: "page-actions no-print" },
            h("button", { type: "button", class: "btn", onclick: function () { window.print(); } }, "Print"),
            h("button", { type: "button", class: "btn ghost", onclick: whatsapp }, "WhatsApp"),
            h("button", { type: "button", class: "btn ghost", onclick: sharePicture }, "Share picture"),
            h("a", { class: "btn ghost", href: "/sales.html" }, "All sales")));

        parts.push(Duka.receipt.render(sale));

        if (sale.status === "voided") {
            parts.push(h("div", { class: "card no-print" },
                h("h2", {}, "This sale was voided"),
                h("p", {}, sale.voidReason),
                h("p", { class: "muted" }, "By " + (sale.voidedBy || "the owner") + ", " + Duka.fmt.dateTime(sale.voidedAt))));
        }

        if (sale.returns.length) {
            var names = {};
            sale.items.forEach(function (i) { names[i.id] = i.productName + " (" + i.unitName + ")"; });
            parts.push(h("div", { class: "card no-print" },
                h("h2", {}, "Returns"),
                sale.returns.map(function (r) {
                    var how = r.refundMethod === "credit_note" ? "taken off what they owe" : METHOD_NAME[r.refundMethod] || r.refundMethod;
                    return h("div", { class: "row" },
                        h("div", { class: "grow" },
                            h("div", { class: "name" }, r.quantity + " \u00d7 " + names[r.saleItemId]),
                            h("div", { class: "sub" }, r.reason + " \u00b7 " + Duka.fmt.dateTime(r.createdAt))),
                        h("div", { class: "price" }, Duka.fmt.ugx(r.refundAmount), h("small", {}, how)));
                })));
        }

        if (isOwner && sale.status === "completed") {
            var canReturn = sale.items.some(function (i) { return i.returnedQty < i.quantity; });
            parts.push(h("div", { class: "card no-print" },
                h("h2", {}, "Profit on this sale"),
                h("p", { class: "stat" }, Duka.fmt.ugx(sale.profit)),
                h("p", { class: "muted" },
                    sale.refundedTotal > 0
                        ? "Sold for " + Duka.fmt.ugx(sale.totalAmount) + ", minus " + Duka.fmt.ugx(sale.refundedTotal) + " given back for returns = " + Duka.fmt.ugx(sale.netTotal) +
                          ". The goods that were kept cost " + Duka.fmt.ugx(sale.cogs - sale.returnedCost) + "."
                        : "Sold for " + Duka.fmt.ugx(sale.totalAmount) + ", the goods cost " + Duka.fmt.ugx(sale.cogs) + "."),
                h("div", { class: "actions" },
                    canReturn ? h("button", { type: "button", class: "btn ghost", onclick: returnItems }, "Return items") : null,
                    sale.returns.length === 0 ? h("button", { type: "button", class: "btn ghost danger", onclick: voidSale }, "Void this sale") : null)));
        }

        box.replaceChildren.apply(box, parts);
    }

    load();
})();
