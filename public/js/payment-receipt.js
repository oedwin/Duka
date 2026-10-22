/* payment-receipt.js - the receipt for money a customer paid towards what they owe */
(async function () {
    "use strict";
    var h = Duka.h;
    var page = await Duka.initPage({ title: "Payment receipt", roles: ["owner"] });

    var params = new URLSearchParams(window.location.search);
    var customerId = params.get("customerId");
    var id = params.get("id");
    var justPaid = params.get("new") === "1";
    if (!customerId || !id) { window.location.replace("/customers.html"); return; }

    var box = h("div", {});
    page.main.append(box);
    var pay = null;

    function setPaperSize() {
        var paper = pay.shop.paper;
        var css = paper === "A4" ? "@page { size: A4; margin: 12mm; }" : "@page { size: " + paper + " auto; margin: 2mm; }";
        var style = document.getElementById("pageStyle");
        if (!style) { style = document.createElement("style"); style.id = "pageStyle"; document.head.appendChild(style); }
        style.textContent = css;
    }

    function whatsapp() {
        var phone = pay.customer.phone || "";
        window.open("https://wa.me/" + phone + "?text=" + encodeURIComponent(Duka.receipt.toText(pay)), "_blank", "noopener");
    }

    async function sharePicture() {
        try {
            var blob = await Duka.receipt.toImage(pay);
            var name = "payment-" + (pay.receiptNumber || pay.id) + ".png";
            var file = new File([blob], name, { type: "image/png" });
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                await navigator.share({ files: [file], title: "Payment receipt " + (pay.receiptNumber || "") });
            } else {
                var url = URL.createObjectURL(blob);
                var link = h("a", { href: url, download: name });
                document.body.appendChild(link);
                link.click();
                link.remove();
                setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
            }
        } catch (error) {
            if (error && error.name === "AbortError") return;
            Duka.toast(error.message || "The picture could not be shared.", "error");
        }
    }

    function draw() {
        pay.kind = "payment";
        setPaperSize();
        var parts = [];
        if (justPaid && !pay.voided) {
            parts.push(h("div", { class: "card done no-print" },
                h("h2", {}, "Payment received"),
                h("p", { class: "stat" }, Duka.fmt.ugx(pay.amount)),
                pay.balanceAfter > 0
                    ? h("p", { class: "help bad" }, pay.customer.name + " still owes " + Duka.fmt.ugx(pay.balanceAfter))
                    : h("p", { class: "help good" }, pay.customer.name + " has paid everything."),
                h("a", { class: "btn block big", href: "/customer.html?id=" + pay.customer.id }, "Back to " + pay.customer.name)));
        }
        parts.push(h("div", { class: "page-actions no-print" },
            h("button", { type: "button", class: "btn", onclick: function () { window.print(); } }, "Print"),
            h("button", { type: "button", class: "btn ghost", onclick: whatsapp }, "WhatsApp"),
            h("button", { type: "button", class: "btn ghost", onclick: sharePicture }, "Share picture"),
            h("a", { class: "btn ghost", href: "/customer.html?id=" + pay.customer.id }, "Customer")));
        parts.push(Duka.receipt.render(pay));
        if (pay.voided) {
            parts.push(h("div", { class: "card no-print" }, h("h2", {}, "This payment was cancelled"), h("p", {}, pay.voidReason || "")));
        }
        box.replaceChildren.apply(box, parts);
    }

    try {
        pay = (await Duka.api("/api/customers/" + encodeURIComponent(customerId) + "/payments/" + encodeURIComponent(id))).payment;
        draw();
    } catch (error) {
        box.replaceChildren(h("p", { class: "form-error" }, error.message),
            h("a", { class: "btn ghost", href: "/customers.html" }, "Back to customers"));
    }
})();
