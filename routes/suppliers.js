// routes/suppliers.js - suppliers, what we owe them, and paying them (owner only).
//   GET   /api/suppliers                              list + total owed
//   POST  /api/suppliers                              add (optionally with money already owed)
//   GET   /api/suppliers/:id                          profile with purchases and payments
//   PATCH /api/suppliers/:id                          change details, switch off
//   POST  /api/suppliers/:id/payments                 pay a supplier (part or all)
//   POST  /api/suppliers/:id/payments/:pid/void       cancel a wrong payment
//
// suppliers.balance (what we owe) always equals the unpaid part of that supplier's
// purchases. Every payment is spread over the oldest unpaid purchases first.
const express = require("express");

const pool = require("../db");
const HttpError = require("../utils/httpError");
const asyncHandler = require("../utils/asyncHandler");
const { normalizePhone, formatPhone } = require("../utils/phone");
const { cleanText, wholeNumber, parseId, has } = require("../utils/validators");
const { MAX_MONEY, escapeLike } = require("../utils/productInput");
const { INITIAL_PAYMENT_NOTE, allocateOldestFirst, parseSupplierPayment } = require("../utils/purchaseInput");
const { derivedUuid } = require("../utils/ids");
const { ugx } = require("../utils/money");
const { SHOP_TZ } = require("../utils/time");
const { logAudit } = require("../utils/audit");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireRole("owner"));

const COLUMNS = "id, name, phone, products_supplied, notes, balance, is_active";

function toSupplier(row) {
    return {
        id: row.id, name: row.name, phone: row.phone, phoneDisplay: formatPhone(row.phone),
        productsSupplied: row.products_supplied, notes: row.notes,
        balance: row.balance, // what we owe them
        isActive: row.is_active
    };
}

function cleanPhoneOptional(value) {
    if (value === undefined || value === null || String(value).trim() === "") return null;
    const phone = normalizePhone(value);
    if (!phone) throw new HttpError(400, "Enter a valid phone number, like 0772 123 456, or leave it empty.");
    return phone;
}

async function assertNameFree(db, shopId, name, exceptId) {
    const { rowCount } = await db.query(
        `SELECT 1 FROM suppliers WHERE shop_id = $1 AND LOWER(name) = LOWER($2) AND ($3::bigint IS NULL OR id <> $3)`,
        [shopId, name, exceptId || null]
    );
    if (rowCount > 0) throw new HttpError(409, `You already have a supplier called "${name}".`);
}

// ---------------------------------------------------------------------
router.get(
    "/",
    asyncHandler(async (req, res) => {
        const params = [req.user.shopId];
        let where = "shop_id = $1";
        if ((req.query.status || "active") === "active") where += " AND is_active";
        const search = String(req.query.search || "").trim().slice(0, 80);
        if (search) { params.push(`%${escapeLike(search)}%`); where += ` AND name ILIKE $2`; }

        const { rows } = await pool.query(
            `SELECT ${COLUMNS} FROM suppliers WHERE ${where} ORDER BY balance DESC, LOWER(name)`, params
        );
        const owed = (await pool.query(
            "SELECT COALESCE(SUM(balance), 0)::bigint AS total FROM suppliers WHERE shop_id = $1", [req.user.shopId]
        )).rows[0].total;

        res.json({ success: true, data: { suppliers: rows.map(toSupplier), totalOwed: owed } });
    })
);

// ---------------------------------------------------------------------
router.post(
    "/",
    asyncHandler(async (req, res) => {
        const shopId = req.user.shopId;
        const name = cleanText(req.body.name, "the supplier's name");
        const phone = cleanPhoneOptional(req.body.phone);
        const productsSupplied = cleanText(req.body.productsSupplied, "the products supplied", { required: false, max: 300 });
        const notes = cleanText(req.body.notes, "the notes", { required: false, max: 500 });
        const opening = has(req.body, "openingBalance") && req.body.openingBalance !== "" && req.body.openingBalance !== null
            ? wholeNumber(req.body.openingBalance, "the money already owed", { min: 0, max: MAX_MONEY }) : 0;
        await assertNameFree(pool, shopId, name);

        const supplier = await pool.withTransaction(async (client) => {
            const created = await client.query(
                `INSERT INTO suppliers (shop_id, name, phone, products_supplied, notes, balance)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
                [shopId, name, phone, productsSupplied, notes, opening]
            );
            if (opening > 0) {
                // Money owed from before Duka is kept as a purchase with no items, so the books stay consistent.
                await client.query(
                    `INSERT INTO purchases (shop_id, client_uuid, supplier_id, reference_no, purchase_date,
                                            total_cost, amount_paid, balance_due, note, created_by)
                     VALUES ($1, gen_random_uuid(), $2, 'OPENING', (NOW() AT TIME ZONE '${SHOP_TZ}')::date,
                             $3, 0, $3, 'Balance brought forward', $4)`,
                    [shopId, created.rows[0].id, opening, req.user.id]
                );
            }
            await logAudit(client, {
                shopId, userId: req.user.id, action: "supplier.create", entityType: "supplier",
                entityId: created.rows[0].id, details: { opening }, ip: req.ip
            });
            return created.rows[0];
        });
        res.status(201).json({ success: true, message: "Supplier added.", data: { supplier: toSupplier(supplier) } });
    })
);

// ---------------------------------------------------------------------
router.get(
    "/:id",
    asyncHandler(async (req, res) => {
        const shopId = req.user.shopId;
        const id = parseId(req.params.id);
        const supplier = (await pool.query(`SELECT ${COLUMNS} FROM suppliers WHERE id = $1 AND shop_id = $2`, [id, shopId])).rows[0];
        if (!supplier) throw new HttpError(404, "That supplier could not be found.");

        const purchases = (await pool.query(
            `SELECT id, purchase_date, reference_no, total_cost, amount_paid, balance_due, status, note
             FROM purchases WHERE supplier_id = $1 AND shop_id = $2
             ORDER BY purchase_date DESC, id DESC LIMIT 100`,
            [id, shopId]
        )).rows;

        const payments = (await pool.query(
            `SELECT sp.id, sp.amount, sp.method, sp.reference, sp.note, sp.paid_at, sp.purchase_id,
                    sp.voided_at, sp.void_reason, p.reference_no AS purchase_reference, p.purchase_date,
                    u.full_name AS by_name
             FROM supplier_payments sp
             LEFT JOIN purchases p ON p.id = sp.purchase_id
             LEFT JOIN users u ON u.id = sp.paid_by
             WHERE sp.supplier_id = $1 AND sp.shop_id = $2
             ORDER BY sp.paid_at DESC, sp.id DESC LIMIT 100`,
            [id, shopId]
        )).rows;

        res.json({
            success: true,
            data: {
                supplier: toSupplier(supplier),
                purchases: purchases.map((p) => ({
                    id: p.id, date: p.purchase_date, reference: p.reference_no, total: p.total_cost,
                    paid: p.amount_paid, balanceDue: p.balance_due, status: p.status, note: p.note
                })),
                payments: payments.map((p) => ({
                    id: p.id, amount: p.amount, method: p.method, reference: p.reference, note: p.note,
                    paidAt: p.paid_at, purchaseId: p.purchase_id, purchaseReference: p.purchase_reference,
                    purchaseDate: p.purchase_date, by: p.by_name,
                    voided: p.voided_at !== null, voidReason: p.void_reason,
                    atPurchase: p.note === INITIAL_PAYMENT_NOTE
                }))
            }
        });
    })
);

// ---------------------------------------------------------------------
router.patch(
    "/:id",
    asyncHandler(async (req, res) => {
        const shopId = req.user.shopId;
        const id = parseId(req.params.id);
        const body = req.body || {};

        const existing = (await pool.query("SELECT id, balance, name FROM suppliers WHERE id = $1 AND shop_id = $2", [id, shopId])).rows[0];
        if (!existing) throw new HttpError(404, "That supplier could not be found.");

        const changes = {};
        if (has(body, "name")) {
            changes.name = cleanText(body.name, "the supplier's name");
            await assertNameFree(pool, shopId, changes.name, id);
        }
        if (has(body, "phone")) changes.phone = cleanPhoneOptional(body.phone);
        if (has(body, "productsSupplied")) changes.products_supplied = cleanText(body.productsSupplied, "the products supplied", { required: false, max: 300 });
        if (has(body, "notes")) changes.notes = cleanText(body.notes, "the notes", { required: false, max: 500 });
        if (has(body, "isActive")) {
            if (typeof body.isActive !== "boolean") throw new HttpError(400, "Choose on or off.");
            if (!body.isActive && existing.balance !== 0) {
                throw new HttpError(409, `You still owe ${existing.name} ${ugx(existing.balance)}. Pay it before switching them off.`);
            }
            changes.is_active = body.isActive;
        }

        const columns = Object.keys(changes);
        if (columns.length === 0) throw new HttpError(400, "There is nothing to save.");
        const assignments = columns.map((c, i) => `${c} = $${i + 1}`);
        const values = columns.map((c) => changes[c]);
        values.push(id, shopId);
        const { rows } = await pool.query(
            `UPDATE suppliers SET ${assignments.join(", ")} WHERE id = $${values.length - 1} AND shop_id = $${values.length}
             RETURNING ${COLUMNS}`,
            values
        );
        await logAudit(pool, {
            shopId, userId: req.user.id, action: "supplier.update", entityType: "supplier", entityId: id,
            details: { changed: columns }, ip: req.ip
        });
        res.json({ success: true, message: "Saved.", data: { supplier: toSupplier(rows[0]) } });
    })
);

// ---------------------------------------------------------------------
// Pay a supplier. The money is applied to their oldest unpaid purchases first
// (or to one chosen purchase).
// ---------------------------------------------------------------------
router.post(
    "/:id/payments",
    asyncHandler(async (req, res) => {
        const shopId = req.user.shopId;
        const id = parseId(req.params.id);
        const input = parseSupplierPayment(req.body);

        const result = await pool.withTransaction(async (client) => {
            const supplier = (await client.query(
                "SELECT id, name, balance FROM suppliers WHERE id = $1 AND shop_id = $2 FOR UPDATE", [id, shopId]
            )).rows[0];
            if (!supplier) throw new HttpError(404, "That supplier could not be found.");

            // The first row of a payment uses the browser's own id, so a repeat is easy to spot.
            const seen = await client.query(
                "SELECT 1 FROM supplier_payments WHERE shop_id = $1 AND client_uuid = $2", [shopId, input.clientUuid]
            );
            if (seen.rowCount > 0) return { duplicate: true, balance: supplier.balance };

            if (input.amount > supplier.balance) {
                throw new HttpError(400, `You only owe ${supplier.name} ${ugx(supplier.balance)}.`);
            }

            let open;
            if (input.purchaseId) {
                open = (await client.query(
                    `SELECT id, balance_due FROM purchases
                     WHERE id = $1 AND supplier_id = $2 AND shop_id = $3 AND status = 'completed' FOR UPDATE`,
                    [input.purchaseId, id, shopId]
                )).rows;
                if (open.length === 0) throw new HttpError(404, "That purchase could not be found.");
                if (input.amount > open[0].balance_due) {
                    throw new HttpError(400, `Only ${ugx(open[0].balance_due)} is still owed on that purchase.`);
                }
            } else {
                open = (await client.query(
                    `SELECT id, balance_due FROM purchases
                     WHERE supplier_id = $1 AND shop_id = $2 AND status = 'completed' AND balance_due > 0
                     ORDER BY purchase_date, id FOR UPDATE`,
                    [id, shopId]
                )).rows;
            }

            const parts = allocateOldestFirst(open, input.amount);
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                await client.query(
                    `UPDATE purchases SET amount_paid = amount_paid + $1, balance_due = balance_due - $1 WHERE id = $2`,
                    [part.amount, part.purchaseId]
                );
                await client.query(
                    `INSERT INTO supplier_payments (shop_id, client_uuid, supplier_id, purchase_id, amount, method,
                                                    reference, note, paid_by)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                    [shopId, i === 0 ? input.clientUuid : derivedUuid(input.clientUuid, part.purchaseId), id,
                     part.purchaseId, part.amount, input.method, input.reference, input.note, req.user.id]
                );
            }

            const newBalance = supplier.balance - input.amount;
            await client.query("UPDATE suppliers SET balance = $1 WHERE id = $2", [newBalance, id]);
            await logAudit(client, {
                shopId, userId: req.user.id, action: "supplier.pay", entityType: "supplier", entityId: id,
                details: { amount: input.amount, method: input.method, purchases: parts.length }, ip: req.ip
            });
            return { duplicate: false, balance: newBalance };
        });

        res.json({
            success: true,
            message: result.duplicate ? "This payment was already saved." : "Payment saved.",
            data: result
        });
    })
);

// ---------------------------------------------------------------------
// Cancel a wrong payment: the debt comes back, the payment stays in the list marked cancelled.
// ---------------------------------------------------------------------
router.post(
    "/:id/payments/:paymentId/void",
    asyncHandler(async (req, res) => {
        const shopId = req.user.shopId;
        const id = parseId(req.params.id);
        const paymentId = parseId(req.params.paymentId);
        const reason = cleanText(req.body.reason, "the reason", { max: 300 });

        const balance = await pool.withTransaction(async (client) => {
            const supplier = (await client.query(
                "SELECT id, balance FROM suppliers WHERE id = $1 AND shop_id = $2 FOR UPDATE", [id, shopId]
            )).rows[0];
            if (!supplier) throw new HttpError(404, "That supplier could not be found.");

            const payment = (await client.query(
                "SELECT * FROM supplier_payments WHERE id = $1 AND supplier_id = $2 AND shop_id = $3 FOR UPDATE",
                [paymentId, id, shopId]
            )).rows[0];
            if (!payment) throw new HttpError(404, "That payment could not be found.");
            if (payment.voided_at) throw new HttpError(409, "This payment was already cancelled.");
            if (payment.note === INITIAL_PAYMENT_NOTE) {
                throw new HttpError(409, "This payment was made when the stock was received. Void the purchase instead.");
            }

            const reopened = await client.query(
                `UPDATE purchases SET amount_paid = amount_paid - $1, balance_due = balance_due + $1
                 WHERE id = $2 AND status = 'completed'`,
                [payment.amount, payment.purchase_id]
            );
            if (reopened.rowCount === 0) throw new HttpError(409, "The purchase this payment belongs to is no longer active.");

            await client.query(
                "UPDATE supplier_payments SET voided_at = NOW(), void_reason = $1 WHERE id = $2", [reason, paymentId]
            );
            const newBalance = supplier.balance + payment.amount;
            await client.query("UPDATE suppliers SET balance = $1 WHERE id = $2", [newBalance, id]);
            await logAudit(client, {
                shopId, userId: req.user.id, action: "supplier.payment_void", entityType: "supplier", entityId: id,
                details: { paymentId, amount: payment.amount, reason }, ip: req.ip
            });
            return newBalance;
        });

        res.json({ success: true, message: "Payment cancelled. The money is owed again.", data: { balance } });
    })
);

module.exports = router;
