// utils/money.js - UGX text for messages: 25000 -> "UGX 25,000" (whole shillings only).
function ugx(amount) {
    const n = Math.round(Number(amount) || 0);
    return "UGX " + (n < 0 ? "-" : "") + String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

module.exports = { ugx };
