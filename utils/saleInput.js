// utils/saleInput.js - the rules of a sale, with no database in them so they are easy to test.
//   parseSaleInput  checks what the till sent
//   buildLines      works out line totals, costs and how much stock each product needs
//   applyDiscount   turns "10%" or "UGX 2,000" into shillings
//   findBelowCost   lists products being sold for less than they cost
const HttpError = require("./httpError");
const { cleanText, wholeNumber, parseId, has, cleanUuid } = require("./validators");
const { MAX_MONEY } = require("./productInput");

const METHODS = ["cash", "mobile_money", "bank"]; // "credit" is simply the unpaid balance
const PROVIDERS = ["mtn", "airtel"];
const MAX_LINES = 100;

function parseSaleInput(body) {
    body = body || {};

    const clientUuid = cleanUuid(body.clientUuid, "sale");
    const status = has(body, "status") ? body.status : "completed";
    if (!["completed", "held"].includes(status)) throw new HttpError(400, "Unknown sale status.");
    if (!["retail", "wholesale"].includes(body.saleType)) throw new HttpError(400, "Choose retail or wholesale.");

    const customerId =
        body.customerId === undefined || body.customerId === null || body.customerId === ""
            ? null : parseId(body.customerId);

    if (!Array.isArray(body.items) || body.items.length === 0) {
        throw new HttpError(400, "Add at least one product to the sale.");
    }
    if (body.items.length > MAX_LINES) throw new HttpError(400, `A sale can have at most ${MAX_LINES} lines.`);

    const items = body.items.map((item) => {
        if (!item || typeof item !== "object") throw new HttpError(400, "A line in the sale is not filled in correctly.");
        return {
            productId: parseId(item.productId),
            unitId: parseId(item.unitId),
            quantity: wholeNumber(item.quantity, "the quantity", { min: 1, max: 100000 }),
            unitPrice: wholeNumber(item.unitPrice, "the price", { min: 0, max: MAX_MONEY })
        };
    });

    let discount = null;
    if (body.discount && Number(body.discount.value) > 0) {
        const d = body.discount;
        if (d.type === "percent") {
            const value = Number(d.value);
            if (!Number.isFinite(value) || value < 0 || value > 100) {
                throw new HttpError(400, "The discount percent must be between 0 and 100.");
            }
            discount = { type: "percent", value };
        } else if (d.type === "amount") {
            discount = { type: "amount", value: wholeNumber(d.value, "the discount", { min: 0, max: MAX_MONEY }) };
        } else {
            throw new HttpError(400, "Choose a discount in shillings or in percent.");
        }
    }

    // A held sale is only saved for later: no payments, no stock change.
    let payments = [];
    if (status === "completed") {
        const list = Array.isArray(body.payments) ? body.payments : [];
        if (list.length > 6) throw new HttpError(400, "Too many payments on one sale.");
        payments = list.map((p) => {
            if (!p || typeof p !== "object") throw new HttpError(400, "A payment is not filled in correctly.");
            if (!METHODS.includes(p.method)) throw new HttpError(400, "Choose how the customer paid: cash, mobile money or bank.");
            let provider = null;
            if (p.method === "mobile_money" && p.provider) {
                if (!PROVIDERS.includes(p.provider)) throw new HttpError(400, "Choose MTN or Airtel.");
                provider = p.provider;
            }
            return {
                method: p.method,
                provider,
                reference: cleanText(p.reference, "the reference number", { required: false, max: 80 }),
                amount: wholeNumber(p.amount, "the payment amount", { min: 1, max: MAX_MONEY })
            };
        });
    }

    return {
        clientUuid, status,
        saleType: body.saleType,
        customerId, items, discount, payments,
        notes: cleanText(body.notes, "the note", { required: false, max: 300 }),
        allowBelowCost: body.allowBelowCost === true,
        allowOverCreditLimit: body.allowOverCreditLimit === true,
        resumeHeldId: body.resumeHeldId ? parseId(body.resumeHeldId) : null
    };
}

/**
 * products: Map id -> { name, cost_price }     (cost per BASE unit)
 * units:    Map id -> { product_id, name, factor_to_base }
 * Everything is whole shillings; cost of a line is rounded to a whole shilling.
 */
function buildLines(items, products, units) {
    let subtotal = 0;
    let cogs = 0;
    const needBase = new Map(); // productId -> stock needed in BASE units
    const lines = [];

    for (const item of items) {
        const product = products.get(item.productId);
        if (!product) throw new HttpError(400, "A product in the cart is no longer available.");
        const unit = units.get(item.unitId);
        if (!unit || unit.product_id !== item.productId) {
            throw new HttpError(400, `The unit chosen for "${product.name}" is not valid.`);
        }

        const quantityBase = item.quantity * unit.factor_to_base;
        const lineTotal = item.quantity * item.unitPrice;
        const costTotal = Math.round(quantityBase * product.cost_price);
        if (![quantityBase, lineTotal, costTotal].every(Number.isSafeInteger)) {
            throw new HttpError(400, `The amount for "${product.name}" is too large.`);
        }

        subtotal += lineTotal;
        cogs += costTotal;
        needBase.set(item.productId, (needBase.get(item.productId) || 0) + quantityBase);
        lines.push({ ...item, product, unit, quantityBase, lineTotal, costTotal });
    }

    if (!Number.isSafeInteger(subtotal) || !Number.isSafeInteger(cogs)) {
        throw new HttpError(400, "The total is too large.");
    }
    return { lines, subtotal, cogs, needBase };
}

function applyDiscount(subtotal, discount) {
    if (!discount) return 0;
    const amount = discount.type === "percent"
        ? Math.round((subtotal * discount.value) / 100)
        : discount.value;
    if (amount > subtotal) throw new HttpError(400, "The discount is more than the total.");
    return amount;
}

/** Names of products sold for less than they cost (or the whole sale, after the discount). */
function findBelowCost(lines, total, cogs) {
    const names = [...new Set(lines.filter((l) => l.lineTotal < l.costTotal).map((l) => l.product.name))];
    if (names.length === 0 && total < cogs) names.push("the whole sale (after the discount)");
    return names;
}

module.exports = { METHODS, parseSaleInput, buildLines, applyDiscount, findBelowCost };
