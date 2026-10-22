// routes/settings.js - business details, receipts and stock defaults.
//   GET /api/settings    anyone logged in (receipts need the shop details)
//   PUT /api/settings    owner only; only the fields you send are changed
const express = require("express");

const pool = require("../db");
const HttpError = require("../utils/httpError");
const asyncHandler = require("../utils/asyncHandler");
const { cleanText, wholeNumber, has } = require("../utils/validators");
const { logAudit } = require("../utils/audit");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

const PAPER_SIZES = ["58mm", "80mm", "A4"];
const LANGUAGES = ["en"]; // Luganda / Swahili can be added here later
const MAX_LOGO_LENGTH = 300000; // characters of the data URL (about 220 KB)

/** Read everything the Settings screen and receipts need. */
async function loadSettings(db, shopId) {
    const shopResult = await db.query(
        `SELECT name, address, phone, tin, logo, receipt_footer, receipt_paper,
                allow_negative_stock, currency
         FROM shops WHERE id = $1`,
        [shopId]
    );
    const shop = shopResult.rows[0];
    if (!shop) throw new HttpError(404, "Shop not found.");

    const kv = await db.query("SELECT key, value FROM settings WHERE shop_id = $1", [shopId]);
    const values = Object.fromEntries(kv.rows.map((row) => [row.key, row.value]));

    return {
        shopName: shop.name,
        address: shop.address,
        phone: shop.phone,
        tin: shop.tin,
        logo: shop.logo,
        receiptFooter: shop.receipt_footer,
        receiptPaper: shop.receipt_paper,
        allowNegativeStock: shop.allow_negative_stock,
        currency: shop.currency,
        lowStockDefault: Number(values.low_stock_default ?? 10),
        overdueDays: Number(values.overdue_days ?? 30),
        language: values.language || "en"
    };
}

router.get(
    "/",
    asyncHandler(async (req, res) => {
        res.json({ success: true, data: { settings: await loadSettings(pool, req.user.shopId) } });
    })
);

router.put(
    "/",
    requireRole("owner"),
    asyncHandler(async (req, res) => {
        const body = req.body || {};

        // Collect only what was sent. Column names below are fixed by us, never by the user.
        const shopChanges = {};
        const settingChanges = {};

        if (has(body, "shopName")) shopChanges.name = cleanText(body.shopName, "the shop name");
        if (has(body, "address")) shopChanges.address = cleanText(body.address, "the address", { required: false, max: 300 });
        if (has(body, "phone")) shopChanges.phone = cleanText(body.phone, "the phone number", { required: false, max: 30 });
        if (has(body, "tin")) shopChanges.tin = cleanText(body.tin, "the TIN", { required: false, max: 30 });
        if (has(body, "receiptFooter")) {
            shopChanges.receipt_footer = cleanText(body.receiptFooter, "the receipt message", { required: false, max: 300 }) || "";
        }

        if (has(body, "receiptPaper")) {
            if (!PAPER_SIZES.includes(body.receiptPaper)) {
                throw new HttpError(400, "Choose 58mm, 80mm or A4 paper.");
            }
            shopChanges.receipt_paper = body.receiptPaper;
        }

        if (has(body, "allowNegativeStock")) {
            if (typeof body.allowNegativeStock !== "boolean") throw new HttpError(400, "Choose on or off.");
            shopChanges.allow_negative_stock = body.allowNegativeStock;
        }

        if (has(body, "logo")) {
            if (!body.logo) {
                shopChanges.logo = null; // remove the logo
            } else if (
                typeof body.logo !== "string" ||
                !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(body.logo)
            ) {
                throw new HttpError(400, "The logo must be a PNG, JPG or WebP picture.");
            } else if (body.logo.length > MAX_LOGO_LENGTH) {
                throw new HttpError(400, "The logo picture is too big. Choose a smaller one.");
            } else {
                shopChanges.logo = body.logo;
            }
        }

        if (has(body, "lowStockDefault")) {
            settingChanges.low_stock_default = String(
                wholeNumber(body.lowStockDefault, "the low stock level", { min: 0, max: 100000 })
            );
        }
        if (has(body, "overdueDays")) {
            settingChanges.overdue_days = String(
                wholeNumber(body.overdueDays, "the number of days", { min: 1, max: 365 })
            );
        }
        if (has(body, "language")) {
            if (!LANGUAGES.includes(body.language)) throw new HttpError(400, "That language is not available yet.");
            settingChanges.language = body.language;
        }

        const columns = Object.keys(shopChanges);
        const keys = Object.keys(settingChanges);
        if (columns.length === 0 && keys.length === 0) {
            throw new HttpError(400, "There is nothing to save.");
        }

        const saved = await pool.withTransaction(async (client) => {
            if (columns.length > 0) {
                const assignments = columns.map((column, index) => `${column} = $${index + 1}`);
                const values = columns.map((column) => shopChanges[column]);
                values.push(req.user.shopId);
                await client.query(
                    `UPDATE shops SET ${assignments.join(", ")} WHERE id = $${values.length}`,
                    values
                );
            }

            for (const key of keys) {
                await client.query(
                    `INSERT INTO settings (shop_id, key, value) VALUES ($1, $2, $3)
                     ON CONFLICT (shop_id, key) DO UPDATE SET value = EXCLUDED.value`,
                    [req.user.shopId, key, settingChanges[key]]
                );
            }

            await logAudit(client, {
                shopId: req.user.shopId,
                userId: req.user.id,
                action: "settings.update",
                entityType: "shop",
                entityId: req.user.shopId,
                details: { changed: [...columns, ...keys].filter((name) => name !== "logo") },
                ip: req.ip
            });

            return loadSettings(client, req.user.shopId);
        });

        res.json({ success: true, message: "Settings saved.", data: { settings: saved } });
    })
);

module.exports = router;
