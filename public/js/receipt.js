/* receipt.js - one receipt layout, four outputs:
     Duka.receipt.render(sale)   -> on screen and for printing (58mm / 80mm / A4)
     Duka.receipt.toText(sale)   -> text for WhatsApp
     Duka.receipt.toImage(sale)  -> a PNG picture (Promise<Blob>) to share or save
   `sale` is what /api/sales/:id returns. */
(function () {
    "use strict";
    var Duka = (window.Duka = window.Duka || {});

    var METHOD_NAME = { cash: "Cash", mobile_money: "Mobile Money", bank: "Bank" };
    var PROVIDER_NAME = { mtn: "MTN", airtel: "Airtel" };

    function money(n) { return Duka.fmt.ugx(n); }

    /* The receipt as simple rows, so every output shows exactly the same thing. */
    function model(sale) {
        var rows = [];
        var shop = sale.shop || {};
        function rule() { rows.push({ t: "rule" }); }

        rows.push({ t: "title", text: shop.name });
        if (shop.address) rows.push({ t: "center", text: shop.address });
        if (shop.phone) rows.push({ t: "center", text: "Tel: " + shop.phone });
        if (shop.tin) rows.push({ t: "center", text: "TIN: " + shop.tin });
        if (sale.status === "voided") rows.push({ t: "banner", text: "*** VOIDED ***" });
        rule();

        rows.push({ t: "pair", l: "Receipt No.", r: sale.receiptNumber || "-" });
        rows.push({ t: "pair", l: "Date", r: Duka.fmt.dateTime(sale.createdAt) });
        if (sale.servedBy) rows.push({ t: "pair", l: "Served by", r: sale.servedBy });
        rows.push({ t: "pair", l: "Customer", r: sale.customer ? sale.customer.name : "Walk-in" });
        rule();

        sale.items.forEach(function (item) {
            rows.push({
                t: "item", name: item.productName,
                l: item.quantity + " " + item.unitName + " x " + Duka.fmt.number(item.unitPrice),
                r: Duka.fmt.number(item.lineTotal)
            });
        });
        rule();

        if (sale.discountAmount > 0) {
            rows.push({ t: "pair", l: "Subtotal", r: money(sale.subtotal) });
            rows.push({ t: "pair", l: "Discount", r: "-" + money(sale.discountAmount) });
        }
        rows.push({ t: "total", l: "TOTAL", r: money(sale.totalAmount) });
        rows.push({ t: "gap" });

        sale.payments.filter(function (p) { return !p.voided; }).forEach(function (p) {
            var name = METHOD_NAME[p.method] || p.method;
            if (p.provider) name += " (" + PROVIDER_NAME[p.provider] + ")";
            rows.push({ t: "pair", l: name, r: money(p.amount) });
            if (p.reference) rows.push({ t: "small", text: "Ref: " + p.reference });
        });
        rows.push({ t: "pair", l: "Paid", r: money(sale.amountPaid), bold: true });
        if (sale.balanceDue > 0) {
            rows.push({ t: "pair", l: "Balance (credit)", r: money(sale.balanceDue), bold: true });
            if (sale.customer && sale.customer.balance > sale.balanceDue) {
                rows.push({ t: "pair", l: "Total owed", r: money(sale.customer.balance) });
            }
        }

        if (sale.returns && sale.returns.length) {
            var refunded = sale.returns.reduce(function (sum, r) { return sum + r.refundAmount; }, 0);
            rule();
            rows.push({ t: "pair", l: "Refunded for returns", r: "-" + money(refunded) });
            rows.push({ t: "pair", l: "Net total", r: money(sale.totalAmount - refunded), bold: true });
        }

        rule();
        if (shop.footer) rows.push({ t: "center", text: shop.footer });
        return rows;
    }

    /* The receipt for money a customer paid towards their debt.
       `pay` is what /api/customers/:id/payments/:pid returns, with pay.kind = "payment". */
    function paymentModel(pay) {
        var rows = [];
        var shop = pay.shop || {};
        function rule() { rows.push({ t: "rule" }); }

        rows.push({ t: "title", text: shop.name });
        if (shop.address) rows.push({ t: "center", text: shop.address });
        if (shop.phone) rows.push({ t: "center", text: "Tel: " + shop.phone });
        if (shop.tin) rows.push({ t: "center", text: "TIN: " + shop.tin });
        if (pay.voided) rows.push({ t: "banner", text: "*** CANCELLED ***" });
        rule();
        rows.push({ t: "center", text: "PAYMENT RECEIPT" });
        rule();

        rows.push({ t: "pair", l: "Receipt No.", r: pay.receiptNumber || "-" });
        rows.push({ t: "pair", l: "Date", r: Duka.fmt.dateTime(pay.paidAt) });
        if (pay.receivedBy) rows.push({ t: "pair", l: "Received by", r: pay.receivedBy });
        rows.push({ t: "pair", l: "Customer", r: pay.customer.name });
        rule();

        var name = METHOD_NAME[pay.method] || pay.method;
        if (pay.provider) name += " (" + PROVIDER_NAME[pay.provider] + ")";
        rows.push({ t: "pair", l: "Paid by", r: name });
        if (pay.reference) rows.push({ t: "small", text: "Ref: " + pay.reference });
        rows.push({ t: "gap" });
        rows.push({ t: "total", l: "RECEIVED", r: money(pay.amount) });
        rows.push({ t: "gap" });

        if (pay.balanceBefore !== null && pay.balanceBefore !== undefined) {
            rows.push({ t: "pair", l: "Owed before", r: money(pay.balanceBefore) });
            rows.push({ t: "pair", l: "Still owed", r: money(pay.balanceAfter), bold: true });
        }
        rule();
        if (shop.footer) rows.push({ t: "center", text: shop.footer });
        return rows;
    }

    function rowsFor(doc) { return doc.kind === "payment" ? paymentModel(doc) : model(doc); }

    // ---------- on screen / print ----------
    function render(sale) {
        var h = Duka.h;
        var shop = sale.shop || {};
        var paper = ["58mm", "80mm", "A4"].indexOf(shop.paper) !== -1 ? shop.paper : "80mm";
        var box = h("div", { class: "receipt paper-" + paper.toLowerCase() });

        if (shop.logo) box.appendChild(h("img", { class: "r-logo", src: shop.logo, alt: "" }));
        rowsFor(sale).forEach(function (row) {
            if (row.t === "title") box.appendChild(h("div", { class: "r-title" }, row.text));
            else if (row.t === "center") box.appendChild(h("div", { class: "r-center" }, row.text));
            else if (row.t === "banner") box.appendChild(h("div", { class: "r-banner" }, row.text));
            else if (row.t === "rule") box.appendChild(h("div", { class: "r-rule" }));
            else if (row.t === "gap") box.appendChild(h("div", { class: "r-gap" }));
            else if (row.t === "small") box.appendChild(h("div", { class: "r-small" }, row.text));
            else if (row.t === "pair") {
                box.appendChild(h("div", { class: "r-pair" + (row.bold ? " bold" : "") },
                    h("span", {}, row.l), h("span", {}, row.r)));
            } else if (row.t === "item") {
                box.appendChild(h("div", { class: "r-item" },
                    h("div", { class: "r-name" }, row.name),
                    h("div", { class: "r-pair" }, h("span", {}, row.l), h("span", {}, row.r))));
            } else if (row.t === "total") {
                box.appendChild(h("div", { class: "r-pair r-total" }, h("span", {}, row.l), h("span", {}, row.r)));
            }
        });
        return box;
    }

    // ---------- text for WhatsApp ----------
    function toText(sale) {
        return rowsFor(sale).map(function (row) {
            if (row.t === "title") return "*" + row.text + "*";
            if (row.t === "center" || row.t === "banner" || row.t === "small") return row.text;
            if (row.t === "rule") return "--------------------";
            if (row.t === "gap") return "";
            if (row.t === "pair") return row.l + ": " + row.r;
            if (row.t === "item") return row.name + "\n   " + row.l + " = " + row.r;
            if (row.t === "total") return "*" + row.l + ": " + row.r + "*";
            return "";
        }).join("\n") + (sale.shop && sale.shop.footer ? "" : "\n\nThank you!");
    }

    // ---------- a picture of the receipt ----------
    function toImage(sale) {
        var WIDTH = 576, PAD = 24, LINE = 32;
        var rows = rowsFor(sale);

        function wrap(ctx, text, maxWidth) {
            var words = String(text).split(" ");
            var lines = [];
            var line = "";
            words.forEach(function (word) {
                var test = line ? line + " " + word : word;
                if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = word; }
                else line = test;
            });
            if (line) lines.push(line);
            return lines;
        }

        // Pass 1 measures the height, pass 2 draws.
        function draw(ctx, drawing) {
            var y = PAD;
            var inner = WIDTH - PAD * 2;
            rows.forEach(function (row) {
                ctx.font = "22px monospace";
                ctx.fillStyle = "#000";
                if (row.t === "title") {
                    ctx.font = "bold 30px monospace"; ctx.textAlign = "center";
                    wrap(ctx, row.text, inner).forEach(function (l) { y += 38; if (drawing) ctx.fillText(l, WIDTH / 2, y - 10); });
                } else if (row.t === "center" || row.t === "banner" || row.t === "small") {
                    ctx.textAlign = "center";
                    if (row.t === "banner") ctx.font = "bold 26px monospace";
                    wrap(ctx, row.text, inner).forEach(function (l) { y += LINE; if (drawing) ctx.fillText(l, WIDTH / 2, y - 8); });
                } else if (row.t === "rule") {
                    y += 16;
                    if (drawing) { ctx.fillRect(PAD, y - 8, inner, 2); }
                } else if (row.t === "gap") {
                    y += 12;
                } else if (row.t === "pair" || row.t === "total") {
                    if (row.t === "total") ctx.font = "bold 28px monospace";
                    else if (row.bold) ctx.font = "bold 22px monospace";
                    y += row.t === "total" ? 40 : LINE;
                    if (drawing) {
                        ctx.textAlign = "left"; ctx.fillText(row.l, PAD, y - 8);
                        ctx.textAlign = "right"; ctx.fillText(row.r, WIDTH - PAD, y - 8);
                    }
                } else if (row.t === "item") {
                    ctx.textAlign = "left";
                    wrap(ctx, row.name, inner).forEach(function (l) { y += LINE; if (drawing) ctx.fillText(l, PAD, y - 8); });
                    y += LINE;
                    if (drawing) {
                        ctx.fillText("  " + row.l, PAD, y - 8);
                        ctx.textAlign = "right"; ctx.fillText(row.r, WIDTH - PAD, y - 8);
                    }
                }
            });
            return y + PAD;
        }

        var measure = document.createElement("canvas").getContext("2d");
        var height = draw(measure, false);
        var canvas = document.createElement("canvas");
        canvas.width = WIDTH;
        canvas.height = height;
        var ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, WIDTH, height);
        draw(ctx, true);

        return new Promise(function (resolve, reject) {
            canvas.toBlob(function (blob) { blob ? resolve(blob) : reject(new Error("The picture could not be made.")); }, "image/png");
        });
    }

    Duka.receipt = { model: model, render: render, toText: toText, toImage: toImage };
})();
