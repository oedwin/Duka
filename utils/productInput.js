// utils/productInput.js - checks and cleans product data (units, prices, dates, photo).
// Kept apart from the route so the rules are easy to read and test.
const HttpError = require("./httpError");
const { cleanText, wholeNumber, parseId } = require("./validators");

const MAX_UNITS = 6;
const MAX_MONEY = 10000000000; // UGX 10 billion
const MAX_PHOTO_LENGTH = 250000; // characters of the data URL (about 180 KB)
const LEVELS = ["retail", "wholesale"]; // 'special' prices are set per customer later

/** "2026-12-31" or empty. Rejects impossible dates like 2026-02-31. `label` names the field in the message. */
function cleanDate(value, label = "the expiry date") {
    if (value === undefined || value === null || value === "") return null;
    const text = String(value).trim();
    const valid =
        /^\d{4}-\d{2}-\d{2}$/.test(text) &&
        !Number.isNaN(Date.parse(text)) &&
        new Date(text + "T00:00:00Z").toISOString().slice(0, 10) === text;
    if (!valid) throw new HttpError(400, `Please check ${label}: that is not a real date.`);
    return text;
}

/** A small picture as a data URL, or null to have no picture. */
function cleanPhoto(value) {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) {
        throw new HttpError(400, "The picture must be a PNG or JPG.");
    }
    if (value.length > MAX_PHOTO_LENGTH) {
        throw new HttpError(400, "The picture is too big. Choose a smaller one.");
    }
    return value;
}

/**
 * Units of one product, e.g. [{name:"Piece",factor:1},{name:"Pack",factor:10},{name:"Carton",factor:120}]
 * factor = how many of the SMALLEST unit are inside one of this unit.
 * Exactly one unit has factor 1: that is the base unit and stock is kept in it.
 */
function cleanUnits(list) {
    if (!Array.isArray(list) || list.length === 0) {
        throw new HttpError(400, "Enter the unit you sell in, for example Piece or Kg.");
    }
    if (list.length > MAX_UNITS) {
        throw new HttpError(400, `A product can have at most ${MAX_UNITS} units.`);
    }

    const seen = new Set();
    let baseCount = 0;
    const units = list.map((item) => {
        if (!item || typeof item !== "object") throw new HttpError(400, "A unit is not filled in correctly.");
        const name = cleanText(item.name, "the unit name", { max: 50 });
        const key = name.toLowerCase();
        if (seen.has(key)) throw new HttpError(400, `You listed the unit "${name}" twice.`);
        seen.add(key);

        const factor = wholeNumber(item.factor, `the number inside one ${name}`, { min: 1, max: 1000000 });
        if (factor === 1) baseCount++;

        const id = item.id === undefined || item.id === null ? undefined : parseId(item.id);
        return { id, name, key, factor };
    });

    if (baseCount !== 1) {
        throw new HttpError(400, "Exactly one unit must be the smallest unit (the one with 1 inside).");
    }
    return units;
}

/** Prices as sent: [{unit:"Kg", level:"retail", price:5000, minQty:1}, ...] */
function cleanPrices(list) {
    if (!Array.isArray(list)) throw new HttpError(400, "Enter the selling price.");

    const seen = new Set();
    return list.map((item) => {
        if (!item || typeof item !== "object") throw new HttpError(400, "A price is not filled in correctly.");
        if (!LEVELS.includes(item.level)) {
            throw new HttpError(400, "Prices here must be retail or wholesale.");
        }
        const unitName = cleanText(item.unit, "the unit for a price", { max: 50 });
        const price = wholeNumber(item.price, `the ${item.level} price`, { min: 1, max: MAX_MONEY });
        const minQty =
            item.level === "retail"
                ? 1
                : wholeNumber(item.minQty === undefined || item.minQty === null ? 1 : item.minQty,
                    "the wholesale minimum quantity", { min: 1, max: 1000000 });

        const unitKey = unitName.toLowerCase();
        const duplicate = `${unitKey}|${item.level}|${minQty}`;
        if (seen.has(duplicate)) {
            throw new HttpError(400, `"${unitName}" has the same ${item.level} price listed twice.`);
        }
        seen.add(duplicate);
        return { unitKey, level: item.level, price, minQty };
    });
}

/**
 * Match prices to real unit ids (unitIds is a Map of lower-case name -> id)
 * and make sure the base unit has a retail price, so every product can always be sold.
 */
function resolvePrices(prices, unitIds, baseUnitId) {
    const resolved = [];
    const seen = new Set();
    let hasBaseRetail = false;

    for (const price of prices) {
        const unitId = unitIds.get(price.unitKey);
        if (!unitId) throw new HttpError(400, "A price refers to a unit that is not on this product.");

        const duplicate = `${unitId}|${price.level}|${price.minQty}`;
        if (seen.has(duplicate)) throw new HttpError(400, "The same price is listed twice.");
        seen.add(duplicate);

        if (unitId === baseUnitId && price.level === "retail" && price.minQty === 1) hasBaseRetail = true;
        resolved.push({ unitId, level: price.level, price: price.price, minQty: price.minQty });
    }

    if (!hasBaseRetail) throw new HttpError(400, "Enter the selling price.");
    return resolved;
}

/** Make text safe to use inside ILIKE '%...%' */
function escapeLike(text) {
    return String(text).replace(/[\\%_]/g, (character) => "\\" + character);
}

/** CSV cell -> clean number text: "UGX 25,000" -> "25000"; empty -> undefined */
function num(value) {
    if (value === undefined || value === null) return undefined;
    const text = String(value).replace(/ugx/gi, "").replace(/[,\s]/g, "");
    return text === "" ? undefined : text;
}

module.exports = {
    MAX_MONEY, cleanDate, cleanPhoto, cleanUnits, cleanPrices, resolvePrices, escapeLike, num
};
