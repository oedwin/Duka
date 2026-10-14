// utils/phone.js - Ugandan phone numbers.
// We STORE digits only with the country code: 256772123456
// We SHOW them the way people write them:       0772 123 456

/** Accepts 0772123456, +256 772 123 456, 772123456 ... Returns 256772123456 or null. */
function normalizePhone(input) {
    if (input === undefined || input === null) return null;

    let digits = String(input).replace(/[^0-9]/g, "");
    if (digits.startsWith("00256")) digits = digits.slice(2);

    if (digits.startsWith("256")) {
        // already has the country code
    } else if (digits.startsWith("0")) {
        digits = "256" + digits.slice(1);
    } else if (digits.length === 9) {
        digits = "256" + digits;
    }

    return /^256[0-9]{9}$/.test(digits) ? digits : null;
}

/** 256772123456 -> "0772 123 456" (anything unexpected is returned unchanged). */
function formatPhone(stored) {
    if (!stored) return "";
    const match = /^256(\d{3})(\d{3})(\d{3})$/.exec(stored);
    return match ? `0${match[1]} ${match[2]} ${match[3]}` : stored;
}

module.exports = { normalizePhone, formatPhone };
