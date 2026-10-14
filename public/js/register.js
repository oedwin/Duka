/* register.js - create a new shop and its owner */
(function () {
    "use strict";
    if (Duka.auth.getToken()) { window.location.replace("/dashboard.html"); return; }

    var form = document.getElementById("registerForm");
    var errorBox = document.getElementById("formError");
    var submit = document.getElementById("submit");

    function fail(message) {
        errorBox.textContent = message;
        errorBox.hidden = false;
    }

    form.addEventListener("submit", async function (event) {
        event.preventDefault();
        errorBox.hidden = true;

        if (form.password.value !== form.password2.value) {
            return fail("The two passwords are not the same. Please type them again.");
        }

        Duka.busy(submit, true, "Creating your shop...");
        try {
            var data = await Duka.api("/api/auth/register", {
                method: "POST",
                noAuthRedirect: true,
                body: {
                    shopName: form.shopName.value,
                    address: form.address.value,
                    fullName: form.fullName.value,
                    phone: form.phone.value,
                    password: form.password.value
                }
            });
            Duka.auth.save(data.token, data.user);
            window.location.href = "/dashboard.html";
        } catch (error) {
            fail(error.message);
            Duka.busy(submit, false);
        }
    });
})();
