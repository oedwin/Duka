// routes/purchases.js - stock bought from suppliers (owner only).
//   GET  /api/purchases            list with totals (bought, paid, still owed)
//   GET  /api/purchases/:id        one purchase with items and payments
//   POST /api/purchases            record stock received (cash, part-paid or on credit)
//   POST /api/purchases/:id/void   cancel a purchase made by mistake
//
// Recording a purchase is ONE database transaction: stock goes up, the history is written,
// the supplier's balance changes and the payment is saved, together or not at all.
// Each purchase carries a unique id from the browser, so a repeat can never add stock twice.
const express = require("express");

const pool = require("../db");
const HttpError = require("../utils/httpError");
const asyncHandler = require("../utils/asyncHandler");
const { cleanText, parseId } = require("../utils/validators");
const { cleanDate, escapeLike } = require("../utils/productInput");
const { INITIAL_PAYMENT_NOTE, parsePurchaseInput, buildPurchaseLines } = require("../utils/purchaseInput");
const { friendlyStock } = require("../utils/units");
const { ugx } = require("../utils/money");
const { SHOP_TZ } = require("../utils/time");
const { logAudit } = require("../utils/audit");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireRole("owner"));

const PURCHASE_CONSTRAINT = "purchases_shop_id_client_uuid_key";
const TODAY = `(NOW() AT TIME ZONE '${SHOP_TZ}')::date`;

// ---------------------------------------------------------------------
async function loadPurchase(db, shopId, id) {
    const row = (await db.query(
        `SELECT p.*, s.name AS supplier_name, s.phone AS supplier_phone, u.full_name AS by_name
         FROM purchases p
         LEFT JOIN suppliers s ON s.id = p.supplier_id
         LEFT JOIN users u ON u.id = p.created_by
         WHERE p.id = $1 AND p.shop_id = $2`,
        [id, shopId]
    )).rows[0];
    if (!row) return null;

    const items = (await db.query(
        `SELECT pi.id, pi.product_id, pr.name AS product_name, pi.unit_name, pi.quantity, pi.factor_to_base,
                pi.quantity_base, pi.unit_cost, pi.line_total
         FROM purchase_items pi JOIN products pr ON pr.id = pi.product_id
         WHERE pi.purchase_id = $1 ORDER BY pi.id`,
        [id]
    )).rows;

    const payments = (await db.query(
        `SELECT id, amount, method, reference, note, paid_at, voided_at, void_reason
         FROM supplier_payments WHERE purchase_id = $1 ORDER BY id`,
        [id]
    )).rows;

    return {
        id: row.id, reference: row.reference_no, date: row.purchase_date, status: row.status, note: row.note,
        supplier: row.supplier_id ? { id: row.supplier_id, name: row.supplier_name, phone: row.supplier_phone } : null,
        total: row.total_cost, paid: row.amount_paid, balanceDue: row.balance_due,
        voidReason: row.void_reason, by: row.by_name, createdAt: row.created_at,
        items: items.map((i) => ({
            id: i.id, productId: i.product_id, productName: i.product_name, unitName: i.unit_name,
            quantity: i.quantity, quantityBase: i.quantity_base, unitCost: i.unit_cost, lineTotal: i.line_total
        })),
        payments: payments.map((p) => ({
            id: p.id, amount: p.amount, method: p.method, reference: p.reference, note: p.note, paidAt: p.paid_at,
            voided: p.voided_at !== null, voidReason: p.void_reason, atPurchase: p.note === INITIAL_PAYMENT_NOTE
        }))
    };
}

// ---------------------------------------------------------------------
// List (default: the last 30 days)
// ---------------------------------------------------------------------
router.get(
    "/",
    asyncHandler(async (req, res) => {
        const params = [req.user.shopId];
        const add = (value) => { params.push(value); return `$${params.length}`; };
        const where = ["p.shop_id = $1"];

        const from = add(cleanDate(req.query.from, "the start date"));
        const to = add(cleanDate(req.query.to, "the end date"));
        where.push(`p.purchase_date >= COALESCE(${from}::date, ${TODAY} - 29)`);
        where.push(`p.purchase_date <= COALESCE(${to}::date, ${TODAY})`);

        const status = req.query.status || "completed";
        if (status === "completed" || status === "voided") where.push(`p.status = ${add(status)}`);
        else if (status !== "all") throw new HttpError(400, "Unknown status.");

        if (req.query.supplierId) where.push(`p.supplier_id = ${add(parseId(req.query.supplierId))}`);
        const search = String(req.query.search || "").trim().slice(0, 60);
        if (search) {
            const like = add(`%${escapeLike(search)}%`);
            where.push(`(p.reference_no ILIKE ${like} OR s.name ILIKE ${like})`);
        }

        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const whereSql = where.join(" AND ");
        const fromSql = "FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id";

        const totals = (await pool.query(
            `SELECT COUNT(*) FILTER (WHERE p.status = 'completed') AS purchases,
                    COALESCE(SUM(p.total_cost) FILTER (WHERE p.status = 'completed'), 0)::bigint AS total,
                    COALESCE(SUM(p.amount_paid) FILTER (WHERE p.status = 'completed'), 0)::bigint AS paid,
                    COALESCE(SUM(p.balance_due) FILTER (WHERE p.status = 'completed'), 0)::bigint AS owed,
                    COUNT(*) AS row_count
             ${fromSql} WHERE ${whereSql}`,
            params
        )).rows[0];

        const limitParam = add(limit);
        const offsetParam = add((page - 1) * limit);
        const { rows } = await pool.query(
            `SELECT p.id, p.purchase_date, p.reference_no, p.total_cost, p.amount_paid, p.balance_due, p.status,
                    s.name AS supplier_name,
                    (SELECT COUNT(*) FROM purchase_items pi WHERE pi.purchase_id = p.id) AS item_count
             ${fromSql} WHERE ${whereSql}
             ORDER BY p.purchase_date DESC, p.id DESC
             LIMIT ${limitParam} OFFSET ${offsetParam}`,
            params
        );

        res.json({
            success: true,
            data: {
                purchases: rows.map((r) => ({
                    id: r.id, date: r.purchase_date, reference: r.reference_no, total: r.total_cost,
                    paid: r.amount_paid, balanceDue: r.balance_due, status: r.status,
                    supplierName: r.supplier_name, itemCount: r.item_count
                })),
                totals: { purchases: totals.purchases, total: totals.total, paid: totals.paid, owed: totals.owed },
                page, limit, total: totals.row_count, hasMore: page * limit < totals.row_count
            }
        });
    })
);

router.get(
    "/:id",
    asyncHandler(async (req, res) => {
        const purchase = await loadPurchase(pool, req.user.shopId, parseId(req.params.id));
        if (!purchase) throw new HttpError(404, "That purchase could not be found.");
        res.json({ success: true, data: { purchase } });
    })
);

// ---------------------------------------------------------------------
// Record a purchase
// ---------------------------------------------------------------------
async function writePurchase(client, user, input, ip) {
    const shopId = user.shopId;

    let supplier = null;
    if (input.supplierId) {
        supplier = (await client.query(
            "SELECT id, name, balance FROM suppliers WHERE id = $1 AND shop_id = $2 AND is_active FOR UPDATE",
            [input.supplierId, shopId]
        )).rows[0];
        if (!supplier) throw new HttpError(400, "That supplier could not be found.");
    }

    // Products are locked in id order, so two people recording stock can never deadlock.
    const productIds = [...new Set(input.items.map((i) => i.productId))].sort((a, b) => a - b);
    const productRows = (await client.query(
        `SELECT id, name, cost_price, stock_base FROM products
         WHERE id = ANY($1::bigint[]) AND shop_id = $2 AND is_active ORDER BY id FOR UPDATE`,
        [productIds, shopId]
    )).rows;
    const products = new Map(productRows.map((p) => [p.id, p]));

    const unitRows = (await client.query(
        "SELECT id, product_id, name, factor_to_base FROM product_units WHERE product_id = ANY($1::bigint[])",
        [productIds]
    )).rows;
    const units = new Map(unitRows.map((u) => [u.id, u]));

    const { lines, total, needBase } = buildPurchaseLines(input.items, products, units);

    const paid = input.payment ? input.payment.amount : 0;
    if (paid > total) throw new HttpError(400, `You paid ${ugx(paid)}, which is more than the total of ${ugx(total)}.`);
    const balanceDue = total - paid;
    if (balanceDue > 0 && !supplier) {
        throw new HttpError(400, "Choose a supplier to buy on credit, or pay the full amount.", { code: "NEEDS_SUPPLIER" });
    }

    const purchase = await client.query(
        `INSERT INTO purchases (shop_id, client_uuid, supplier_id, reference_no, purchase_date, total_cost,
                                amount_paid, balance_due, note, created_by, payment_method)
         VALUES ($1, $2, $3, $4, COALESCE($5::date, ${TODAY}), $6, $7, $8, $9, $10, $11) RETURNING id`,
        [shopId, input.clientUuid, input.supplierId, input.referenceNo, input.purchaseDate, total,
         paid, balanceDue, input.note, user.id, input.payment ? input.payment.method : null]
    );
    const purchaseId = purchase.rows[0].id;

    for (const line of lines) {
        await client.query(
            `INSERT INTO purchase_items (purchase_id, product_id, unit_id, unit_name, quantity, factor_to_base,
                                         quantity_base, unit_cost, line_total)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [purchaseId, line.productId, line.unitId, line.unit.name, line.quantity, line.unit.factor_to_base,
             line.quantityBase, line.unitCost, line.lineTotal]
        );
    }

    // Stock in, with a history line per product.
    for (const [productId, qty] of needBase) {
        const updated = await client.query(
            "UPDATE products SET stock_base = stock_base + $1 WHERE id = $2 AND shop_id = $3 RETURNING stock_base",
            [qty, productId, shopId]
        );
        await client.query(
            `INSERT INTO stock_movements (shop_id, product_id, movement_type, quantity_change, stock_after,
                                          ref_type, ref_id, note, created_by)
             VALUES ($1, $2, 'purchase', $3, $4, 'purchase', $5, $6, $7)`,
            [shopId, productId, qty, updated.rows[0].stock_base, purchaseId,
             "Stock received" + (supplier ? " from " + supplier.name : "") + (input.referenceNo ? ` (${input.referenceNo})` : ""),
             user.id]
        );
    }

    // New cost price, only where the person ticked "update cost price". The last tick for a product wins.
    const newCost = new Map();
    for (const line of lines) if (line.updateCost) newCost.set(line.productId, line.costPerBase);
    for (const [productId, cost] of newCost) {
        if (cost === products.get(productId).cost_price) continue;
        await client.query("UPDATE products SET cost_price = $1 WHERE id = $2 AND shop_id = $3", [cost, productId, shopId]);
        await client.query(
            "INSERT INTO product_cost_history (product_id, cost_price, purchase_id) VALUES ($1, $2, $3)",
            [productId, cost, purchaseId]
        );
    }

    if (supplier && balanceDue > 0) {
        await client.query("UPDATE suppliers SET balance = balance + $1 WHERE id = $2", [balanceDue, supplier.id]);
    }

    // The money paid at the counter. (A cash purchase with no named supplier keeps its payment on the purchase itself.)
    if (paid > 0 && supplier) {
        await client.query(
            `INSERT INTO supplier_payments (shop_id, client_uuid, supplier_id, purchase_id, amount, method,
                                            reference, note, paid_by)
             VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, $8)`,
            [shopId, supplier.id, purchaseId, paid, input.payment.method, input.payment.reference,
             INITIAL_PAYMENT_NOTE, user.id]
        );
    }

    await logAudit(client, {
        shopId, userId: user.id, action: "purchase.create", entityType: "purchase", entityId: purchaseId,
        details: { total, paid, balanceDue, lines: lines.length, supplierId: input.supplierId }, ip
    });
    return purchaseId;
}

router.post(
    "/",
    asyncHandler(async (req, res) => {
        const input = parsePurchaseInput(req.body);
        const shopId = req.user.shopId;
        const find = async () => (await pool.query(
            "SELECT id FROM purchases WHERE shop_id = $1 AND client_uuid = $2", [shopId, input.clientUuid]
        )).rows[0];

        let id;
        let duplicate = false;
        const existing = await find();
        if (existing) {
            id = existing.id;
            duplicate = true;
        } else {
            try {
                id = await pool.withTransaction((client) => writePurchase(client, req.user, input, req.ip));
            } catch (error) {
                if (error.code === "23505" && error.constraint === PURCHASE_CONSTRAINT) {
                    const again = await find();
                    if (!again) throw error;
                    id = again.id;
                    duplicate = true;
                } else {
                    throw error;
                }
            }
        }
        res.status(duplicate ? 200 : 201).json({
            success: true,
            message: duplicate ? "This purchase was already saved." : "Purchase saved. Stock has been added.",
            data: { purchase: await loadPurchase(pool, shopId, id), duplicate }
        });
    })
);

// ---------------------------------------------------------------------
// Void a purchase made by mistake. Stock comes back out, the debt to the supplier is removed.
// Nothing is deleted; the purchase stays in the list marked cancelled.
// ---------------------------------------------------------------------
router.post(
    "/:id/void",
    asyncHandler(async (req, res) => {
        const shopId = req.user.shopId;
        const id = parseId(req.params.id);
        const reason = cleanText(req.body.reason, "the reason for cancelling this purchase", { max: 300 });
        let refundDue = 0;

        await pool.withTransaction(async (client) => {
            const purchase = (await client.query(
                "SELECT * FROM purchases WHERE id = $1 AND shop_id = $2 FOR UPDATE", [id, shopId]
            )).rows[0];
            if (!purchase) throw new HttpError(404, "That purchase could not be found.");
            if (purchase.status === "voided") throw new HttpError(409, "This purchase was already cancelled.");

            const later = await client.query(
                `SELECT 1 FROM supplier_payments
                 WHERE purchase_id = $1 AND voided_at IS NULL AND note IS DISTINCT FROM $2 LIMIT 1`,
                [id, INITIAL_PAYMENT_NOTE]
            );
            if (later.rowCount > 0) {
                throw new HttpError(409, "Payments were made on this purchase after it was recorded. Cancel those payments first.");
            }

            let supplier = null;
            if (purchase.supplier_id) {
                supplier = (await client.query(
                    "SELECT id, balance FROM suppliers WHERE id = $1 FOR UPDATE", [purchase.supplier_id]
                )).rows[0];
            }

            const back = (await client.query(
                `SELECT product_id, SUM(quantity_base)::bigint AS qty FROM purchase_items
                 WHERE purchase_id = $1 GROUP BY product_id ORDER BY product_id`,
                [id]
            )).rows;
            const shop = (await client.query("SELECT allow_negative_stock FROM shops WHERE id = $1", [shopId])).rows[0];

            if (back.length > 0) {
                const rows = (await client.query(
                    `SELECT id, name, stock_base FROM products WHERE id = ANY($1::bigint[]) AND shop_id = $2 ORDER BY id FOR UPDATE`,
                    [back.map((b) => b.product_id), shopId]
                )).rows;
                const stock = new Map(rows.map((p) => [p.id, p]));
                for (const item of back) {
                    const product = stock.get(item.product_id);
                    if (product.stock_base < item.qty && !shop.allow_negative_stock) {
                        const units = (await client.query(
                            "SELECT name, factor_to_base AS factor FROM product_units WHERE product_id = $1", [item.product_id]
                        )).rows;
                        throw new HttpError(409,
                            `Some of this stock has already been sold: "${product.name}" has only ${friendlyStock(Math.max(product.stock_base, 0), units)} left, so the purchase cannot be cancelled.`);
                    }
                }
                for (const item of back) {
                    const updated = await client.query(
                        "UPDATE products SET stock_base = stock_base - $1 WHERE id = $2 AND shop_id = $3 RETURNING stock_base",
                        [item.qty, item.product_id, shopId]
                    );
                    await client.query(
                        `INSERT INTO stock_movements (shop_id, product_id, movement_type, quantity_change, stock_after,
                                                      ref_type, ref_id, note, created_by)
                         VALUES ($1, $2, 'purchase_void', $3, $4, 'purchase', $5, $6, $7)`,
                        [shopId, item.product_id, -item.qty, updated.rows[0].stock_base, id,
                         "Purchase cancelled" + (purchase.reference_no ? ` (${purchase.reference_no})` : ""), req.user.id]
                    );
                }
            }

            if (supplier && purchase.balance_due > 0) {
                await client.query("UPDATE suppliers SET balance = balance - $1 WHERE id = $2", [purchase.balance_due, supplier.id]);
            }
            await client.query(
                "UPDATE supplier_payments SET voided_at = NOW(), void_reason = 'Purchase cancelled' WHERE purchase_id = $1 AND voided_at IS NULL",
                [id]
            );
            await client.query("UPDATE purchases SET status = 'voided', void_reason = $1 WHERE id = $2", [reason, id]);

            refundDue = purchase.amount_paid; // money already paid that the supplier should give back
            await logAudit(client, {
                shopId, userId: req.user.id, action: "purchase.void", entityType: "purchase", entityId: id,
                details: { total: purchase.total_cost, paid: purchase.amount_paid, reason }, ip: req.ip
            });
        });

        res.json({
            success: true,
            message: refundDue > 0
                ? `Purchase cancelled. You had paid ${ugx(refundDue)}: ask the supplier to give it back.`
                : "Purchase cancelled. The stock has been taken off.",
            data: { purchase: await loadPurchase(pool, shopId, id), refundDue }
        });
    })
);

module.exports = router;
