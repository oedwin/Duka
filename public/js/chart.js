/* chart.js - a simple bar chart drawn as SVG (no library to download).
     Duka.barChart({ data: [{ label: "20 Oct", value: 150000 }, ...], format: Duka.fmt.ugx })  -> an <svg> element
   Tap or hover a bar to see its figure. */
(function () {
    "use strict";
    var Duka = (window.Duka = window.Duka || {});
    var NS = "http://www.w3.org/2000/svg";

    function el(name, attrs, text) {
        var node = document.createElementNS(NS, name);
        Object.keys(attrs || {}).forEach(function (key) { node.setAttribute(key, attrs[key]); });
        if (text !== undefined) node.textContent = text;
        return node;
    }

    Duka.barChart = function (options) {
        var data = options.data || [];
        var format = options.format || String;
        var W = 600, H = 210, TOP = 22, BOTTOM = 26;
        var max = data.reduce(function (m, d) { return Math.max(m, d.value); }, 0);
        var plotH = H - TOP - BOTTOM;
        var slot = W / Math.max(data.length, 1);
        var barW = Math.max(slot * 0.68, 2);
        var every = data.length > 20 ? 5 : data.length > 10 ? 2 : 1;

        var total = data.reduce(function (s, d) { return s + d.value; }, 0);
        var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img", class: "bar-chart",
            "aria-label": (options.title || "Chart") + ". Total " + format(total) + "." });

        svg.appendChild(el("text", { x: 0, y: 12, class: "chart-max" }, max > 0 ? "Highest: " + format(max) : "Nothing sold in this period"));
        svg.appendChild(el("line", { x1: 0, x2: W, y1: H - BOTTOM, y2: H - BOTTOM, class: "chart-axis" }));

        data.forEach(function (d, i) {
            var h = max > 0 ? Math.max((d.value / max) * plotH, d.value > 0 ? 2 : 0) : 0;
            var x = i * slot + (slot - barW) / 2;
            var g = el("g", { class: "chart-bar" + (i === data.length - 1 && options.highlightLast !== false ? " last" : "") });
            g.appendChild(el("title", {}, d.label + ": " + format(d.value)));
            g.appendChild(el("rect", { x: x, y: H - BOTTOM - h, width: barW, height: h, rx: 3 }));
            // a wider invisible target so thin bars are easy to tap
            g.appendChild(el("rect", { x: i * slot, y: TOP, width: slot, height: plotH, class: "chart-hit" }));
            svg.appendChild(g);
            if (i % every === 0 || i === data.length - 1) {
                svg.appendChild(el("text", { x: x + barW / 2, y: H - 8, class: "chart-label", "text-anchor": "middle" }, d.label));
            }
        });
        return svg;
    };
})();
