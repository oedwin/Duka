// utils/stockInput.js - rules for stock adjustments and stock-taking (no database in here).
const HttpError = require("./httpError");
const { cleanText, wholeNumber, parseId, cleanUuid } = require("./validators");

const OUT_REASONS = ["damaged", "expired", "lost", "other"]; // stock goes down
const IN_REASONS = ["found", "other"];                       // stock goes up

function parseAdjustment(body) {
    body = body || {};
    const direction = body.direction;
    if (!["in", "out"].includes(direction)) throw new HttpError(400, "Choose whether stock goes up or down.");
    const reason = body.reason;
    const allowed = direction === "out" ? OUT_REASONS : IN_REASONS;
    if (!allowed.includes(reason)) throw new HttpError(400, "Choose the reason for this change.");

    const note = cleanText(body.note, "the note", { required: reason === "other", max: 300 });
    return {
        clientUuid: cleanUuid(body.clientUuid, "adjustment"),
        productId: parseId(body.productId),
        unitId: parseId(body.unitId),
        quantity: wholeNumber(body.quantity, "the quantity", { min: 1, max: 1000000 }),
        direction, reason, note
    };
}

function parseStockTake(body) {
    body = body || {};
    if (!Array.isArray(body.counts) || body.counts.length === 0) {
        throw new HttpError(400, "Enter the counted quantity of at least one product.");
    }
    if (body.counts.length > 300) throw new HttpError(400, "Send at most 300 products at a time.");

    const seen = new Set();
    const counts = body.counts.map((row) => {
        if (!row || typeof row !== "object") throw new HttpError(400, "A count is not filled in correctly.");
        const productId = parseId(row.productId);
        if (seen.has(productId)) throw new HttpError(400, "A product is listed twice.");
        seen.add(productId);
        return { productId, countedBase: wholeNumber(row.countedBase, "the counted quantity", { min: 0, max: 100000000 }) };
    });

    return {
        clientUuid: cleanUuid(body.clientUuid, "stock-take"),
        note: cleanText(body.note, "the note", { required: false, max: 300 }),
        counts
    };
}

module.exports = { OUT_REASONS, IN_REASONS, parseAdjustment, parseStockTake };
