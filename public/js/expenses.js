/* expenses.js - money spent running the shop. It is subtracted from profit in your reports. */
(async function () {
    "use strict";
    var h = Duka.h;
    var page = await Duka.initPage({ title: "Expenses", roles: ["owner"] });

    var METHOD = { cash: "Cash", mobile_money: "Mobile Money", bank: "Bank" };
    var state = { preset: "month", from: "", to: "" };
    var pageNo = 1;
    var requestId = 0;
    var uuid = Duka.uuid(); // one id per expense, so pressing Save twice cannot record it twice
    var categories = [];

    // ---------- add an expense ----------
    var amount = h("input", { class: "input", id: "amount", type: "number", inputmode: "numeric", min: "1", step: "1", "aria-label": "Amount" });
    var category = h("select", { class: "input", id: "category", "aria-label": "Category" });
    var description = h("input", { class: "input", id: "description", type: "text", maxlength: "300", placeholder: "What was it for? (optional)", "aria-label": "What it was for" });
    var method = h("select", { class: "input", id: "method", "aria-label": "How it was paid" },
        h("option", { value: "cash" }, "Cash"), h("option", { value: "mobile_money" }, "Mobile Money"), h("option", { value: "bank" }, "Bank"));
    var dateInput = h("input", { class: "input", id: "date", type: "date", value: Duka.fmt.today() });
    var errorBox = h("p", { class: "form-error", role: "alert", hidden: true });
    var save = h("button", { type: "submit", class: "btn block" }, "Save expense");

    function fillCategories(selectedId) {
        category.replaceChildren(h("option", { value: "" }, "Choose a category"));
        categories.forEach(function (c) { category.appendChild(h("option", { value: String(c.id) }, c.name)); });
        category.value = selectedId ? String(selectedId) : "";
    }
    async function newCategory() {
        var values = await Duka.dialog({ title: "New category", confirmText: "Add", fields: [{ name: "name", label: "Category name" }] });
        if (!values) return;
        try {
            var data = await Duka.api("/api/expenses/categories", { method: "POST", body: { name: values.name } });
            categories.push(data.category);
            fillCategories(data.category.id);
        } catch (error) {
            Duka.toast(error.message, "error");
        }
    }

    var form = h("form", { class: "card", novalidate: true },
        h("h2", {}, "Add an expense"),
        h("div", { class: "pair" },
            h("div", { class: "field" }, h("label", { for: "amount" }, "Amount (UGX)"), amount),
            h("div", { class: "field" }, h("label", { for: "category" }, "Category"), category,
                h("div", {}, h("button", { type: "button", class: "btn ghost small", onclick: newCategory }, "New category")))),
        h("div", { class: "field" }, description),
        h("div", { class: "pair" },
            h("div", { class: "field" }, h("label", { for: "method" }, "Paid by"), method),
            h("div", { class: "field" }, h("label", { for: "date" }, "Date"), dateInput)),
        errorBox, save);

    form.addEventListener("submit", async function (event) {
        event.preventDefault();
        errorBox.hidden = true;
        var value = parseInt(amount.value, 10);
        if (!(value > 0)) { errorBox.textContent = "Enter the amount."; errorBox.hidden = false; return; }
        if (!category.value && !description.value.trim()) { errorBox.textContent = "Choose a category or write what it was for."; errorBox.hidden = false; return; }
        Duka.busy(save, true, "Saving...");
        try {
            await Duka.api("/api/expenses", {
                method: "POST", safeToRetry: true,
                body: { clientUuid: uuid, amount: value, categoryId: category.value || null, description: description.value.trim(),
                        paymentMethod: method.value, expenseDate: dateInput.value || null }
            });
            Duka.toast("Expense saved");
            uuid = Duka.uuid();
            amount.value = "";
            description.value = "";
            load(true);
        } catch (error) {
            errorBox.textContent = error.message;
            errorBox.hidden = false;
        }
        Duka.busy(save, false);
    });

    // ---------- the list ----------
    var PRESETS = [["today", "Today"], ["month", "This month"], ["30", "Last 30 days"], ["custom", "Pick dates"]];
    function range() {
        var today = Duka.fmt.today();
        if (state.preset === "today") return { from: today, to: today };
        if (state.preset === "30") return { from: Duka.fmt.addDays(today, -29), to: today };
        if (state.preset === "custom") return { from: state.from || today, to: state.to || state.from || today };
        return { from: today.slice(0, 8) + "01", to: today };
    }
    var presetButtons = PRESETS.map(function (p) {
        var b = h("button", { type: "button", class: "seg" }, p[1]);
        b.dataset.key = p[0];
        b.addEventListener("click", function () { state.preset = p[0]; sync(); load(true); });
        return b;
    });
    var fromInput = h("input", { class: "input", type: "date", "aria-label": "From" });
    var toInput = h("input", { class: "input", type: "date", "aria-label": "To" });
    var customRow = h("div", { class: "pair", hidden: true }, fromInput, toInput);
    fromInput.addEventListener("change", function () { state.from = fromInput.value; load(true); });
    toInput.addEventListener("change", function () { state.to = toInput.value; load(true); });
    function sync() {
        presetButtons.forEach(function (b) { b.classList.toggle("on", b.dataset.key === state.preset); });
        customRow.hidden = state.preset !== "custom";
    }

    var summary = h("div", { class: "card" });
    var list = h("div", { class: "card" });
    var more = h("button", { type: "button", class: "btn ghost block", hidden: true }, "Show more");

    async function cancelExpense(e) {
        var values = await Duka.dialog({
            title: "Cancel this expense?",
            message: Duka.fmt.ugx(e.amount) + " will no longer count as spent. It stays in the list, marked as cancelled.",
            fields: [{ name: "reason", label: "Why is it being cancelled?" }],
            confirmText: "Cancel expense", cancelText: "Keep it", danger: true
        });
        if (!values) return;
        try {
            await Duka.api("/api/expenses/" + e.id + "/void", { method: "POST", body: { reason: values.reason } });
            Duka.toast("Expense cancelled");
            load(true);
        } catch (error) {
            Duka.toast(error.message, "error");
        }
    }

    function row(e) {
        var sub = [Duka.fmt.date(e.date), METHOD[e.method] || e.method, e.by].filter(Boolean).join(" \u00b7 ");
        return h("div", { class: "row" },
            h("div", { class: "grow" },
                h("div", { class: "name" }, (e.category || "No category") + (e.description ? " \u00b7 " + e.description : "")),
                h("div", { class: "sub" }, sub),
                e.voided ? h("div", { class: "sub down" }, "Cancelled: " + (e.voidReason || "")) : null),
            h("div", { class: "price" + (e.voided ? " struck" : "") }, Duka.fmt.ugx(e.amount)),
            !e.voided ? h("button", { type: "button", class: "btn ghost small danger", onclick: function () { cancelExpense(e); } }, "Cancel") : null);
    }

    async function load(reset) {
        var mine = ++requestId;
        if (reset) { pageNo = 1; more.hidden = true; list.replaceChildren(h("p", { class: "empty" }, "Loading...")); }
        var r = range();
        var query = new URLSearchParams({ from: r.from, to: r.to, status: "all", page: pageNo, limit: 50 });
        try {
            var data = await Duka.api("/api/expenses?" + query.toString());
            if (mine !== requestId) return;
            if (reset) {
                list.replaceChildren();
                summary.replaceChildren(
                    h("h2", {}, "Spent in this period"),
                    h("p", { class: "big-owed" }, Duka.fmt.ugx(data.total)),
                    h("div", {}, data.byCategory.map(function (c) {
                        return h("div", { class: "pl-row" }, h("span", {}, c.category), h("span", {}, Duka.fmt.ugx(c.total)));
                    })));
            }
            data.expenses.forEach(function (e) { list.appendChild(row(e)); });
            if (data.count === 0) list.replaceChildren(h("p", { class: "empty" }, "No expenses in this period."));
            more.hidden = !data.hasMore;
            more.textContent = "Show more (" + (data.count - data.page * data.limit) + " left)";
        } catch (error) {
            if (mine !== requestId) return;
            list.replaceChildren(h("p", { class: "form-error" }, error.message),
                h("button", { type: "button", class: "btn ghost", onclick: function () { load(true); } }, "Try again"));
        }
    }
    more.addEventListener("click", function () { pageNo++; load(false); });

    page.main.append(h("div", {},
        h("div", { class: "page-head" }, h("h1", {}, "Expenses"), h("p", {}, "Rent, transport, wages, airtime and other costs of running the shop.")),
        form,
        h("div", { class: "card" }, h("div", { class: "seg-group wrap", role: "group", "aria-label": "Period" }, presetButtons), customRow),
        summary, list, more));

    try { categories = (await Duka.api("/api/expenses/categories")).categories; } catch (error) { Duka.toast(error.message, "error"); }
    fillCategories();
    sync();
    load(true);
})();
