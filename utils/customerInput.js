// utils/customerInput.js - rules for customers and the money they pay back (no database in here).
const HttpError = require("./httpError");
const { cleanText, wholeNumber, has, cleanUuid } = require("./validators");
const { MAX_MONEY, cleanDate } = require("./productInput");
const { normalizePhone } = require("./phone");
const { METHODS } = require("./saleInput");

const PROVIDERS = ["mtn", "airtel"];

function cleanPhoneOptional(value) {
    if (value === undefined || value === null || String(value).trim() === "") return null;
    const phone = normalizePhone(value);
    if (!phone) throw new HttpError(400, "Enter a valid phone number, like 0772 123 456, or leave it empty.");
    return phone;
}

function cleanCreditLimit(value) {
    if (value === undefined || value === null || String(value).trim() === "") return null; // no limit
    return wholeNumber(value, "the credit limit", { min: 0, max: MAX_MONEY });
}

/** A customer paying back some of what they owe. */
function parseDebtPayment(body) {
    body = body || {};
    if (!METHODS.includes(body.method)) throw new HttpError(400, "Choose how they paid: cash, mobile money or bank.");
    let provider = null;
    if (body.method === "mobile_money" && body.provider) {
        if (!PROVIDERS.includes(body.provider)) throw new HttpError(400, "Choose MTN or Airtel.");
        provider = body.provider;
    }
    return {
        clientUuid: cleanUuid(body.clientUuid, "payment"),
        amount: wholeNumber(body.amount, "the amount", { min: 1, max: MAX_MONEY }),
        method: body.method,
        provider,
        reference: cleanText(body.reference, "the reference number", { required: false, max: 80 }),
        note: cleanText(body.note, "the note", { required: false, max: 300 })
    };
}

/** Fields for adding a customer. The owner may also record money already owed from before Duka. */
function parseNewCustomer(body, isOwner) {
    body = body || {};
    const opening = isOwner && has(body, "openingBalance") && String(body.openingBalance).trim() !== ""
        ? wholeNumber(body.openingBalance, "the money already owed", { min: 0, max: MAX_MONEY }) : 0;
    return {
        name: cleanText(body.name, "the customer's name"),
        phone: cleanPhoneOptional(body.phone),
        location: cleanText(body.location, "the location", { required: false, max: 150 }),
        customerType: body.customerType === "wholesale" ? "wholesale" : "retail",
        creditLimit: isOwner ? cleanCreditLimit(body.creditLimit) : null,
        notes: isOwner ? cleanText(body.notes, "the notes", { required: false, max: 500 }) : null,
        openingBalance: opening,
        owedSince: opening > 0 ? cleanDate(body.owedSince, "the date it has been owed since") : null
    };
}

module.exports = { PROVIDERS, cleanPhoneOptional, cleanCreditLimit, parseDebtPayment, parseNewCustomer };
