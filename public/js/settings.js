/* settings.js - business details, receipts, stock defaults (owner only) */
(async function () {
    "use strict";
    var h = Duka.h;
    var page = await Duka.initPage({ title: "Settings", roles: ["owner"] });
    var logoData; // undefined = unchanged, "" = remove, "data:..." = new picture

    var loading = h("p", { class: "empty" }, "Loading...");
    page.main.append(h("div", { class: "page-head" }, h("h1", {}, "Settings")), loading);

    var settings;
    try {
        settings = (await Duka.api("/api/settings")).settings;
    } catch (error) {
        loading.className = "form-error";
        loading.textContent = error.message;
        return;
    }
    loading.remove();

    function field(id, label, input, help) {
        return h("div", { class: "field" },
            h("label", { for: id }, label), input,
            help ? h("span", { class: "help" }, help) : null);
    }
    function text(id, value, attrs) {
        return h("input", Object.assign({ class: "input", id: id, name: id, type: "text", value: value || "" }, attrs || {}));
    }

    var shopName = text("shopName", settings.shopName);
    var phone = text("phone", settings.phone, { type: "tel", inputmode: "tel" });
    var address = text("address", settings.address);
    var tin = text("tin", settings.tin);
    var footer = h("textarea", { class: "input", id: "receiptFooter", name: "receiptFooter" }, settings.receiptFooter || "");
    var paper = h("select", { class: "input", id: "receiptPaper", name: "receiptPaper" },
        [["58mm", "Small receipt printer (58mm)"], ["80mm", "Receipt printer (80mm)"], ["A4", "Normal paper (A4)"]]
            .map(function (opt) { return h("option", { value: opt[0], selected: opt[0] === settings.receiptPaper }, opt[1]); }));
    var lowStock = text("lowStockDefault", String(settings.lowStockDefault), { type: "number", inputmode: "numeric", min: "0" });
    var negative = h("input", { type: "checkbox", id: "allowNegativeStock", checked: settings.allowNegativeStock });
    var overdue = text("overdueDays", String(settings.overdueDays || 30), { type: "number", inputmode: "numeric", min: "1" });
    var language = h("select", { class: "input", id: "language", name: "language" },
        h("option", { value: "en", selected: true }, "English"));

    // Logo
    var preview = h("img", { class: "logo-preview", alt: "Shop logo", hidden: !settings.logo, src: settings.logo || null });
    var fileInput = h("input", { type: "file", id: "logoFile", accept: "image/png,image/jpeg" });
    var removeLogo = h("button", { class: "btn ghost small", type: "button", hidden: !settings.logo }, "Remove logo");
    fileInput.addEventListener("change", async function () {
        if (!fileInput.files[0]) return;
        try {
            logoData = await Duka.resizeImage(fileInput.files[0], 240);
            preview.src = logoData;
            preview.hidden = false;
            removeLogo.hidden = false;
        } catch (error) {
            Duka.toast(error.message, "error");
        }
    });
    removeLogo.addEventListener("click", function () {
        logoData = "";
        preview.hidden = true;
        removeLogo.hidden = true;
        fileInput.value = "";
    });

    var errorBox = h("p", { class: "form-error", role: "alert", hidden: true });
    var save = h("button", { class: "btn block", type: "submit" }, "Save settings");

    var form = h("form", { novalidate: true },
        h("div", { class: "card" },
            h("h2", {}, "Your shop"),
            field("shopName", "Shop name", shopName),
            field("phone", "Phone number", phone, "Printed on receipts."),
            field("address", "Address", address),
            field("tin", "TIN (optional)", tin, "Your tax number, if you have one."),
            h("div", { class: "field" },
                h("span", { class: "label" }, "Logo (optional)"),
                preview, fileInput, h("div", {}, removeLogo))),
        h("div", { class: "card" },
            h("h2", {}, "Receipts"),
            field("receiptFooter", "Message at the bottom of the receipt", footer),
            field("receiptPaper", "Paper size", paper)),
        h("div", { class: "card" },
            h("h2", {}, "Stock"),
            field("lowStockDefault", "Warn me when stock is at or below", lowStock,
                "Used for products that do not have their own low stock level."),
            h("label", { class: "check", for: "allowNegativeStock" }, negative,
                "Allow selling when the system shows no stock left")),
        h("div", { class: "card" },
            h("h2", {}, "Customers and credit"),
            field("overdueDays", "A debt is overdue after (days)", overdue,
                "Customers who have owed you for longer than this are marked Overdue.")),
        h("div", { class: "card" },
            h("h2", {}, "Language"),
            field("language", "App language", language)),
        errorBox, save);

    form.addEventListener("submit", async function (event) {
        event.preventDefault();
        errorBox.hidden = true;

        var body = {
            shopName: shopName.value,
            phone: phone.value,
            address: address.value,
            tin: tin.value,
            receiptFooter: footer.value,
            receiptPaper: paper.value,
            lowStockDefault: lowStock.value,
            overdueDays: overdue.value,
            allowNegativeStock: negative.checked,
            language: language.value
        };
        if (logoData !== undefined) body.logo = logoData;

        Duka.busy(save, true, "Saving...");
        try {
            var data = await Duka.api("/api/settings", { method: "PUT", body: body });
            logoData = undefined;
            // Keep the name in the top bar up to date
            var user = Duka.auth.user();
            if (user) {
                user.shopName = data.settings.shopName;
                Duka.auth.saveUser(user);
                var bar = document.querySelector(".topbar .shopname");
                if (bar) bar.textContent = user.shopName;
            }
            Duka.toast("Settings saved");
        } catch (error) {
            errorBox.textContent = error.message;
            errorBox.hidden = false;
            window.scrollTo({ top: document.body.scrollHeight });
        }
        Duka.busy(save, false);
    });

    page.main.append(form);
})();
