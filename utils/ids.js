// utils/ids.js - ids derived from the browser's unique id.
// One screen action can create several rows (e.g. a payment spread over two purchases).
// Each row gets its own id made from the action's id, so repeating the action is still safe.
const crypto = require("crypto");

function derivedUuid(base, key) {
    const hex = crypto.createHash("md5").update(`${base}:${key}`).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

module.exports = { derivedUuid };
