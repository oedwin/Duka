// utils/purchaseInput.js - rules for buying stock from suppliers (no database in here, easy to test).
const HttpError = require("./httpError");
const { cleanText, wholeNumber, parseId, has, cleanUuid } = require("./validators");
const { MAX_MONEY, cleanDate } = require("./productInput");

const METHODS = ["cash", "mobile_money", "bank"];
// The payment made at the moment stock is received is stored with this note,
// so it can be told apart from payments made later.
const INITIAL_PAYMENT_NOTE = "Paid at purchase";

function parsePurchaseInput(body) {
    body = body || {};
    const clientUuid = cleanUuid(body.clientUuid, "purchase");
    const supplierId =
        body.supplierId === undefined || body.supplierId === null || body.supplierId === ""
            ? null : parseId(body.supplierId);

    if (!Array.isArray(body.items) || body.items.length === 0) {
        throw new HttpError(400, "Add at least one product that you bought.");
    }
    if (body.items.length > 100) throw new HttpError(400, "A purchase can have at most 100 lines.");

    const items = body.items.map((item) => {
        if (!item || typeof item !== "object") throw new HttpError(400, "A line in the purchase is not filled in correctly.");
        return {
            productId: parseId(item.productId),
            unitId: parseId(item.unitId),
            quantity: wholeNumber(item.quantity, "the quantity", { min: 1, max: 100000 }),
            unitCost: wholeNumber(item.unitCost, "the buying price", { min: 0, max: MAX_MONEY }),
            updateCost: item.updateCost === true
        };
    });

    let payment = null;
    if (body.payment && Number(body.payment.amount) > 0) {
        if (!METHODS.includes(body.payment.method)) {
            throw new HttpError(400, "Choose how you paid: cash, mobile money or bank.");
        }
        payment = {
            method: body.payment.method,
            reference: cleanText(body.payment.reference, "the reference number", { required: false, max: 80 }),
            amount: wholeNumber(body.payment.amount, "the amount paid", { min: 1, max: MAX_MONEY })
        };
    }

    return {
        clientUuid, supplierId, items, payment,
        referenceNo: cleanText(body.referenceNo, "the invoice number", { required: false, max: 60 }),
        purchaseDate: cleanDate(body.purchaseDate, "the purchase date"), // null = today
        note: cleanText(body.note, "the note", { required: false, max: 300 })
    };
}

/**
 * products: Map id -> { name }     units: Map id -> { product_id, name, factor_to_base }
 * unitCost is the price of ONE of the unit bought (e.g. one carton).
 * The cost of one BASE unit (e.g. one bottle) is that divided by how many are inside, rounded.
 */
function buildPurchaseLines(items, products, units) {
    let total = 0;
    const needBase = new Map(); // productId -> stock coming in, in BASE units
    const lines = [];

    for (const item of items) {
        const product = products.get(item.productId);
        if (!product) throw new HttpError(400, "A product in this purchase is no longer available.");
        const unit = units.get(item.unitId);
        if (!unit || unit.product_id !== item.productId) {
            throw new HttpError(400, `The unit chosen for "${product.name}" is not valid.`);
        }

        const quantityBase = item.quantity * unit.factor_to_base;
        const lineTotal = item.quantity * item.unitCost;
        const costPerBase = Math.round(item.unitCost / unit.factor_to_base);
        if (![quantityBase, lineTotal].every(Number.isSafeInteger)) {
            throw new HttpError(400, `The amount for "${product.name}" is too large.`);
        }

        total += lineTotal;
        needBase.set(item.productId, (needBase.get(item.productId) || 0) + quantityBase);
        lines.push({ ...item, product, unit, quantityBase, lineTotal, costPerBase });
    }
    if (!Number.isSafeInteger(total)) throw new HttpError(400, "The total is too large.");
    return { lines, total, needBase };
}

/**
 * A payment to a supplier is spread over the oldest unpaid purchases first.
 * purchases: [{ id, balance_due }] oldest first.  Returns [{ purchaseId, amount }].
 */
function allocateOldestFirst(purchases, amount) {
    let left = amount;
    const parts = [];
    for (const purchase of purchases) {
        if (left <= 0) break;
        const take = Math.min(left, purchase.balance_due);
        if (take > 0) { parts.push({ purchaseId: purchase.id, amount: take }); left -= take; }
    }
    if (left > 0) throw new HttpError(400, "That is more than you owe this supplier.");
    return parts;
}

function parseSupplierPayment(body) {
    body = body || {};
    if (!METHODS.includes(body.method)) throw new HttpError(400, "Choose how you paid: cash, mobile money or bank.");
    return {
        clientUuid: cleanUuid(body.clientUuid, "payment"),
        amount: wholeNumber(body.amount, "the amount", { min: 1, max: MAX_MONEY }),
        method: body.method,
        reference: cleanText(body.reference, "the reference number", { required: false, max: 80 }),
        note: cleanText(body.note, "the note", { required: false, max: 300 }),
        purchaseId: has(body, "purchaseId") && body.purchaseId ? parseId(body.purchaseId) : null
    };
}

module.exports = { METHODS, INITIAL_PAYMENT_NOTE, parsePurchaseInput, buildPurchaseLines, allocateOldestFirst, parseSupplierPayment };
