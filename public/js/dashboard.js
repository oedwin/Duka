/* dashboard.js - the Home screen. For now it welcomes the user;
   today's sales, money owed and low stock arrive with the later steps. */
(async function () {
    "use strict";
    var h = Duka.h;
    var page = await Duka.initPage({ title: "Home" });
    var user = page.user;
    var firstName = (user.fullName || "").split(" ")[0];

    page.main.append(
        h("div", { class: "page-head" },
            h("h1", {}, "Hello, " + firstName),
            h("p", {}, user.role === "owner" ? "You are the owner of " + user.shopName + "." : "You are logged in at " + user.shopName + ".")),
        h("div", { class: "card" },
            h("h2", {}, "Your shop is ready"),
            h("p", {}, "Add your products first. Selling and receipts come in the next steps."),
            h("div", { class: "actions" },
                h("a", { class: "btn", href: "/products.html" }, "Products"),
                user.role === "owner" ? h("a", { class: "btn ghost", href: "/settings.html" }, "Shop settings") : null,
                user.role === "owner" ? h("a", { class: "btn ghost", href: "/staff.html" }, "Staff") : null))
    );
})();
