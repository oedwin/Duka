/* closing.js - end of the day: how much cash SHOULD be in the drawer, and how much you counted.
   Only cash counts here. Mobile Money and bank money are not in the drawer. */
(async function () {
    "use strict";
    var h = Duka.h;
    var page = await Duka.initPage({ title: "Close the day" });
    var isOwner = page.user.role === "owner";

    var date = Duka.fmt.today();
    var today = date;
    var preview = null;
    var requestId = 0;

    var dateInput = h("input", { class: "input", id: "date", type: "date", value: date, max: today, "aria-label": "Day to close" });
    var box = h("div", {}, h("p", { class: "empty" }, "Loading..."));
    var history = h("div", { class: "card" });

    dateInput.addEventListener("change", function () {
        if (!dateInput.value) return;
        date = dateInput.value;
        load();
    });

    function line(label, value, kind) {
        return h("div", { class: "pl-row" + (kind ? " " + kind : "") }, h("span", {}, label), h("span", {}, value));
    }

    function differenceText(diff) {
        if (diff === 0) return h("p", { class: "stat up" }, "The cash is exactly right.");
        if (diff < 0) return h("p", { class: "stat down" }, "You are short by " + Duka.fmt.ugx(-diff));
        return h("p", { class: "stat down" }, "You have " + Duka.fmt.ugx(diff) + " extra");
    }

    function draw() {
        var p = preview.parts;
        var existing = preview.existing;
        var parts = [];

        parts.push(h("div", { class: "card" },
            h("h2", {}, "Which day?"),
            h("div", { class: "field" }, dateInput),
            existing ? h("p", {}, h("span", { class: "badge" }, "Closed"), " by " + (existing.closedBy || "someone") + " on " + Duka.fmt.dateTime(existing.closedAt)) : null));

        parts.push(h("div", { class: "card" },
            h("h2", {}, "Cash that should be in the drawer"),
            line("Cash at the start of the day", Duka.fmt.ugx(p.opening)),
            line("+ Cash from sales", Duka.fmt.ugx(p.saleCash)),
            line("+ Cash customers paid on their debts", Duka.fmt.ugx(p.debtCash)),
            line("- Cash given back for cancelled payments", Duka.fmt.ugx(p.cancelledCash)),
            line("- Cash refunded for returned goods", Duka.fmt.ugx(p.refundCash)),
            line("- Expenses paid in cash", Duka.fmt.ugx(p.expenseCash)),
            line("- Paid to suppliers in cash", Duka.fmt.ugx(p.supplierCash)),
            line("- Goods bought and paid for in cash", Duka.fmt.ugx(p.purchaseCash)),
            line("Cash that should be there", Duka.fmt.ugx(preview.expected), "total"),
            h("p", { class: "muted" }, "The start of the day is the cash you counted when you last closed. Money you took out afterwards (to the bank, for example) is not known to Duka, so count only what is really in the drawer.")));

        // the count
        var counted = h("input", { class: "input", id: "counted", type: "number", inputmode: "numeric", min: "0", step: "1",
            value: existing ? String(existing.countedCash) : "", "aria-label": "Cash counted" });
        var note = h("input", { class: "input", type: "text", maxlength: "300", placeholder: "Note (optional)", value: existing && existing.note ? existing.note : "", "aria-label": "Note" });
        var result = h("div", {});
        var errorBox = h("p", { class: "form-error", role: "alert", hidden: true });
        var save = h("button", { type: "button", class: "btn block big" }, existing ? "Correct this closing" : "Close the day");

        function update() {
            var raw = counted.value.trim();
            if (raw === "") { result.replaceChildren(); return; }
            result.replaceChildren(differenceText((parseInt(raw, 10) || 0) - preview.expected));
        }
        counted.addEventListener("input", update);
        update();

        var canSave = !existing || isOwner;
        save.hidden = !canSave;
        save.addEventListener("click", async function () {
            errorBox.hidden = true;
            var value = parseInt(counted.value, 10);
            if (!(value >= 0)) { errorBox.textContent = "Count the cash in the drawer and type the amount."; errorBox.hidden = false; return; }
            Duka.busy(save, true, "Saving...");
            try {
                var data = await Duka.api("/api/closings", { method: "POST", body: { date: date, countedCash: value, note: note.value.trim() } });
                Duka.toast(data.corrected ? "Closing corrected" : "The day is closed");
                load();
            } catch (error) {
                errorBox.textContent = error.message;
                errorBox.hidden = false;
                Duka.busy(save, false);
            }
        });

        parts.push(h("div", { class: "card" },
            h("h2", {}, existing && !isOwner ? "The count" : "Count the cash"),
            h("p", { class: "muted" }, "Count all the notes and coins in the drawer."),
            h("div", { class: "field" }, h("label", { for: "counted" }, "Cash counted (UGX)"), counted),
            result,
            h("div", { class: "field" }, note),
            existing && !isOwner ? h("p", { class: "muted" }, "This day is already closed. Ask the owner if it needs to be corrected.") : null,
            errorBox, save));

        box.replaceChildren.apply(box, parts);
    }

    async function load() {
        var mine = ++requestId;
        box.replaceChildren(h("p", { class: "empty" }, "Loading..."));
        try {
            var data = await Duka.api("/api/closings/preview?date=" + encodeURIComponent(date));
            if (mine !== requestId) return;
            preview = data;
            draw();
            if (isOwner) loadHistory();
        } catch (error) {
            if (mine !== requestId) return;
            box.replaceChildren(h("p", { class: "form-error" }, error.message),
                h("button", { type: "button", class: "btn ghost", onclick: load }, "Try again"));
        }
    }

    async function loadHistory() {
        try {
            var data = await Duka.api("/api/closings");
            history.replaceChildren(
                h("h2", {}, "Past closings"),
                h("div", {}, data.closings.length ? data.closings.map(function (c) {
                    var d = c.difference;
                    return h("div", { class: "row" },
                        h("div", { class: "grow" },
                            h("div", { class: "name" }, Duka.fmt.date(c.date)),
                            h("div", { class: "sub" }, "Should be " + Duka.fmt.ugx(c.expectedCash) + ", counted " + Duka.fmt.ugx(c.countedCash) + (c.closedBy ? " \u00b7 " + c.closedBy : "")),
                            c.note ? h("div", { class: "sub" }, c.note) : null),
                        h("div", { class: "price " + (d === 0 ? "up" : "down") },
                            d === 0 ? "Correct" : (d < 0 ? "Short " : "Extra ") + Duka.fmt.ugx(Math.abs(d))));
                }) : h("p", { class: "empty" }, "No days closed yet.")));
        } catch (error) {
            history.replaceChildren(h("p", { class: "form-error" }, error.message));
        }
    }

    page.main.append(h("div", {},
        h("div", { class: "page-head" }, h("h1", {}, "Close the day"),
            h("p", {}, "Check that the cash in the drawer matches what the shop recorded.")),
        box, isOwner ? history : null));
    load();
})();
