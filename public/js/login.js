/* login.js - the log in page */
(function () {
    "use strict";
    // Already logged in? Go straight to the shop.
    if (Duka.auth.getToken()) { window.location.replace("/dashboard.html"); return; }

    var form = document.getElementById("loginForm");
    var errorBox = document.getElementById("formError");
    var submit = document.getElementById("submit");
    var password = document.getElementById("password");

    // Handy while developing on your own computer
    if (/^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)) {
        document.getElementById("demoHint").hidden = false;
    }

    document.getElementById("showPassword").addEventListener("change", function (event) {
        password.type = event.target.checked ? "text" : "password";
    });

    form.addEventListener("submit", async function (event) {
        event.preventDefault();
        errorBox.hidden = true;

        var phone = form.phone.value.trim();
        if (!phone || !password.value) {
            errorBox.textContent = "Enter your phone number and password.";
            errorBox.hidden = false;
            return;
        }

        Duka.busy(submit, true, "Logging in...");
        try {
            var data = await Duka.api("/api/auth/login", {
                method: "POST",
                body: { phone: phone, password: password.value },
                noAuthRedirect: true
            });
            Duka.auth.save(data.token, data.user);
            window.location.href = "/dashboard.html";
        } catch (error) {
            errorBox.textContent = error.message;
            errorBox.hidden = false;
            Duka.busy(submit, false);
        }
    });
})();
