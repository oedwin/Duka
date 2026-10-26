// utils/expenseInput.js - rules for expenses and for the end-of-day cash count (no database in here).
const HttpError = require("./httpError");
const { cleanText, wholeNumber, parseId, cleanUuid } = require("./validators");
const { MAX_MONEY, cleanDate } = require("./productInput");
const { METHODS } = require("./saleInput");

function parseExpense(body) {
    body = body || {};
    const categoryId =
        body.categoryId === undefined || body.categoryId === null || body.categoryId === ""
            ? null : parseId(body.categoryId);
    const description = cleanText(body.description, "what it was for", { required: false, max: 300 });
    if (!categoryId && !description) {
        throw new HttpError(400, "Choose a category or write what the money was spent on.");
    }
    const paymentMethod = body.paymentMethod === undefined ? "cash" : body.paymentMethod;
    if (!METHODS.includes(paymentMethod)) throw new HttpError(400, "Choose how it was paid: cash, mobile money or bank.");

    return {
        clientUuid: cleanUuid(body.clientUuid, "expense"),
        categoryId, description, paymentMethod,
        amount: wholeNumber(body.amount, "the amount", { min: 1, max: MAX_MONEY }),
        expenseDate: cleanDate(body.expenseDate, "the date of the expense") // null = today
    };
}

/**
 * Cash that should be in the drawer at the end of a day:
 *   what was there at the start
 *   + cash received (sales and debt repayments)
 *   - cash handed back (cancelled payments, refunds for returns)
 *   - cash spent (expenses, supplier payments, goods bought and paid on the spot)
 */
function expectedCash(parts) {
    return parts.opening + parts.saleCash + parts.debtCash
        - parts.cancelledCash - parts.refundCash
        - parts.expenseCash - parts.supplierCash - parts.purchaseCash;
}

function parseClosing(body, today) {
    body = body || {};
    const date = cleanDate(body.date, "the date") || today;
    if (date > today) throw new HttpError(400, "You cannot close a day that has not happened yet.");
    return {
        date,
        countedCash: wholeNumber(body.countedCash, "the cash you counted", { min: 0, max: MAX_MONEY }),
        note: cleanText(body.note, "the note", { required: false, max: 300 })
    };
}

module.exports = { parseExpense, expectedCash, parseClosing };
