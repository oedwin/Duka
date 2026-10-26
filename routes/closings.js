// routes/closings.js - end-of-day cash count: the cash that SHOULD be in the drawer vs the cash counted.
//   GET  /api/closings/preview?date=   everything that moved in cash that day, and the expected total
//   POST /api/closings                 save the count (owner or cashier; the owner may correct a closed day)
//   GET  /api/closings                 history, newest first (owner)
//
// Expected cash = cash at the start (what was counted at the last closing)
//   + cash received (sales and debt repayments) - cash handed back (cancelled payments, return refunds)
//   - cash spent (expenses, supplier payments, goods bought and paid on the spot).
// Mobile money and bank money never count here: it is not in the drawer.
const express = require("express");

const pool = require("../db");
const HttpError = require("../utils/httpError");
const asyncHandler = require("../utils/asyncHandler");
const { cleanDate } = require("../utils/productInput");
const { expectedCash, parseClosing } = require("../utils/expenseInput");
const { todayInShop, dayRange } = require("../utils/time");
const { logAudit } = require("../utils/audit");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

async function cashParts(db, shopId, date) {
    const p = [shopId, date];
    const day = (column) => dayRange(column, "$2", "$2");
    const one = async (sql) => (await db.query(sql, p)).rows[0];

    const received = await one(
        `SELECT COALESCE(SUM(amount) FILTER (WHERE kind = 'sale_payment'), 0)::bigint AS sale_cash,
                COALESCE(SUM(amount) FILTER (WHERE kind = 'debt_payment'), 0)::bigint AS debt_cash
         FROM payments WHERE shop_id = $1 AND method = 'cash' AND ${day("paid_at")}`
    );
    // A payment cancelled today means the cash went back out today (even if it came in earlier).
    const cancelled = await one(
        `SELECT COALESCE(SUM(amount), 0)::bigint AS n FROM payments
         WHERE shop_id = $1 AND method = 'cash' AND voided_at IS NOT NULL AND ${day("voided_at")}`
    );
    const refunds = await one(
        `SELECT COALESCE(SUM(refund_amount), 0)::bigint AS n FROM sale_returns
         WHERE shop_id = $1 AND refund_method = 'cash' AND ${day("created_at")}`
    );
    const expenses = await one(
        `SELECT COALESCE(SUM(amount), 0)::bigint AS n FROM expenses
         WHERE shop_id = $1 AND payment_method = 'cash' AND voided_at IS NULL AND expense_date = $2::date`
    );
    const suppliers = await one(
        `SELECT COALESCE(SUM(amount), 0)::bigint AS n FROM supplier_payments
         WHERE shop_id = $1 AND method = 'cash' AND voided_at IS NULL AND ${day("paid_at")}`
    );
    const purchases = await one(
        `SELECT COALESCE(SUM(amount_paid), 0)::bigint AS n FROM purchases
         WHERE shop_id = $1 AND supplier_id IS NULL AND status = 'completed'
           AND COALESCE(payment_method, 'cash') = 'cash' AND ${day("created_at")}`
    );
    const opening = await one(
        `SELECT counted_cash FROM day_closings WHERE shop_id = $1 AND closing_date < $2::date
         ORDER BY closing_date DESC LIMIT 1`
    );

    const parts = {
        opening: opening ? opening.counted_cash : 0,
        saleCash: received.sale_cash, debtCash: received.debt_cash,
        cancelledCash: cancelled.n, refundCash: refunds.n,
        expenseCash: expenses.n, supplierCash: suppliers.n, purchaseCash: purchases.n
    };
    return { parts, expected: expectedCash(parts) };
}

function toClosing(row) {
    return row ? {
        id: row.id, date: row.closing_date, expectedCash: row.expected_cash, countedCash: row.counted_cash,
        difference: row.difference, note: row.note, closedBy: row.by_name || null, closedAt: row.updated_at
    } : null;
}

async function findClosing(db, shopId, date) {
    return (await db.query(
        `SELECT d.*, u.full_name AS by_name FROM day_closings d LEFT JOIN users u ON u.id = d.closed_by
         WHERE d.shop_id = $1 AND d.closing_date = $2::date`,
        [shopId, date]
    )).rows[0];
}

router.get(
    "/preview",
    asyncHandler(async (req, res) => {
        const today = todayInShop();
        const date = cleanDate(req.query.date, "the date") || today;
        if (date > today) throw new HttpError(400, "That day has not happened yet.");
        const { parts, expected } = await cashParts(pool, req.user.shopId, date);
        res.json({
            success: true,
            data: { date, today, parts, expected, existing: toClosing(await findClosing(pool, req.user.shopId, date)) }
        });
    })
);

router.post(
    "/",
    asyncHandler(async (req, res) => {
        const shopId = req.user.shopId;
        const input = parseClosing(req.body, todayInShop());

        const saved = await pool.withTransaction(async (client) => {
            const { expected } = await cashParts(client, shopId, input.date);
            const difference = input.countedCash - expected;

            const inserted = await client.query(
                `INSERT INTO day_closings (shop_id, closing_date, expected_cash, counted_cash, difference, note, closed_by)
                 VALUES ($1, $2::date, $3, $4, $5, $6, $7)
                 ON CONFLICT (shop_id, closing_date) DO NOTHING RETURNING id`,
                [shopId, input.date, expected, input.countedCash, difference, input.note, req.user.id]
            );
            let corrected = false;
            if (inserted.rowCount === 0) {
                if (req.user.role !== "owner") {
                    throw new HttpError(409, "This day is already closed. Ask the owner if it needs to be corrected.");
                }
                await client.query(
                    `UPDATE day_closings SET expected_cash = $1, counted_cash = $2, difference = $3, note = $4, closed_by = $5
                     WHERE shop_id = $6 AND closing_date = $7::date`,
                    [expected, input.countedCash, difference, input.note, req.user.id, shopId, input.date]
                );
                corrected = true;
            }
            await logAudit(client, {
                shopId, userId: req.user.id, action: corrected ? "closing.correct" : "closing.create",
                entityType: "shop", entityId: shopId,
                details: { date: input.date, expected, counted: input.countedCash, difference }, ip: req.ip
            });
            return { expected, difference, corrected };
        });

        res.status(saved.corrected ? 200 : 201).json({
            success: true,
            message: saved.corrected ? "The closing was corrected." : "The day is closed.",
            data: { ...saved, closing: toClosing(await findClosing(pool, shopId, input.date)) }
        });
    })
);

router.get(
    "/",
    requireRole("owner"),
    asyncHandler(async (req, res) => {
        const { rows } = await pool.query(
            `SELECT d.*, u.full_name AS by_name FROM day_closings d LEFT JOIN users u ON u.id = d.closed_by
             WHERE d.shop_id = $1 ORDER BY d.closing_date DESC LIMIT 60`,
            [req.user.shopId]
        );
        res.json({ success: true, data: { closings: rows.map(toClosing) } });
    })
);

module.exports = router;
