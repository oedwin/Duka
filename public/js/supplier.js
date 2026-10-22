/* supplier.js - one supplier: what you owe, their purchases and payments, and paying them */
(async function () {
    "use strict";
    var h = Duka.h;
    var page = await Duka.initPage({ title: "Supplier", roles: ["owner"] });

    var id = new URLSearchParams(window.location.search).get("id");
    if (!id) { window.location.replace("/suppliers.html"); return; }

    var METHOD = { cash: "Cash", mobile_money: "Mobile Money", bank: "Bank" };
    var box = h("div", {});
    page.main.append(box);
    var data = null;

    async function load() {
        try {
            data = await Duka.api("/api/suppliers/" + encodeURIComponent(id));
            draw();
        } catch (error) {
            box.replaceChildren(h("p", { class: "form-error" }, error.message),
                h("a", { class: "btn ghost", href: "/suppliers.html" }, "Back to suppliers"));
        }
    }

    // ---------- paying ----------
    function pay() {
        var s = data.supplier;
        var uuid = Duka.uuid(); // one id for this payment, so pressing Save twice cannot pay twice
        var amount = h("input", { class: "input", type: "number", inputmode: "numeric", min: "1", step: "1", "aria-label": "Amount" });
        var method = h("select", { class: "input", "aria-label": "How you paid" },
            h("option", { value: "cash" }, "Cash"), h("option", { value: "mobile_money" }, "Mobile Money"), h("option", { value: "bank" }, "Bank"));
        var reference = h("input", { class: "input", type: "text", maxlength: "80", placeholder: "Reference number (optional)", "aria-label": "Reference" });
        var note = h("input", { class: "input", type: "text", maxlength: "300", placeholder: "Note (optional)", "aria-label": "Note" });
        var errorBox = h("p", { class: "form-error", role: "alert", hidden: true });
        var full = h("button", { type: "button", class: "btn ghost small" }, "Pay everything: " + Duka.fmt.ugx(s.balance));
        full.addEventListener("click", function () { amount.value = String(s.balance); });
        var cancel = h("button", { type: "button", class: "btn ghost" }, "Cancel");
        var save = h("button", { type: "button", class: "btn" }, "Save payment");

        var modal = Duka.modal(h("div", {},
            h("h2", {}, "Pay " + s.name),
            h("p", { class: "muted" }, "You owe " + Duka.fmt.ugx(s.balance) + ". The money is taken off their oldest unpaid purchases first."),
            h("div", { class: "field" }, h("label", {}, "Amount (UGX)"), amount, full),
            h("div", { class: "field" }, h("label", {}, "How you paid"), method),
            h("div", { class: "field" }, reference),
            h("div", { class: "field" }, note),
            errorBox, h("div", { class: "actions" }, cancel, save)), { sticky: true });
        cancel.addEventListener("click", function () { modal.close(); });
        amount.focus();

        save.addEventListener("click", async function () {
            errorBox.hidden = true;
            var value = parseInt(amount.value, 10);
            if (!(value > 0)) { errorBox.textContent = "Enter the amount you paid."; errorBox.hidden = false; return; }
            if (value > s.balance) { errorBox.textContent = "You only owe " + Duka.fmt.ugx(s.balance) + "."; errorBox.hidden = false; return; }
            Duka.busy(save, true, "Saving...");
            try {
                await Duka.api("/api/suppliers/" + s.id + "/payments", {
                    method: "POST", safeToRetry: true,
                    body: { clientUuid: uuid, amount: value, method: method.value, reference: reference.value.trim(), note: note.value.trim() }
                });
                modal.close();
                Duka.toast("Payment saved");
                load();
            } catch (error) {
                errorBox.textContent = error.message;
                errorBox.hidden = false;
                Duka.busy(save, false);
            }
        });
    }

    async function cancelPayment(p) {
        var values = await Duka.dialog({
            title: "Cancel this payment?",
            message: Duka.fmt.ugx(p.amount) + " will be owed to the supplier again. The payment stays in the list, marked as cancelled.",
            fields: [{ name: "reason", label: "Why is it being cancelled?" }],
            confirmText: "Cancel payment", cancelText: "Keep it", danger: true
        });
        if (!values) return;
        try {
            await Duka.api("/api/suppliers/" + data.supplier.id + "/payments/" + p.id + "/void", { method: "POST", body: { reason: values.reason } });
            Duka.toast("Payment cancelled");
            load();
        } catch (error) {
            Duka.toast(error.message, "error");
        }
    }

    async function edit() {
        var s = data.supplier;
        var values = await Duka.dialog({
            title: "Edit supplier", confirmText: "Save",
            fields: [
                { name: "name", label: "Supplier name", value: s.name },
                { name: "phone", label: "Phone number", type: "tel", inputmode: "tel", value: s.phoneDisplay || "", required: false },
                { name: "productsSupplied", label: "What they supply", value: s.productsSupplied || "", required: false },
                { name: "notes", label: "Notes", value: s.notes || "", required: false }
            ]
        });
        if (!values) return;
        try {
            await Duka.api("/api/suppliers/" + s.id, { method: "PATCH", body: values });
            Duka.toast("Saved");
            load();
        } catch (error) {
            Duka.toast(error.message, "error");
        }
    }

    async function switchOff() {
        var s = data.supplier;
        var ok = await Duka.dialog({
            title: "Switch off " + s.name + "?",
            message: "They will no longer appear when you record a purchase. Their history is kept.",
            confirmText: "Switch off", danger: true
        });
        if (!ok) return;
        try {
            await Duka.api("/api/suppliers/" + s.id, { method: "PATCH", body: { isActive: false } });
            Duka.flash("Supplier switched off");
            window.location.href = "/suppliers.html";
        } catch (error) {
            Duka.toast(error.message, "error");
        }
    }

    // ---------- the page ----------
    function draw() {
        var s = data.supplier;
        var links = [];
        if (s.phone) {
            links.push(h("a", { class: "btn ghost small", href: "tel:+" + s.phone }, "Call"));
            links.push(h("a", { class: "btn ghost small", href: "https://wa.me/" + s.phone, target: "_blank", rel: "noopener" }, "WhatsApp"));
        }

        var parts = [
            h("p", {}, h("a", { href: "/suppliers.html" }, "\u2190 All suppliers")),
            h("div", { class: "card" },
                h("h1", {}, s.name),
                s.phoneDisplay ? h("p", {}, s.phoneDisplay) : null,
                s.productsSupplied ? h("p", { class: "muted" }, s.productsSupplied) : null,
                s.notes ? h("p", { class: "muted" }, s.notes) : null,
                links.length ? h("div", { class: "actions" }, links) : null,
                !s.isActive ? h("p", { class: "badge off" }, "Switched off") : null),
            h("div", { class: "card" },
                h("h2", {}, "You owe"),
                h("p", { class: "big-owed" + (s.balance > 0 ? " bad" : "") }, Duka.fmt.ugx(s.balance)),
                h("div", { class: "actions" },
                    s.balance > 0 ? h("button", { type: "button", class: "btn", onclick: pay }, "Pay supplier") : null,
                    h("a", { class: "btn ghost", href: "/purchase-form.html?supplierId=" + s.id }, "Record a purchase"),
                    h("button", { type: "button", class: "btn ghost", onclick: edit }, "Edit"),
                    s.isActive && s.balance === 0 ? h("button", { type: "button", class: "btn ghost danger", onclick: switchOff }, "Switch off") : null))
        ];

        parts.push(h("div", { class: "card" },
            h("h2", {}, "Purchases"),
            data.purchases.length ? data.purchases.map(function (p) {
                var label = p.reference === "OPENING" ? "Balance brought forward" : (p.reference ? "Invoice " + p.reference : "Purchase");
                return h("a", { class: "row link", href: "/purchase.html?id=" + p.id },
                    h("div", { class: "grow" },
                        h("div", { class: "name" }, label),
                        h("div", { class: "sub" }, Duka.fmt.date(p.date) + (p.status === "voided" ? " \u00b7 Cancelled" : "")),
                        p.status === "completed" && p.balanceDue > 0 ? h("div", { class: "badges" }, h("span", { class: "badge warn" }, "Still owed " + Duka.fmt.ugx(p.balanceDue))) : null),
                    h("div", { class: "price" + (p.status === "voided" ? " struck" : "") }, Duka.fmt.ugx(p.total), h("small", {}, "paid " + Duka.fmt.ugx(p.paid))));
            }) : h("p", { class: "empty" }, "No purchases yet.")));

        parts.push(h("div", { class: "card" },
            h("h2", {}, "Payments to this supplier"),
            data.payments.length ? data.payments.map(function (p) {
                var what = p.atPurchase ? "Paid when the stock arrived"
                    : p.purchaseId ? "For " + (p.purchaseReference === "OPENING" ? "balance brought forward" : p.purchaseReference ? "invoice " + p.purchaseReference : "purchase of " + Duka.fmt.date(p.purchaseDate)) : "";
                return h("div", { class: "row" },
                    h("div", { class: "grow" },
                        h("div", { class: "name" }, (METHOD[p.method] || p.method) + (p.reference ? " \u00b7 " + p.reference : "")),
                        h("div", { class: "sub" }, Duka.fmt.dateTime(p.paidAt) + (what ? " \u00b7 " + what : "")),
                        p.voided ? h("div", { class: "sub down" }, "Cancelled: " + (p.voidReason || "")) : null),
                    h("div", { class: "price" + (p.voided ? " struck" : "") }, Duka.fmt.ugx(p.amount)),
                    !p.voided && !p.atPurchase ? h("button", { type: "button", class: "btn ghost small danger", onclick: function () { cancelPayment(p); } }, "Cancel") : null);
            }) : h("p", { class: "empty" }, "No payments yet.")));

        box.replaceChildren.apply(box, parts);
    }

    load();
})();
