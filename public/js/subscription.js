/* subscription.js - the business looks after its own subscription:
   status, choose a plan and period, renew, cancel / resume, payment history.
   Everyone can see the status; only the owner can pay, cancel or see the history.
   Paying: the owner is sent to Pesapal's payment page and comes back here (?paid=...&ref=...).
   While online payment is switched off, an order is just saved with a reference. */
(async function () {
    "use strict";
    var h = Duka.h;
    var page = await Duka.initPage({ title: "Subscription" });
    var isOwner = page.user.role === "owner";
    page.main.classList.add("sub-wide");

    var PERIOD_LABEL = { 1: "1 month", 3: "3 months", 12: "12 months" };
    var STATE = {
        trial:       ["Free trial", "Your free trial is running. Choose a plan any time: the days you have left are kept."],
        active:      ["Active", "Your subscription is active."],
        cancelling:  ["Ending", "You cancelled. Duka keeps working until the end date below."],
        none:        ["Active", "Your shop has no subscription limit set."],
        trial_ended: ["Trial ended", "Your free trial has ended. Choose a plan to continue."],
        past_due:    ["Expired", "Your subscription has expired. Renew to continue."],
        cancelled:   ["Ended", "Your subscription has ended. Choose a plan to start again."],
        suspended:   ["Suspended", "This account has been suspended. Please contact Duka support."]
    };
    // Plain-language names for the feature keys saved in the database.
    var FEATURE_GROUPS = [
        { keys: ["products", "inventory"], text: "Product and inventory management" },
        { keys: ["sales", "receipts"], text: "Sales and receipts" },
        { keys: ["basic_reports"], text: "Basic reports" },
        { keys: ["purchasing", "suppliers"], text: "Purchasing and suppliers" },
        { keys: ["customer_debts"], text: "Customer debts and repayments" },
        { keys: ["advanced_reports"], text: "Advanced reports" },
        { keys: ["advanced_analytics"], text: "Advanced analytics" },
        { keys: ["staff_management"], text: "Staff management" },
        { keys: ["priority_support"], text: "Priority support" }
    ];

    var data = null;
    var months = 1;
    var history = { payments: [], total: 0, page: 0, hasMore: false };
    var root = h("div", {});
    page.main.append(h("div", { class: "page-head" }, h("h1", {}, "Subscription")), root);

    async function load() {
        data = await Duka.api("/api/subscription");
    }
    async function loadHistory(reset) {
        if (!isOwner) return;
        if (reset) history = { payments: [], total: 0, page: 0, hasMore: false };
        var next = history.page + 1;
        var res = await Duka.api("/api/subscription/payments?limit=8&page=" + next);
        history = { payments: history.payments.concat(res.payments), total: res.total, page: next, hasMore: res.hasMore };
    }

    // ---------- helpers ----------
    function addMonths(date, n) {
        var d = new Date(date.getTime());
        d.setMonth(d.getMonth() + n);
        return d;
    }
    /* When would the new period start? Right away, or when the time already paid for (or the trial) ends. */
    function periodStart() {
        var sub = data.subscription, now = new Date();
        var base = sub.state === "trial" ? sub.trialEndsAt : (sub.state === "active" || sub.state === "cancelling") ? sub.currentPeriodEnd : null;
        var b = base ? new Date(base) : now;
        return b > now ? b : now;
    }
    function planBullets(plans, index) {
        var plan = plans[index];
        var prev = index > 0 ? plans[index - 1] : null;
        var list = ["1 business", plan.maxUsers + " users"];
        if (prev) list.push("All " + prev.name + " features");
        FEATURE_GROUPS.forEach(function (g) {
            var has = g.keys.some(function (k) { return plan.features.indexOf(k) !== -1; });
            var had = prev && g.keys.some(function (k) { return prev.features.indexOf(k) !== -1; });
            if (has && !had) list.push(g.text);
        });
        return list;
    }
    function statusBadge(status) {
        var kind = status === "successful" ? "" : status === "pending" ? " warn" : " off";
        return h("span", { class: "badge" + kind }, status === "successful" ? "Paid" : status.charAt(0).toUpperCase() + status.slice(1));
    }

    // ---------- status ----------
    function statusCard() {
        var sub = data.subscription;
        var t = STATE[sub.state] || STATE.none;
        var blocked = !sub.allowed;
        var facts = [];
        function fact(label, value) { if (value) facts.push(h("div", {}, h("dt", {}, label), h("dd", {}, value))); }
        fact("Plan", sub.planName);
        if (sub.endsAt) {
            fact(blocked ? "Ended on" : sub.state === "trial" ? "Trial ends" : sub.state === "cancelling" ? "Ends on" : "Renews / ends on", Duka.fmt.date(sub.endsAt));
            if (!blocked && sub.daysLeft !== null) fact("Days left", String(sub.daysLeft));
        }
        if (sub.billingMonths) fact("Billing", PERIOD_LABEL[sub.billingMonths]);
        fact("Users", sub.maxUsers ? data.users + " of " + sub.maxUsers : null);

        var actions = [];
        if (isOwner && sub.state === "cancelling") {
            actions.push(h("button", { type: "button", class: "btn", onclick: resume }, "Keep my subscription"));
        }
        var notice = null;
        if (blocked && sub.state !== "suspended" && !isOwner) {
            notice = h("p", { class: "hint" }, "Please ask the shop owner to renew the subscription. Your shop's data is safe.");
        } else if (blocked && sub.state !== "suspended") {
            notice = h("p", { class: "hint" }, "Your shop's data is safe. As soon as you pay, you can carry on.");
        }
        return h("div", { class: "card" },
            h("div", { class: "sub-status" }, h("h2", { class: "sub-title" }, "Your subscription"),
                h("span", { class: "badge" + (blocked ? " off" : "") }, t[0])),
            h("p", { class: "explain" }, t[1]),
            facts.length ? h("dl", { class: "sub-facts" }, facts) : null,
            notice, actions.length ? h("div", { class: "actions" }, actions) : null);
    }

    // ---------- plans ----------
    function plansSection() {
        var sub = data.subscription;
        var plans = data.plans;
        var periodButtons = [1, 3, 12].map(function (m) {
            return h("button", { type: "button", class: "seg" + (m === months ? " on" : ""), onclick: function () { months = m; render(); } }, PERIOD_LABEL[m]);
        });
        var currentIndex = -1;
        plans.forEach(function (p, i) { if (p.code === sub.planCode) currentIndex = i; });
        var running = sub.state === "active" || sub.state === "cancelling";

        var cards = plans.map(function (plan, i) {
            var price = plan.prices[months];
            var isCurrent = running && plan.code === sub.planCode;
            var label = isCurrent ? "Renew " + plan.name
                : running && i > currentIndex ? "Upgrade to " + plan.name
                : running ? "Switch to " + plan.name
                : "Choose " + plan.name;
            return h("div", { class: "plan-card" + (plan.recommended ? " rec" : "") + (isCurrent ? " current" : "") },
                h("div", { class: "plan-head" }, h("h3", {}, plan.name),
                    isCurrent ? h("span", { class: "badge" }, "Your plan") : plan.recommended ? h("span", { class: "badge" }, "Recommended") : null),
                h("div", { class: "plan-price" }, Duka.fmt.ugx(price), h("small", {}, " / " + PERIOD_LABEL[months])),
                h("div", { class: "plan-sub" }, months > 1 ? Duka.fmt.ugx(Math.round(price / months)) + " a month" : ""),
                h("ul", { class: "plan-list" }, planBullets(plans, i).map(function (b) { return h("li", {}, b); })),
                h("button", { type: "button", class: "btn block" + (plan.recommended || isCurrent ? "" : " ghost"), onclick: function () { choose(plan); } }, label));
        });
        return h("div", {},
            h("h2", {}, running ? "Renew or change plan" : "Choose a plan"),
            h("div", { class: "seg-group wrap", role: "group", "aria-label": "How long" }, periodButtons),
            h("div", { class: "plan-grid" }, cards),
            h("p", { class: "muted" }, "Time you have already paid for (or left of your free trial) is never lost: your new period starts when it ends."));
    }

    async function choose(plan) {
        var start = periodStart();
        var end = addMonths(start, months);
        var price = plan.prices[months];
        var ok = await Duka.dialog({
            title: plan.name + " plan",
            message: PERIOD_LABEL[months] + " for " + Duka.fmt.ugx(price) + ". It will run from " + Duka.fmt.date(start) + " until " + Duka.fmt.date(end) + ".",
            confirmText: "Continue to payment"
        });
        if (!ok) return;
        try {
            var res = await Duka.api("/api/subscription/checkout", {
                method: "POST", safeToRetry: true,
                body: { planCode: plan.code, months: months, clientUuid: Duka.uuid() }
            });
            if (res.paymentUrl) { window.location.href = res.paymentUrl; return; }
            orderSaved(res.payment);
        } catch (error) {
            Duka.toast(error.message, "error");
        }
    }

    function orderSaved(payment) {
        var modal;
        var done = h("button", { type: "button", class: "btn block" }, "OK");
        done.addEventListener("click", function () { modal.close(); refreshAll(); });
        modal = Duka.modal(h("div", {},
            h("h2", {}, "Your order is saved"),
            h("p", {}, payment.planName + " plan, " + PERIOD_LABEL[payment.months] + ": " + Duka.fmt.ugx(payment.amount)),
            h("p", { class: "pay-ref" }, payment.merchantRef),
            h("p", { class: "muted" }, "Online Mobile Money payment is being switched on. Until then, quote this reference to Duka support to pay, and your subscription will be started."),
            done));
    }

    // ---------- cancel / resume ----------
    async function cancel() {
        var values = await Duka.dialog({
            title: "Cancel subscription?",
            message: "Duka keeps working until " + Duka.fmt.date(data.subscription.endsAt) + ". After that your shop stops working until you choose a plan again. Your data is kept.",
            fields: [{ name: "reason", label: "Why are you cancelling? (optional)", required: false }],
            confirmText: "Cancel subscription", cancelText: "Keep it", danger: true
        });
        if (!values) return;
        try {
            await Duka.api("/api/subscription/cancel", { method: "POST", body: { reason: values.reason } });
            Duka.toast("Subscription cancelled");
            refreshAll();
        } catch (error) { Duka.toast(error.message, "error"); }
    }
    async function resume() {
        try {
            await Duka.api("/api/subscription/resume", { method: "POST", body: {} });
            Duka.toast("Your subscription continues");
            refreshAll();
        } catch (error) { Duka.toast(error.message, "error"); }
    }

    // ---------- coming back from paying ----------
    // Ask the server (which asks Pesapal) what happened to a payment, then show the result in plain words.
    async function checkPayment(ref, quiet) {
        try {
            var res = await Duka.api("/api/subscription/payments/check", { method: "POST", body: { ref: ref } });
            await refreshAll();
            showResult(res.state, quiet);
        } catch (error) { Duka.toast(error.message, "error"); }
    }
    function showResult(state, quiet) {
        if (state === "successful") {
            Duka.toast("Payment received. Thank you! Your subscription is active.");
        } else if (state === "failed" || state === "reversed") {
            Duka.toast("The payment was not completed, so nothing was charged for Duka. You can try again.", "error");
        } else if (!quiet) {
            Duka.toast("Still waiting for confirmation. If you have paid, it will show here shortly.");
        }
    }
    async function handleReturn() {
        var q = new URLSearchParams(window.location.search);
        var state = q.get("paid");
        if (!state) return;
        var ref = q.get("ref");
        try { window.history.replaceState(null, "", window.location.pathname); } catch (e) { /* ignore */ }
        if (state === "pending" && ref && isOwner) { await checkPayment(ref, false); return; }
        showResult(state, false);
    }

    // ---------- payment history ----------
    function historySection() {
        var rows = history.payments.map(function (p) {
            return h("div", { class: "row" },
                h("div", { class: "grow" },
                    h("div", { class: "name" }, (p.planName || "Plan") + " · " + PERIOD_LABEL[p.months]),
                    h("div", { class: "sub" }, Duka.fmt.dateTime(p.paidAt || p.createdAt) + " · " + p.merchantRef),
                    p.status === "successful" && p.periodEnd
                        ? h("div", { class: "sub" }, "Covers " + Duka.fmt.date(p.periodStart) + " to " + Duka.fmt.date(p.periodEnd)) : null,
                    p.failureReason ? h("div", { class: "sub" }, p.failureReason) : null,
                    p.status === "pending" && p.providerRef
                        ? h("button", { type: "button", class: "btn ghost small", onclick: function () { checkPayment(p.merchantRef, false); } }, "Check payment") : null),
                h("div", { class: "price" }, Duka.fmt.ugx(p.amount), h("small", {}, statusBadge(p.status))));
        });
        var more = h("button", { type: "button", class: "btn ghost block", hidden: !history.hasMore }, "Show more");
        more.addEventListener("click", async function () {
            try { await loadHistory(false); render(); } catch (error) { Duka.toast(error.message, "error"); }
        });
        return h("div", { class: "card" }, h("h2", {}, "Payment history"),
            rows.length ? h("div", {}, rows) : h("p", { class: "empty" }, "No payments yet."), more);
    }

    // ---------- page ----------
    function render() {
        var sub = data.subscription;
        var canCancel = isOwner && (sub.state === "trial" || sub.state === "active");
        // (replaceChildren would print the word "null" for an empty slot, so leave empty slots out)
        root.replaceChildren.apply(root, [
            statusCard(),
            isOwner && sub.state !== "suspended" ? plansSection() : null,
            isOwner ? historySection() : null,
            canCancel ? h("div", { class: "card" },
                h("h2", {}, "Cancel subscription"),
                h("p", { class: "muted" }, "You can keep working until the end date. Nothing is deleted."),
                h("button", { type: "button", class: "btn ghost danger", onclick: cancel }, "Cancel subscription")) : null
        ].filter(Boolean));
    }
    async function refreshAll() {
        try { await Promise.all([load(), loadHistory(true)]); render(); }
        catch (error) { root.replaceChildren(h("p", { class: "form-error" }, error.message)); }
    }
    root.append(h("p", { class: "empty" }, "Loading..."));
    refreshAll().then(handleReturn);
})();
