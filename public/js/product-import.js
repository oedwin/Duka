/* product-import.js - export products to a CSV file, or add many at once from a CSV file.
   CSV opens in Excel and Google Sheets. In Excel: File > Save As > "CSV UTF-8". */
(async function () {
    "use strict";
    var h = Duka.h;
    var page = await Duka.initPage({ title: "Import / export", roles: ["owner"] });
    var CHUNK = 100; // rows sent per request

    // ---------- CSV helpers ----------
    function csvCell(value) {
        var text = value === null || value === undefined ? "" : String(value);
        return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    }
    function toCSV(columns, rows) {
        var lines = [columns.join(",")];
        rows.forEach(function (row) { lines.push(columns.map(function (c) { return csvCell(row[c]); }).join(",")); });
        return lines.join("\r\n");
    }
    function parseCSV(text) {
        text = text.replace(/^\uFEFF/, "");
        var first = text.split(/\r?\n/)[0] || "";
        var delimiter = ",";
        if (first.split(";").length > first.split(",").length) delimiter = ";";
        if (first.split("\t").length > first.split(delimiter).length) delimiter = "\t";

        var rows = [], row = [], field = "", quoted = false;
        for (var i = 0; i < text.length; i++) {
            var c = text[i];
            if (quoted) {
                if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
                else field += c;
            } else if (c === '"') quoted = true;
            else if (c === delimiter) { row.push(field); field = ""; }
            else if (c === "\n" || c === "\r") {
                if (c === "\r" && text[i + 1] === "\n") i++;
                row.push(field); field = ""; rows.push(row); row = [];
            } else field += c;
        }
        if (field !== "" || row.length) { row.push(field); rows.push(row); }
        return rows.filter(function (r) { return r.some(function (cell) { return String(cell).trim() !== ""; }); });
    }
    function download(filename, text) {
        var blob = new Blob(["\uFEFF" + text], { type: "text/csv;charset=utf-8" });
        var url = URL.createObjectURL(blob);
        var link = h("a", { href: url, download: filename });
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }
    var today = new Date().toISOString().slice(0, 10);

    // ---------- export and template ----------
    var exportButton = h("button", { class: "btn", type: "button" }, "Download my products (CSV)");
    exportButton.addEventListener("click", async function () {
        Duka.busy(exportButton, true, "Preparing...");
        try {
            var data = await Duka.api("/api/products/export");
            download("duka-products-" + today + ".csv", toCSV(data.columns, data.rows));
            Duka.toast(data.rows.length + " products downloaded");
            if (data.cutOff) Duka.toast(data.cutOff + " product(s) have more than 3 units; only the first 3 are in the file.", "error");
        } catch (error) {
            Duka.toast(error.message, "error");
        }
        Duka.busy(exportButton, false);
    });

    var templateButton = h("button", { class: "btn ghost", type: "button" }, "Download a blank template");
    templateButton.addEventListener("click", async function () {
        try {
            var data = await Duka.api("/api/products/export?template=1");
            download("duka-product-template.csv", toCSV(data.columns, data.rows));
        } catch (error) {
            Duka.toast(error.message, "error");
        }
    });

    // ---------- import ----------
    var fileInput = h("input", { type: "file", id: "csvFile", accept: ".csv,text/csv" });
    var summary = h("p", { class: "muted" });
    var errorBox = h("p", { class: "form-error", role: "alert", hidden: true });
    var importButton = h("button", { class: "btn", type: "button", hidden: true }, "Import");
    var results = h("div", {});
    var parsed = []; // product rows ready to send

    function fail(message) { errorBox.textContent = message; errorBox.hidden = false; }

    fileInput.addEventListener("change", function () {
        errorBox.hidden = true;
        results.replaceChildren();
        importButton.hidden = true;
        parsed = [];
        summary.textContent = "";
        var file = fileInput.files[0];
        if (!file) return;

        var reader = new FileReader();
        reader.onerror = function () { fail("That file could not be read."); };
        reader.onload = function () {
            var table = parseCSV(String(reader.result));
            if (table.length < 2) return fail("The file has no products in it. Use the template to see the layout.");

            var headers = table[0].map(function (c) { return String(c).trim().toLowerCase().replace(/[\s-]+/g, "_"); });
            var missing = ["name", "retail_price"].filter(function (c) { return headers.indexOf(c) === -1; });
            if (missing.length) {
                return fail("The first row must have these column names: " + missing.join(", ") + ". Download the template to see the layout.");
            }

            parsed = table.slice(1).map(function (cells, index) {
                var row = { line: index + 1 };
                headers.forEach(function (header, i) { row[header] = cells[i] === undefined ? "" : cells[i]; });
                return row;
            });
            summary.textContent = "Found " + parsed.length + " products in " + file.name + ". Products you already have (same name) are skipped.";
            importButton.textContent = "Import " + parsed.length + " products";
            importButton.hidden = false;
        };
        reader.readAsText(file);
    });

    importButton.addEventListener("click", async function () {
        errorBox.hidden = true;
        results.replaceChildren();
        importButton.disabled = true;
        fileInput.disabled = true;

        var created = 0, skipped = 0, problems = [], sent = 0;
        try {
            for (var start = 0; start < parsed.length; start += CHUNK) {
                importButton.textContent = "Importing... " + sent + " of " + parsed.length;
                var data = await Duka.api("/api/products/import", {
                    method: "POST",
                    body: { rows: parsed.slice(start, start + CHUNK) },
                    timeout: 60000
                });
                created += data.created;
                skipped += data.skipped;
                problems = problems.concat(data.errors);
                sent += Math.min(CHUNK, parsed.length - start);
            }
        } catch (error) {
            fail(error.message + " " + sent + " of " + parsed.length + " rows were handled. Choose the file again and import again: products already added are skipped, so nothing is doubled.");
        }

        results.append(h("div", { class: "card" },
            h("h2", {}, "Import finished"),
            h("p", { class: "stat" }, created + " added"),
            h("p", {}, skipped ? skipped + " skipped:" : "Nothing was skipped."),
            skipped ? h("ul", { class: "result-list" }, problems.slice(0, 100).map(function (p) {
                return h("li", {}, "Row " + (p.line || "?") + (p.name ? " (" + p.name + ")" : "") + ": " + p.message);
            })) : null,
            h("div", { class: "actions" }, h("a", { class: "btn", href: "/products.html" }, "See my products"))));

        importButton.hidden = true;
        importButton.disabled = false;
        fileInput.disabled = false;
        fileInput.value = "";
        parsed = [];
        summary.textContent = "";
    });

    page.main.append(
        h("p", {}, h("a", { href: "/products.html" }, "\u2190 Back to products")),
        h("div", { class: "page-head" }, h("h1", {}, "Import / export")),
        h("div", { class: "card" },
            h("h2", {}, "Export"),
            h("p", {}, "Download all your products as a file you can open in Excel or Google Sheets, and keep as a backup."),
            exportButton),
        h("div", { class: "card" },
            h("h2", {}, "Import"),
            h("p", {}, "Add many products at once. Fill in the template in Excel, save it as CSV, and choose it here."),
            h("div", { class: "actions" }, templateButton),
            h("div", { class: "field" }, h("label", { for: "csvFile" }, "Choose your CSV file"), fileInput),
            summary, errorBox, importButton),
        results);
})();
