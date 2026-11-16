/* po-view.js - one purchase order as a printable sheet, with buttons to print, change or move it on
   (draft -> sent -> received, or cancelled). Opening it with &print=1 starts the print dialog. */
(async function () {
    "use strict";
    var h = Duka.h;
    var page = await Duka.initPage({ title: "Purchase order" });
    var isOwner = page.user.role === "owner";
    var params = new URLSearchParams(window.location.search);
    var id = params.get("id");
    if (!id) { window.location.replace("/orders.html"); return; }

    var STATUS = { draft: "Draft", sent: "Sent to supplier", received: "Received", cancelled: "Cancelled" };
    var BADGE = { draft: "badge warn", sent: "badge", received: "badge", cancelled: "badge off" };
    var box = h("div", {});
    page.main.append(box);
    var order = null;
    var printed = false;

    function poNumber(n) { return "PO-" + String(n).padStart(4, "0"); }

    async function load() {
        try {
            order = (await Duka.api("/api/orders/" + encodeURIComponent(id))).order;
            draw();
            if (params.get("print") === "1" && !printed) { printed = true; setTimeout(function () { window.print(); }, 500); }
        } catch (error) {
            box.replaceChildren(h("p", { class: "form-error" }, error.message), h("a", { class: "btn ghost", href: "/orders.html" }, "Back to orders"));
        }
    }

    async function setStatus(next, message) {
        if (message) {
            var ok = await Duka.dialog({ title: message.title, message: message.text, confirmText: message.confirm, danger: !!message.danger });
            if (!ok) return;
        }
        try {
            order = (await Duka.api("/api/orders/" + order.id + "/status", { method: "POST", body: { status: next } })).order;
            Duka.toast("Order marked as " + STATUS[next].toLowerCase());
            draw();
        } catch (error) { Duka.toast(error.message, "error"); }
    }


    /* ---------- WhatsApp and picture (supplier copies never show our estimated prices) ---------- */
    function orderText(o) {
        var shop = o.shop || {};
        var lines = ["*PURCHASE ORDER " + poNumber(o.orderNumber) + "*", shop.name || "", "Date: " + Duka.fmt.date(o.orderDate)];
        if (o.expectedDate) lines.push("Needed by: " + Duka.fmt.date(o.expectedDate));
        lines.push("");
        o.items.forEach(function (i, n) { lines.push((n + 1) + ". " + i.productName + " - " + Duka.fmt.number(i.quantity) + " " + i.unitName); });
        if (o.note) lines.push("", "Note: " + o.note);
        if (shop.phone) lines.push("", "Call us: " + shop.phone);
        return lines.join("\n");
    }

    function sendWhatsApp(o) {
        var digits = o.supplier && o.supplier.phone ? String(o.supplier.phone).replace(/\D/g, "") : "";
        var url = "https://wa.me/" + digits + "?text=" + encodeURIComponent(orderText(o));
        if (!digits) Duka.toast("No supplier phone saved: choose who to send it to in WhatsApp.");
        window.open(url, "_blank", "noopener");
    }

    function wrapText(ctx, text, maxWidth) {
        var words = String(text).split(/\s+/), lines = [], cur = "";
        words.forEach(function (w) {
            var test = cur ? cur + " " + w : w;
            if (cur && ctx.measureText(test).width > maxWidth) { lines.push(cur); cur = w; } else cur = test;
        });
        if (cur) lines.push(cur);
        return lines.length ? lines : [""];
    }

    function drawPicture(o) {
        var W = 800, S = 2, pad = 40, ink = "#11221b", muted = "#55655d", green = "#0a5a37";
        var shop = o.shop || {};
        var canvas = document.createElement("canvas");
        var ctx = canvas.getContext("2d");
        var font = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
        var qtyX = W - pad, unitX = W - pad - 90, nameW = unitX - pad - 60 - 150;

        // measure first so the picture is exactly as tall as the order needs
        canvas.width = W; ctx.font = "600 20px " + font;
        var rows = o.items.map(function (i) { return wrapText(ctx, i.productName, nameW); });
        var noteLines = o.note ? wrapText(ctx, "Note: " + o.note, W - pad * 2) : [];
        var H = 250 + rows.reduce(function (t, r) { return t + 14 + r.length * 26; }, 0) + (noteLines.length ? 20 + noteLines.length * 26 : 0) + 70;

        canvas.width = W * S; canvas.height = H * S; ctx.scale(S, S);
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
        ctx.textBaseline = "alphabetic";

        ctx.fillStyle = green; ctx.fillRect(0, 0, W, 10);
        ctx.fillStyle = ink; ctx.font = "800 28px " + font; ctx.textAlign = "left"; ctx.fillText(shop.name || "", pad, 62);
        ctx.fillStyle = muted; ctx.font = "400 16px " + font;
        if (shop.address) ctx.fillText(shop.address, pad, 88);
        if (shop.phone) ctx.fillText(shop.phone, pad, 110);
        ctx.textAlign = "right"; ctx.fillStyle = ink; ctx.font = "800 24px " + font; ctx.fillText("PURCHASE ORDER", W - pad, 62);
        ctx.fillStyle = green; ctx.font = "800 22px " + font; ctx.fillText(poNumber(o.orderNumber), W - pad, 90);

        ctx.textAlign = "left"; ctx.fillStyle = muted; ctx.font = "700 14px " + font;
        ctx.fillText("ORDER DATE", pad, 150); ctx.fillText("NEEDED BY", 250, 150); ctx.fillText("SUPPLIER", 450, 150);
        ctx.fillStyle = ink; ctx.font = "600 18px " + font;
        ctx.fillText(Duka.fmt.date(o.orderDate), pad, 176);
        ctx.fillText(o.expectedDate ? Duka.fmt.date(o.expectedDate) : "-", 250, 176);
        ctx.fillText(o.supplier ? o.supplier.name : "-", 450, 176, W - pad - 450);

        var y = 210;
        ctx.fillStyle = muted; ctx.font = "800 14px " + font;
        ctx.fillText("#", pad, y); ctx.fillText("PRODUCT", pad + 36, y);
        ctx.textAlign = "right"; ctx.fillText("UNIT", unitX + 40, y); ctx.fillText("QTY", qtyX, y);
        ctx.fillStyle = ink; ctx.fillRect(pad, y + 10, W - pad * 2, 2);
        y += 14;

        ctx.font = "600 20px " + font;
        o.items.forEach(function (i, n) {
            y += 14;
            var top = y;
            ctx.textAlign = "left"; ctx.fillStyle = muted; ctx.fillText(String(n + 1), pad, top + 20);
            ctx.fillStyle = ink;
            rows[n].forEach(function (line, k) { ctx.fillText(line, pad + 36, top + 20 + k * 26); });
            ctx.textAlign = "right"; ctx.fillStyle = muted; ctx.font = "400 17px " + font;
            ctx.fillText(i.unitName, unitX + 40, top + 20, 130);
            ctx.fillStyle = ink; ctx.font = "800 22px " + font; ctx.fillText(Duka.fmt.number(i.quantity), qtyX, top + 20);
            ctx.font = "600 20px " + font;
            y = top + rows[n].length * 26;
            ctx.fillStyle = "#c9d4cd"; ctx.fillRect(pad, y + 8, W - pad * 2, 1);
        });

        if (noteLines.length) {
            y += 34; ctx.textAlign = "left"; ctx.fillStyle = ink; ctx.font = "400 18px " + font;
            noteLines.forEach(function (line, k) { ctx.fillText(line, pad, y + k * 26); });
            y += noteLines.length * 26 - 10;
        }
        ctx.textAlign = "left"; ctx.fillStyle = muted; ctx.font = "400 14px " + font;
        ctx.fillText("Prepared by " + (o.updatedBy || o.createdBy || "") + " · " + Duka.fmt.date(o.orderDate), pad, H - 26);
        return canvas;
    }

    async function sharePicture(o) {
        var canvas = drawPicture(o);
        var blob = await new Promise(function (resolve) { canvas.toBlob(resolve, "image/png"); });
        if (!blob) { Duka.toast("Could not make the picture.", "error"); return; }
        var name = poNumber(o.orderNumber) + ".png";
        var file = new File([blob], name, { type: "image/png" });
        try {
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                await navigator.share({ files: [file], title: "Purchase order " + poNumber(o.orderNumber) });
                return;
            }
        } catch (error) {
            if (error && error.name === "AbortError") return; // person closed the share sheet
        }
        var link = h("a", { href: URL.createObjectURL(blob), download: name });
        document.body.appendChild(link); link.click(); link.remove();
        Duka.toast("Picture saved as " + name + ". Attach it in WhatsApp.");
    }

    function meta(label, value) { return h("div", {}, h("dt", {}, label), h("dd", {}, value || "-")); }

    function draw() {
        var o = order;
        var open = o.status === "draft" || o.status === "sent";
        var shop = o.shop || {};

        // ----- the sheet (this is what prints) -----
        var head = [h("th", {}, "#"), h("th", {}, "Product"), h("th", {}, "Unit"), h("th", { class: "num" }, "Qty")];
        if (isOwner) head.push(h("th", { class: "num" }, "Est. cost"), h("th", { class: "num" }, "Amount"));
        var body = o.items.map(function (i, n) {
            var cells = [h("td", {}, String(n + 1)), h("td", {}, i.productName), h("td", {}, i.unitName), h("td", { class: "num" }, Duka.fmt.number(i.quantity))];
            if (isOwner) cells.push(h("td", { class: "num" }, Duka.fmt.number(i.unitCost)), h("td", { class: "num" }, Duka.fmt.number(i.lineTotal)));
            return h("tr", {}, cells);
        });
        var foot = isOwner ? h("tfoot", {}, h("tr", { class: "os-total" },
            h("td", { colspan: "5" }, "Estimated total"), h("td", { class: "num" }, Duka.fmt.ugx(o.total)))) : null;

        var sheet = h("div", { class: "order-sheet" },
            h("div", { class: "os-head" },
                h("div", {}, h("div", { class: "os-shop" }, shop.name || ""), shop.address ? h("div", {}, shop.address) : null, shop.phone ? h("div", {}, shop.phone) : null),
                h("div", { class: "os-no" }, h("div", { class: "os-title" }, "PURCHASE ORDER"), h("div", { class: "os-num" }, poNumber(o.orderNumber)))),
            h("dl", { class: "os-meta" },
                meta("Order date", Duka.fmt.date(o.orderDate)),
                meta("Expected delivery", o.expectedDate ? Duka.fmt.date(o.expectedDate) : ""),
                meta("Supplier", o.supplier ? o.supplier.name + (o.supplier.phoneDisplay ? " · " + o.supplier.phoneDisplay : "") : "Not chosen yet"),
                meta("Status", STATUS[o.status])),
            h("table", { class: "os-table" }, h("thead", {}, h("tr", {}, head)), h("tbody", {}, body), foot),
            o.note ? h("p", { class: "os-note" }, h("strong", {}, "Note: "), o.note) : null,
            h("div", { class: "os-sign" }, h("div", {}, "Prepared by: " + (o.updatedBy || o.createdBy || "")), h("div", {}, "Approved by")));

        // ----- buttons (these do not print) -----
        var actions = [h("button", { type: "button", class: "btn", onclick: function () { window.print(); } }, "Print")];
        actions.push(h("button", { type: "button", class: "btn ghost", onclick: function () { sendWhatsApp(o); } }, "WhatsApp"));
        actions.push(h("button", { type: "button", class: "btn ghost", onclick: function () { sharePicture(o); } }, "Share picture"));
        if (open) actions.push(h("a", { class: "btn ghost", href: "/order-form.html?id=" + o.id }, "Change this order"));
        if (o.status === "draft") actions.push(h("button", { type: "button", class: "btn ghost", onclick: function () { setStatus("sent"); } }, "Mark as sent"));
        if (o.status === "sent") actions.push(h("button", { type: "button", class: "btn ghost", onclick: function () { setStatus("draft"); } }, "Back to draft"));
        if (open) actions.push(h("button", { type: "button", class: "btn ghost", onclick: function () {
            setStatus("received", { title: "Mark as received?", text: "Use this when the goods have arrived. It does not change your stock: record the purchase for that.", confirm: "Mark as received" });
        } }, "Mark as received"));
        if (open) actions.push(h("button", { type: "button", class: "btn ghost danger", onclick: function () {
            setStatus("cancelled", { title: "Cancel this order?", text: "It stays in your list, marked as cancelled. You can reopen it later.", confirm: "Cancel order", danger: true });
        } }, "Cancel order"));
        if (o.status === "cancelled") actions.push(h("button", { type: "button", class: "btn ghost", onclick: function () { setStatus("draft"); } }, "Reopen as draft"));
        if (o.status === "received" && isOwner) actions.push(h("button", { type: "button", class: "btn ghost", onclick: function () { setStatus("sent"); } }, "Reopen"));
        if (isOwner && (o.status === "sent" || o.status === "received")) {
            actions.push(h("a", { class: "btn ghost", href: "/purchase-form.html" + (o.supplier ? "?supplierId=" + o.supplier.id : "") }, "Record the purchase"));
        }

        box.replaceChildren(
            h("p", { class: "no-print" }, h("a", { href: "/orders.html" }, "← All orders")),
            h("div", { class: "no-print page-head" },
                h("h1", {}, poNumber(o.orderNumber) + " "), h("span", { class: BADGE[o.status] }, STATUS[o.status]),
                h("p", {}, "Last changed " + Duka.fmt.dateTime(o.updatedAt) + (o.updatedBy ? " by " + o.updatedBy : ""))),
            h("div", { class: "no-print actions po-actions" }, actions),
            sheet);
    }

    load();
})();
