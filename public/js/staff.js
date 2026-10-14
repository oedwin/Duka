/* staff.js - the owner adds staff, switches them on/off and resets passwords */
(async function () {
    "use strict";
    var h = Duka.h;
    var page = await Duka.initPage({ title: "Staff", roles: ["owner"] });
    var me = page.user;
    var list = h("div", {}, h("p", { class: "empty" }, "Loading..."));

    var ROLE_LABEL = { owner: "Owner", cashier: "Cashier" };

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
                    person.isActive ? ROLE_LABEL[person.role] : "Switched off"),
                h("div", { class: "actions" },
                    h("button", { class: "btn ghost small", type: "button", onclick: function () { resetPassword(person); } }, "New password"),
                    isMe ? null : h("button", {
                        class: "btn ghost small" + (person.isActive ? " danger" : ""), type: "button",
                        onclick: function () { toggleActive(person); }
                    }, person.isActive ? "Switch off" : "Switch on")));
        }));
    }

    async function addStaff() {
        var values = await Duka.dialog({
            title: "Add staff",
            confirmText: "Add staff",
            fields: [
                { name: "fullName", label: "Name", autocomplete: "off" },
                { name: "phone", label: "Phone number", type: "tel", inputmode: "tel", help: "They will log in with this number." },
                { name: "password", label: "Starting password", help: "At least 6 characters. Tell it to them privately." }
            ]
        });
        if (!values) return;
        try {
            // New staff are cashiers: they can sell and view stock, but never see profit or cost prices.
            await Duka.api("/api/users", { method: "POST", body: Object.assign({ role: "cashier" }, values) });
            Duka.toast("Staff member added");
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
            h("p", {}, "Cashiers can sell and look at stock. They cannot see profit or cost prices.")),
        h("div", { class: "card" },
            h("div", { class: "actions" },
                h("button", { class: "btn", type: "button", onclick: addStaff }, "Add staff")),
            list)
    );
    load();
})();
