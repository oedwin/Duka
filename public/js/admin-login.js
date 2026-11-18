/* admin-login.js - the administrator's own login. Keeps its token under its own name, so it never
   mixes with a shop login. */
(function () {
    "use strict";
    var KEY = "duka_admin_token";
    var form = document.getElementById("loginForm");
    var errorBox = document.getElementById("formError");
    var button = document.getElementById("submit");
    try { if (localStorage.getItem(KEY)) { window.location.replace("/admin"); return; } } catch (e) { /* ignore */ }

    form.addEventListener("submit", async function (event) {
        event.preventDefault();
        errorBox.hidden = true;
        var phone = form.phone.value.trim();
        var password = form.password.value;
        if (!phone || !password) { errorBox.textContent = "Please enter your phone number and password."; errorBox.hidden = false; return; }
        Duka.busy(button, true, "Please wait...");
        try {
            var res = await Duka.api("/api/admin/login", { method: "POST", body: { phone: phone, password: password }, noAuthRedirect: true });
            localStorage.setItem(KEY, res.token);
            window.location.replace("/admin");
        } catch (error) {
            errorBox.textContent = error.message;
            errorBox.hidden = false;
            Duka.busy(button, false);
        }
    });
})();
