// utils/validators.js - small input checks with messages a shopkeeper can understand.
const HttpError = require("./httpError");

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/** Clean up text. `label` is a phrase like "the shop name". Returns null if optional and empty. */
function cleanText(value, label, { max = 150, required = true } = {}) {
    const text = value === undefined || value === null ? "" : String(value).trim();
    if (!text) {
        if (required) throw new HttpError(400, `Please enter ${label}.`);
        return null;
    }
    if (text.length > max) {
        throw new HttpError(400, `${capitalize(label)} is too long (at most ${max} characters).`);
    }
    return text;
}

/** Passwords: at least 6 characters (bcrypt only reads the first 72). */
function checkPassword(value, label = "password") {
    if (typeof value !== "string" || value.length < 6) {
        throw new HttpError(400, `The ${label} must be at least 6 characters.`);
    }
    if (value.length > 72) {
        throw new HttpError(400, `The ${label} is too long (at most 72 characters).`);
    }
    return value;
}

/** Whole numbers only (UGX and stock are never decimals). */
function wholeNumber(value, label, { min = 0, max = 1000000000000 } = {}) {
    const number = Number(value);
    if (value === "" || value === null || !Number.isInteger(number) || number < min || number > max) {
        throw new HttpError(400, `${capitalize(label)} must be a whole number from ${min} to ${max}.`);
    }
    return number;
}

/** An id from the URL, e.g. /api/users/12 */
function parseId(value) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "That item could not be found.");
    return id;
}

/** True when the request body contains this key (so we only change what was sent). */
function has(body, key) {
    return Object.prototype.hasOwnProperty.call(body || {}, key);
}

/** The unique id the browser makes for each sale/payment (see Duka.uuid) */
function cleanUuid(value, label = "request") {
    const text = typeof value === "string" ? value.trim() : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) {
        throw new HttpError(400, `The ${label} is missing its unique id. Please refresh the page and try again.`);
    }
    return text.toLowerCase();
}

module.exports = { cleanText, checkPassword, wholeNumber, parseId, has, cleanUuid };
