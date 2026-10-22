/* ui.js - small helpers: build elements, messages, pop-up questions, pictures. */
(function () {
    "use strict";
    var Duka = (window.Duka = window.Duka || {});

    /* Duka.h("button", {class:"btn", onclick: fn}, "Save")  builds an element safely
       (text is never treated as HTML, so customer names cannot break the page). */
    Duka.h = function (tag, attrs) {
        var el = document.createElement(tag);
        var children = Array.prototype.slice.call(arguments, 2);
        Object.keys(attrs || {}).forEach(function (key) {
            var value = attrs[key];
            if (value === null || value === undefined || value === false) return;
            if (key === "class") el.className = value;
            else if (key === "text") el.textContent = value;
            else if (key.indexOf("on") === 0 && typeof value === "function") el.addEventListener(key.slice(2), value);
            else el.setAttribute(key, value === true ? "" : value);
        });
        (function add(list) {
            list.forEach(function (child) {
                if (child === null || child === undefined || child === false) return;
                if (Array.isArray(child)) return add(child);
                el.append(child.nodeType ? child : document.createTextNode(String(child)));
            });
        })(children);
        return el;
    };

    /* Short message at the bottom: Duka.toast("Saved"), Duka.toast("Failed", "error") */
    Duka.toast = function (message, type) {
        var box = document.getElementById("toasts");
        if (!box) {
            box = Duka.h("div", { id: "toasts", role: "status", "aria-live": "polite" });
            document.body.appendChild(box);
        }
        var toast = Duka.h("div", { class: "toast" + (type === "error" ? " error" : "") }, message);
        box.appendChild(toast);
        setTimeout(function () { toast.remove(); }, type === "error" ? 6000 : 3500);
    };

    /* Pop-up with your own content. Duka.modal(element, {sticky:true}) returns {close}.
       sticky = tapping outside does not close it (use for forms with money in them). */
    Duka.modal = function (content, options) {
        options = options || {};
        var previousFocus = document.activeElement;
        var overlay = Duka.h("div", { class: "overlay" },
            Duka.h("div", { class: "dialog" + (options.wide ? " wide" : ""), role: "dialog", "aria-modal": "true" }, content));
        function close() {
            document.removeEventListener("keydown", onKey);
            overlay.remove();
            if (previousFocus && previousFocus.focus) previousFocus.focus();
            if (options.onClose) options.onClose();
        }
        function onKey(event) { if (event.key === "Escape") close(); }
        if (!options.sticky) {
            document.addEventListener("keydown", onKey);
            overlay.addEventListener("click", function (event) { if (event.target === overlay) close(); });
        }
        document.body.appendChild(overlay);
        return { close: close, overlay: overlay };
    };

    /* A message to show on the NEXT page, e.g. after saving: Duka.flash("Product added") */
    Duka.flash = function (message) {
        try { sessionStorage.setItem("duka_flash", message); } catch (e) { /* ignore */ }
    };

    /* Disable a button while something is saving. */
    Duka.busy = function (button, isBusy, busyText) {
        if (isBusy) {
            button.dataset.label = button.textContent;
            button.textContent = busyText || "Please wait...";
            button.disabled = true;
        } else {
            button.textContent = button.dataset.label || button.textContent;
            button.disabled = false;
        }
    };

    /* Pop-up question. Resolves with the typed values (or true when there are no fields),
       and with null when the person cancels.
       Duka.dialog({title, message, fields:[{name,label,type,value,autocomplete,help}],
                    confirmText, cancelText, danger}) */
    Duka.dialog = function (options) {
        return new Promise(function (resolve) {
            var previousFocus = document.activeElement;
            var fields = options.fields || [];
            var errorBox = Duka.h("p", { class: "form-error", hidden: true });
            var inputs = {};

            var form = Duka.h("form", { novalidate: true });
            form.appendChild(Duka.h("h2", {}, options.title || "Please confirm"));
            if (options.message) form.appendChild(Duka.h("p", {}, options.message));

            fields.forEach(function (field, index) {
                var id = "dlg_" + index;
                var input = Duka.h("input", {
                    class: "input", id: id, name: field.name, type: field.type || "text",
                    value: field.value || "", autocomplete: field.autocomplete || "off",
                    inputmode: field.inputmode
                });
                inputs[field.name] = input;
                form.appendChild(Duka.h("div", { class: "field" },
                    Duka.h("label", { for: id }, field.label),
                    input,
                    field.help ? Duka.h("span", { class: "help" }, field.help) : null));
            });

            form.appendChild(errorBox);
            var cancel = Duka.h("button", { type: "button", class: "btn ghost" }, options.cancelText || "Cancel");
            var confirm = Duka.h("button", { type: "submit", class: "btn" + (options.danger ? " danger" : "") },
                options.confirmText || "Confirm");
            form.appendChild(Duka.h("div", { class: "actions" }, cancel, confirm));

            var overlay = Duka.h("div", { class: "overlay" },
                Duka.h("div", { class: "dialog", role: "dialog", "aria-modal": "true" }, form));
            document.body.appendChild(overlay);

            function close(result) {
                document.removeEventListener("keydown", onKey);
                overlay.remove();
                if (previousFocus && previousFocus.focus) previousFocus.focus();
                resolve(result);
            }
            function onKey(event) { if (event.key === "Escape") close(null); }
            document.addEventListener("keydown", onKey);

            cancel.addEventListener("click", function () { close(null); });
            overlay.addEventListener("click", function (event) { if (event.target === overlay) close(null); });
            form.addEventListener("submit", function (event) {
                event.preventDefault();
                var values = {};
                for (var i = 0; i < fields.length; i++) {
                    var value = inputs[fields[i].name].value;
                    if (fields[i].required !== false && !String(value).trim()) {
                        errorBox.textContent = "Please fill in: " + fields[i].label;
                        errorBox.hidden = false;
                        inputs[fields[i].name].focus();
                        return;
                    }
                    values[fields[i].name] = value;
                }
                close(fields.length ? values : true);
            });

            (fields.length ? inputs[fields[0].name] : confirm).focus();
        });
    };

    /* Shrink a chosen picture in the browser so it is small to store and send.
       Resolves with a data URL (PNG stays PNG so logos keep their transparency). */
    Duka.resizeImage = function (file, maxSize, asJpeg) {
        return new Promise(function (resolve, reject) {
            if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
                return reject(new Error("Please choose a PNG or JPG picture."));
            }
            var url = URL.createObjectURL(file);
            var image = new Image();
            image.onload = function () {
                var scale = Math.min(1, maxSize / Math.max(image.width, image.height));
                var canvas = document.createElement("canvas");
                canvas.width = Math.max(1, Math.round(image.width * scale));
                canvas.height = Math.max(1, Math.round(image.height * scale));
                var context = canvas.getContext("2d");
                if (asJpeg) { context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height); }
                context.drawImage(image, 0, 0, canvas.width, canvas.height);
                URL.revokeObjectURL(url);
                resolve(file.type === "image/png" && !asJpeg
                    ? canvas.toDataURL("image/png")
                    : canvas.toDataURL("image/jpeg", 0.82));
            };
            image.onerror = function () {
                URL.revokeObjectURL(url);
                reject(new Error("That picture could not be opened."));
            };
            image.src = url;
        });
    };
})();
