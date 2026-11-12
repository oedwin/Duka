/* staff.js - the owner adds staff, gives them a role, switches them on/off and resets passwords.
   The role decides what a person can do (see ROLE_HELP). Only the owner can open this page. */
(async function () {
    "use strict";
    var h = Duka.h;
    var page = await Duka.initPage({ title: "Staff", roles: ["owner"] });
    var me = page.user;
    var list = h("div", {}, h("p", { class: "empty" }, "Loading..."));

    var ROLE_LABEL = { cashier: "Cashier", owner: "Owner" };
    var ROLE_HELP = {
        cashier: "Can sell, look at products and stock, and see their own sales. Cannot see profit or cost prices. Cannot close the day.",
        owner: "Full access: reports and profit, expenses, purchases, suppliers, customers, settings, staff, closing the day, and the sales of every staff member."
    };

    /* A pop-up form with text fields and a Role chooser.
       Resolves with { ...fields, role } or null when cancelled. */
    function askForm(options) {
        return new Promise(function (resolve) {
            var inputs = {};
            var errorBox = h("p", { class: "form-error", hidden: true });
            var form = h("form", { novalidate: true }, h("h2", {}, options.title));
            if (options.message) form.appendChild(h("p", {}, options.message));

            (options.fields || []).forEach(function (field, index) {
                var id = "sf_" + index;
                var input = h("input", {
                    class: "input", id: id, name: field.name, type: field.type || "text",
                    autocomplete: "off", inputmode: field.inputmode
                });
                inputs[field.name] = input;
                form.appendChild(h("div", { class: "field" },
                    h("label", { for: id }, field.label), input,
                    field.help ? h("span", { class: "help" }, field.help) : null));
            });

            var select = h("select", { class: "input", id: "sf_role", "aria-label": "Role" },
                Object.keys(ROLE_LABEL).map(function (key) { return h("option", { value: key }, ROLE_LABEL[key]); }));
            select.value = ROLE_LABEL[options.role] ? options.role : "cashier";
            var roleHelp = h("span", { class: "help" });
            function showHelp() { roleHelp.textContent = ROLE_HELP[select.value]; }
            select.addEventListener("change", showHelp);
            showHelp();
            form.appendChild(h("div", { class: "field" }, h("label", { for: "sf_role" }, "Role"), select, roleHelp));

            var cancel = h("button", { type: "button", class: "btn ghost" }, "Cancel");
            var confirm = h("button", { type: "submit", class: "btn" }, options.confirmText || "Save");
            form.append(errorBox, h("div", { class: "actions" }, cancel, confirm));

            var modal = Duka.modal(form, { sticky: true });
            var done = false;
            function finish(value) { if (done) return; done = true; modal.close(); resolve(value); }

            cancel.addEventListener("click", function () { finish(null); });
            form.addEventListener("submit", function (event) {
                event.preventDefault();
                var values = {};
                var fields = options.fields || [];
                for (var i = 0; i < fields.length; i++) {
                    var value = inputs[fields[i].name].value;
                    if (!String(value).trim()) {
                        errorBox.textContent = "Please fill in: " + fields[i].label;
                        errorBox.hidden = false;
                        inputs[fields[i].name].focus();
                        return;
                    }
                    values[fields[i].name] = value;
                }
                values.role = select.value;
                finish(values);
            });
            (fields0(options) ? inputs[options.fields[0].name] : select).focus();
        });
    }
    function fields0(options) { return options.fields && options.fields.length; }

    async function load() {
        try {
            var data = await Duka.api("/api/users");
            render(data.staff);
        } catch (error) {
            list.replaceChildren(h("p", { class: "form-error" }, error.message));
        }
    }

    function render(staff) {
        if (!staff.length) {
            list.replaceChildren(h("p", { class: "empty" }, "No staff yet."));
            return;
        }
        list.replaceChildren.apply(list, staff.map(function (person) {
            var isMe = person.id === me.id;
            return h("div", { class: "row" },
                h("div", { class: "grow" },
                    h("div", { class: "name" }, person.fullName + (isMe ? " (you)" : "")),
                    h("div", { class: "sub" }, person.phoneDisplay)),
                h("span", { class: "badge" + (person.isActive ? "" : " off") },
                    person.isActive ? (ROLE_LABEL[person.role] || person.role) : "Switched off"),
                h("div", { class: "actions" },
                    isMe ? null : h("button", { class: "btn ghost small", type: "button", onclick: function () { changeRole(person); } }, "Change role"),
                    h("button", { class: "btn ghost small", type: "button", onclick: function () { resetPassword(person); } }, "New password"),
                    isMe ? null : h("button", {
                        class: "btn ghost small" + (person.isActive ? " danger" : ""), type: "button",
                        onclick: function () { toggleActive(person); }
                    }, person.isActive ? "Switch off" : "Switch on")));
        }));
    }

    async function addStaff() {
        var values = await askForm({
            title: "Add staff",
            confirmText: "Add staff",
            role: "cashier",
            fields: [
                { name: "fullName", label: "Name" },
                { name: "phone", label: "Phone number", type: "tel", inputmode: "tel", help: "They will log in with this number." },
                { name: "password", label: "Starting password", help: "At least 6 characters. Tell it to them privately." }
            ]
        });
        if (!values) return;
        try {
            await Duka.api("/api/users", { method: "POST", body: values });
            Duka.toast("Staff member added");
            load();
        } catch (error) {
            Duka.toast(error.message, "error");
        }
    }

    async function changeRole(person) {
        var values = await askForm({
            title: "Role for " + person.fullName,
            confirmText: "Save role",
            role: person.role,
            fields: []
        });
        if (!values || values.role === person.role) return;
        if (values.role === "owner") {
            var ok = await Duka.dialog({
                title: "Make " + person.fullName + " an owner?",
                message: "Owners can see profit and cost prices, change settings and staff, and close the day.",
                confirmText: "Make owner", danger: true
            });
            if (!ok) return;
        }
        try {
            await Duka.api("/api/users/" + person.id, { method: "PATCH", body: { role: values.role } });
            Duka.toast("Role changed to " + ROLE_LABEL[values.role]);
            load();
        } catch (error) {
            Duka.toast(error.message, "error");
        }
    }

    async function resetPassword(person) {
        var values = await Duka.dialog({
            title: "New password for " + person.fullName,
            confirmText: "Save password",
            fields: [{ name: "newPassword", label: "New password", help: "At least 6 characters." }]
        });
        if (!values) return;
        try {
            var result = await Duka.api("/api/users/" + person.id + "/reset-password", {
                method: "POST", body: { newPassword: values.newPassword }
            });
            Duka.toast("New password saved");
            return result;
        } catch (error) {
            Duka.toast(error.message, "error");
        }
    }

    async function toggleActive(person) {
        var turningOff = person.isActive;
        var ok = await Duka.dialog({
            title: turningOff ? "Switch off " + person.fullName + "?" : "Switch on " + person.fullName + "?",
            message: turningOff
                ? "They will not be able to log in. Their past sales stay in your records."
                : "They will be able to log in again.",
            confirmText: turningOff ? "Switch off" : "Switch on",
            danger: turningOff
        });
        if (!ok) return;
        try {
            await Duka.api("/api/users/" + person.id, { method: "PATCH", body: { isActive: !person.isActive } });
            Duka.toast(turningOff ? "Switched off" : "Switched on");
            load();
        } catch (error) {
            Duka.toast(error.message, "error");
        }
    }

    page.main.append(
        h("div", { class: "page-head" },
            h("h1", {}, "Staff"),
            h("p", {}, "Give each person a role. A Cashier can sell and look at stock but cannot see profit, cost prices or close the day. An Owner can do everything.")),
        h("div", { class: "card" },
            h("div", { class: "actions" },
                h("button", { class: "btn", type: "button", onclick: addStaff }, "Add staff")),
            list)
    );
    load();
})();
