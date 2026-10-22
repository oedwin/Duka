/* pricing.js - which price does the till suggest?  (The cashier can always type another price.)
   Order: customer's special price > wholesale price > retail price.
   - Wholesale sale: the wholesale price whose "from quantity" is reached.
   - Retail sale: a wholesale price that starts from MORE than 1 is a bulk price; it applies once
     the quantity reaches it (e.g. 10 Kg or more).
   - A bigger unit with no price of its own = single-unit retail price x how many are inside. */
(function () {
    "use strict";
    var Duka = (window.Duka = window.Duka || {});

    function sortedUnits(product) {
        return product.units.slice().sort(function (a, b) { return a.factor - b.factor; });
    }

    Duka.pricing = {
        /* Retail starts with the smallest unit, wholesale with the biggest. */
        defaultUnit: function (product, saleType) {
            var units = sortedUnits(product);
            return saleType === "wholesale" ? units[units.length - 1] : units[0];
        },

        /* -> { price: 5000, label: "" | "Wholesale price" | "Bulk price" | "Special price" | "Worked out from Kg" } */
        pick: function (product, unit, qty, saleType, customerId) {
            var forUnit = product.prices.filter(function (p) { return p.unitId === unit.id; });
            function best(list) { return list.sort(function (a, b) { return b.minQty - a.minQty; })[0]; }

            var special = best(forUnit.filter(function (p) {
                return p.level === "special" && customerId && p.customerId === customerId && p.minQty <= qty;
            }));
            if (special) return { price: special.price, label: "Special price" };

            var wholesale = best(forUnit.filter(function (p) { return p.level === "wholesale" && p.minQty <= qty; }));
            if (wholesale && saleType === "wholesale") return { price: wholesale.price, label: "Wholesale price" };
            if (wholesale && wholesale.minQty > 1) return { price: wholesale.price, label: "Bulk price" };

            var retail = forUnit.filter(function (p) { return p.level === "retail"; })[0];
            if (retail) return { price: retail.price, label: "" };

            var base = sortedUnits(product)[0];
            var baseRetail = product.prices.filter(function (p) {
                return p.unitId === base.id && p.level === "retail" && !p.customerId;
            })[0];
            return {
                price: baseRetail ? baseRetail.price * unit.factor : 0,
                label: unit.factor > 1 ? "Worked out from " + base.name : ""
            };
        }
    };
})();
