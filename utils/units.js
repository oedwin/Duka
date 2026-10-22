// utils/units.js - show stock in friendly units: 135 Kg -> "2 Sacks, 35 Kg".
// units = [{ name: "Kg", factor: 1 }, { name: "Sack (50kg)", factor: 50 }]
function shortName(name) {
    return String(name).replace(/\s*\(.*\)\s*$/, "") || String(name);
}

function plural(name, n) {
    if (n === 1 || name.length <= 2 || /(kg|g|l|ml|s)$/i.test(name)) return name;
    return /(x|ch|sh)$/i.test(name) ? name + "es" : name + "s";
}

function friendlyStock(baseQty, units) {
    const qty = Math.round(Number(baseQty) || 0);
    if (qty < 0) return "-" + friendlyStock(-qty, units);

    const list = (units || []).slice().sort((a, b) => b.factor - a.factor);
    const base = list.find((u) => u.factor === 1) || { name: "units", factor: 1 };

    const parts = [];
    let rest = qty;
    for (const unit of list) {
        if (unit.factor <= 1) continue;
        const n = Math.floor(rest / unit.factor);
        if (n > 0) {
            parts.push(`${n} ${plural(shortName(unit.name), n)}`);
            rest -= n * unit.factor;
        }
    }
    if (rest > 0 || parts.length === 0) parts.push(`${rest} ${plural(shortName(base.name), rest)}`);
    return parts.join(", ");
}

module.exports = { friendlyStock, shortName };
