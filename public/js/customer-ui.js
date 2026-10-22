/* customer-ui.js - pieces shared by the customer screens:
     Duka.customerDialog({customer, isOwner})   add or edit form
     Duka.receivePayment(customer)              take money towards a debt, then show the receipt
     Duka.reminderLinks(customer, shopName)     Call / WhatsApp / SMS buttons for a reminder */
(function () {
    "use strict";
    var Duka = (window.Duka = window.Duka || {});
    var h = Duka.h;

    // ---------- add / edit a customer ----------
    Duka.customerDialog = function (opts) {
        opts = opts || {};
        var c = opts.customer || null;
        var isNew = !c;
        var isOwner = !!opts.isOwner;

        return new Promise(function (resolve) {
            var done = false;
            function field(label, input, help) {
                return h("div", { class: "field" }, h("label", {}, label), input, help ? h("span", { class: "help" }, help) : null);
            }
            var name = h("input", { class: "input", type: "text", maxlength: "150", autocomplete: "off", value: c ? c.name : "", "aria-label": "Name" });
            var phone = h("input", { class: "input", type: "tel", inputmode: "tel", placeholder: "0772 123 456", value: c && c.phoneDisplay ? c.phoneDisplay : "", "aria-label": "Phone" });
            var location = h("input", { class: "input", type: "text", maxlength: "150", value: c && c.location ? c.location : "", "aria-label": "Location" });
            var type = h("select", { class: "input", "aria-label": "Customer type" },
                h("option", { value: "retail" }, "Retail customer"), h("option", { value: "wholesale" }, "Wholesale customer"));
            type.value = c ? c.customerType : "retail";
            var limit = h("input", { class: "input", type: "number", inputmode: "numeric", min: "0", step: "1", value: c && c.creditLimit !== null ? String(c.creditLimit) : "", "aria-label": "Credit limit" });
            var notes = h("input", { class: "input", type: "text", maxlength: "500", value: c && c.notes ? c.notes : "", "aria-label": "Notes" });
            var opening = h("input", { class: "input", type: "number", inputmode: "numeric", min: "0", step: "1", "aria-label": "Money already owed" });
            var since = h("input", { class: "input", type: "date", "aria-label": "Owed since" });
            var errorBox = h("p", { class: "form-error", role: "alert", hidden: true });
            var cancel = h("button", { type: "button", class: "btn ghost" }, "Cancel");
            var save = h("button", { type: "submit", class: "btn" }, isNew ? "Add customer" : "Save");

            var form = h("form", { novalidate: true },
                h("h2", {}, isNew ? "New customer" : "Edit customer"),
                field("Name", name),
                field("Phone number", phone, "Used for call, WhatsApp and SMS reminders."),
                field("Location", location),
                field("Customer type", type),
                isOwner ? field("Credit limit (UGX)", limit, "The most they may owe you. Leave empty for no limit.") : null,
                isOwner ? field("Notes", notes) : null,
                isNew && isOwner ? field("Money they already owe you (UGX)", opening, "Only if they owed you before you started using Duka.") : null,
                isNew && isOwner ? field("Owed since (date)", since, "Leave empty for today. Used to show how old the debt is.") : null,
                errorBox, h("div", { class: "actions" }, cancel, save));

            var modal = Duka.modal(form, { sticky: true, onClose: function () { if (!done) resolve(null); } });
            cancel.addEventListener("click", function () { modal.close(); });
            name.focus();
            form.addEventListener("submit", function (event) {
                event.preventDefault();
                if (!name.value.trim()) { errorBox.textContent = "Enter the customer's name."; errorBox.hidden = false; return; }
                var values = { name: name.value.trim(), phone: phone.value.trim(), location: location.value.trim(), customerType: type.value };
                if (isOwner) { values.creditLimit = limit.value.trim(); values.notes = notes.value.trim(); }
                if (isNew && isOwner) { values.openingBalance = opening.value.trim(); values.owedSince = since.value || null; }
                done = true;
                modal.close();
                resolve(values);
            });
        });
    };

    // ---------- receive a payment ----------
    Duka.receivePayment = function (customer) {
        var uuid = Duka.uuid(); // one id for this payment, so pressing Save twice cannot take the money twice
        var amount = h("input", { class: "input", type: "number", inputmode: "numeric", min: "1", step: "1", "aria-label": "Amount" });
        var method = h("select", { class: "input", "aria-label": "How they paid" },
            h("option", { value: "cash" }, "Cash"), h("option", { value: "mobile_money" }, "Mobile Money"), h("option", { value: "bank" }, "Bank"));
        var provider = h("select", { class: "input", "aria-label": "Mobile money network" },
            h("option", { value: "mtn" }, "MTN"), h("option", { value: "airtel" }, "Airtel"));
        var reference = h("input", { class: "input", type: "text", maxlength: "80", placeholder: "Reference number", "aria-label": "Reference" });
        var mobile = h("div", { class: "pair", hidden: true }, provider, reference);
        var note = h("input", { class: "input", type: "text", maxlength: "300", placeholder: "Note (optional)", "aria-label": "Note" });
        var left = h("p", { class: "help" });
        var errorBox = h("p", { class: "form-error", role: "alert", hidden: true });
        var full = h("button", { type: "button", class: "btn ghost small" }, "They pay everything: " + Duka.fmt.ugx(customer.balance));
        var cancel = h("button", { type: "button", class: "btn ghost" }, "Cancel");
        var save = h("button", { type: "button", class: "btn" }, "Save payment");

        function update() {
            var v = parseInt(amount.value, 10) || 0;
            left.textContent = v > 0 ? "Still owed after this: " + Duka.fmt.ugx(Math.max(customer.balance - v, 0)) : "";
            mobile.hidden = method.value !== "mobile_money";
        }
        amount.addEventListener("input", update);
        method.addEventListener("change", update);
        full.addEventListener("click", function () { amount.value = String(customer.balance); update(); });

        var modal = Duka.modal(h("div", {},
            h("h2", {}, "Receive payment from " + customer.name),
            h("p", { class: "muted" }, "They owe " + Duka.fmt.ugx(customer.balance) + ". The money is counted against their oldest debt first."),
            h("div", { class: "field" }, h("label", {}, "Amount received (UGX)"), amount, full, left),
            h("div", { class: "field" }, h("label", {}, "How they paid"), method),
            mobile,
            h("div", { class: "field" }, note),
            errorBox, h("div", { class: "actions" }, cancel, save)), { sticky: true });
        cancel.addEventListener("click", function () { modal.close(); });
        amount.focus();
        update();

        save.addEventListener("click", async function () {
            errorBox.hidden = true;
            var value = parseInt(amount.value, 10);
            if (!(value > 0)) { errorBox.textContent = "Enter the amount received."; errorBox.hidden = false; return; }
            if (value > customer.balance) { errorBox.textContent = customer.name + " only owes " + Duka.fmt.ugx(customer.balance) + "."; errorBox.hidden = false; return; }
            Duka.busy(save, true, "Saving...");
            try {
                var data = await Duka.api("/api/customers/" + customer.id + "/payments", {
                    method: "POST", safeToRetry: true,
                    body: {
                        clientUuid: uuid, amount: value, method: method.value,
                        provider: method.value === "mobile_money" ? provider.value : undefined,
                        reference: method.value === "mobile_money" ? reference.value.trim() : undefined,
                        note: note.value.trim()
                    }
                });
                window.location.href = "/payment-receipt.html?customerId=" + customer.id + "&id=" + data.paymentId + "&new=1";
            } catch (error) {
                errorBox.textContent = error.network
                    ? "We could not confirm the payment because of the connection. Press Save payment again: it is safe and will not be taken twice."
                    : error.message;
                errorBox.hidden = false;
                Duka.busy(save, false);
            }
        });
    };

    // ---------- one-tap reminders ----------
    Duka.reminderLinks = function (customer, shopName) {
        if (!customer.phone || !(customer.balance > 0)) return [];
        var text = "Hello " + customer.name + ", this is a reminder from " + (shopName || "our shop") +
            ". You owe " + Duka.fmt.ugx(customer.balance) + ". Please pay when you can. Thank you.";
        return [
            h("a", { class: "btn ghost small", href: "tel:+" + customer.phone }, "Call"),
            h("a", { class: "btn ghost small", href: "https://wa.me/" + customer.phone + "?text=" + encodeURIComponent(text), target: "_blank", rel: "noopener" }, "WhatsApp"),
            h("a", { class: "btn ghost small", href: "sms:+" + customer.phone + "?body=" + encodeURIComponent(text) }, "SMS")
        ];
    };
})();
