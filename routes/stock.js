// routes/stock.js - stock levels, adjustments, stock-taking and the movement log.
//   GET  /api/stock/summary       alerts for everyone; stock value (cost and selling price) for the owner
//   GET  /api/stock/movements     the full log of every change to stock          owner
//   POST /api/stock/adjustments   take out damaged / expired / lost stock, or add found stock   owner
//   POST /api/stock/stock-take    set stock to what was counted on the shelf      owner
//
// Every change to stock leaves a row in stock_movements, with who did it and why.
// Rows are locked while they change and every request carries a unique id, so a repeated
// request (double tap, retry) can never change stock twice.
const express = require("express");

const pool = require("../db");
const HttpError = require("../utils/httpError");
const asyncHandler = require("../utils/asyncHandler");
const { parseId } = require("../utils/validators");
const { cleanDate } = require("../utils/productInput");
const { parseAdjustment, parseStockTake } = require("../utils/stockInput");
const { lowStockDefault, loadUnitsAndPrices } = require("../utils/productData");
const { derivedUuid } = require("../utils/ids");
const { friendlyStock } = require("../utils/units");
const { SHOP_TZ } = require("../utils/time");
const { logAudit } = require("../utils/audit");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

const MOVEMENT_TYPES = ["opening", "purchase", "purchase_void", "sale", "sale_void", "return", "adjustment", "stock_take"];
const REASON_TEXT = { damaged: "Damaged", expired: "Expired", lost: "Lost or stolen", found: "Found extra", other: "Other" };

// ---------------------------------------------------------------------
// Summary: alerts, and what the stock is worth
// ---------------------------------------------------------------------
router.get(
    "/summary",
    asyncHandler(async (req, res) => {
        const shopId = req.user.shopId;
        const lowDefault = await lowStockDefault(pool, shopId);

        const counts = (await pool.query(
            `SELECT COUNT(*) AS products,
                    COUNT(*) FILTER (WHERE stock_base <= 0) AS out_count,
                    COUNT(*) FILTER (WHERE stock_base > 0 AND stock_base <=
                        CASE WHEN reorder_level > 0 THEN reorder_level ELSE $2 END) AS low_count,
                    COUNT(*) FILTER (WHERE expiry_date IS NOT NULL AND expiry_date <= CURRENT_DATE + 30) AS expiring_count
             FROM products WHERE shop_id = $1 AND is_active`,
            [shopId, lowDefault]
        )).rows[0];

        const data = {
            alerts: { low: counts.low_count, out: counts.out_count, expiring: counts.expiring_count },
            products: counts.products
        };

        // Cost and profit figures are for the owner only.
        if (req.user.role === "owner") {
            const byCategory = (await pool.query(
                `SELECT c.name AS category, COUNT(*) AS products,
                        COALESCE(SUM(GREATEST(p.stock_base, 0) * p.cost_price), 0)::bigint AS cost_value,
                        COALESCE(SUM(GREATEST(p.stock_base, 0) * COALESCE(rp.price, 0)), 0)::bigint AS retail_value
                 FROM products p
                 LEFT JOIN categories c ON c.id = p.category_id
                 LEFT JOIN product_units bu ON bu.product_id = p.id AND bu.factor_to_base = 1
                 LEFT JOIN product_prices rp ON rp.unit_id = bu.id AND rp.level = 'retail'
                      AND rp.min_qty = 1 AND rp.customer_id IS NULL
                 WHERE p.shop_id = $1 AND p.is_active
                 GROUP BY c.name
                 ORDER BY LOWER(COALESCE(c.name, 'zzz'))`,
                [shopId]
            )).rows;

            const categories = byCategory.map((r) => ({
                category: r.category || "No category", products: r.products,
                costValue: r.cost_value, retailValue: r.retail_value
            }));
            const costValue = categories.reduce((s, c) => s + c.costValue, 0);
            const retailValue = categories.reduce((s, c) => s + c.retailValue, 0);
            data.value = { costValue, retailValue, expectedProfit: retailValue - costValue, byCategory: categories };
        }

        res.json({ success: true, data });
    })
);

// ---------------------------------------------------------------------
// Movement log
// ---------------------------------------------------------------------
router.get(
    "/movements",
    requireRole("owner"),
    asyncHandler(async (req, res) => {
        const params = [req.user.shopId];
        const add = (value) => { params.push(value); return `$${params.length}`; };
        const where = ["sm.shop_id = $1"];

        if (req.query.productId) where.push(`sm.product_id = ${add(parseId(req.query.productId))}`);
        if (req.query.type) {
            if (!MOVEMENT_TYPES.includes(req.query.type)) throw new HttpError(400, "Unknown movement type.");
            where.push(`sm.movement_type = ${add(req.query.type)}`);
        }

        // Dates are shop days in Kampala. Empty = the last 30 days.
        const from = add(cleanDate(req.query.from, "the start date"));
        const to = add(cleanDate(req.query.to, "the end date"));
        const today = `(NOW() AT TIME ZONE '${SHOP_TZ}')::date`;
        where.push(`sm.created_at >= (COALESCE(${from}::date, ${today} - 29))::timestamp AT TIME ZONE '${SHOP_TZ}'`);
        where.push(`sm.created_at < (COALESCE(${to}::date, ${today}) + 1)::timestamp AT TIME ZONE '${SHOP_TZ}'`);

        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 40));
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const whereSql = where.join(" AND ");

        const total = (await pool.query(`SELECT COUNT(*) AS n FROM stock_movements sm WHERE ${whereSql}`, params)).rows[0].n;
        const limitParam = add(limit);
        const offsetParam = add((page - 1) * limit);
        const { rows } = await pool.query(
            `SELECT sm.id, sm.created_at, sm.product_id, p.name AS product_name, sm.movement_type,
                    sm.quantity_change, sm.stock_after, sm.note, u.full_name AS by_name
             FROM stock_movements sm
             JOIN products p ON p.id = sm.product_id
             LEFT JOIN users u ON u.id = sm.created_by
             WHERE ${whereSql}
             ORDER BY sm.created_at DESC, sm.id DESC
             LIMIT ${limitParam} OFFSET ${offsetParam}`,
            params
        );

        const { units } = await loadUnitsAndPrices(pool, [...new Set(rows.map((r) => r.product_id))]);
        res.json({
            success: true,
            data: {
                movements: rows.map((r) => ({
                    id: r.id, createdAt: r.created_at, productId: r.product_id, productName: r.product_name,
                    type: r.movement_type, change: r.quantity_change, stockAfter: r.stock_after,
                    note: r.note, by: r.by_name, units: units.get(r.product_id) || []
                })),
                page, limit, total, hasMore: page * limit < total
            }
        });
    })
);

// ---------------------------------------------------------------------
// One adjustment: damaged / expired / lost goes out, found stock comes in
// ---------------------------------------------------------------------
router.post(
    "/adjustments",
    requireRole("owner"),
    asyncHandler(async (req, res) => {
        const input = parseAdjustment(req.body);
        const shopId = req.user.shopId;

        const result = await pool.withTransaction(async (client) => {
            // Lock the product first, then look for a repeat of this request.
            const product = (await client.query(
                "SELECT id, name, stock_base FROM products WHERE id = $1 AND shop_id = $2 FOR UPDATE",
                [input.productId, shopId]
            )).rows[0];
            if (!product) throw new HttpError(404, "That product could not be found.");

            const seen = await client.query(
                "SELECT 1 FROM stock_adjustments WHERE shop_id = $1 AND client_uuid = $2", [shopId, input.clientUuid]
            );
            if (seen.rowCount > 0) return { duplicate: true, name: product.name };

            const unit = (await client.query(
                "SELECT name, factor_to_base FROM product_units WHERE id = $1 AND product_id = $2",
                [input.unitId, input.productId]
            )).rows[0];
            if (!unit) throw new HttpError(400, "That unit does not belong to this product.");

            const baseQty = input.quantity * unit.factor_to_base;
            const change = input.direction === "out" ? -baseQty : baseQty;

            const shop = (await client.query("SELECT allow_negative_stock FROM shops WHERE id = $1", [shopId])).rows[0];
            if (product.stock_base + change < 0 && !shop.allow_negative_stock) {
                const units = (await client.query(
                    "SELECT name, factor_to_base AS factor FROM product_units WHERE product_id = $1", [input.productId]
                )).rows;
                throw new HttpError(409,
                    `You only have ${friendlyStock(Math.max(product.stock_base, 0), units)} of "${product.name}", so you cannot take out that much.`);
            }

            await client.query(
                `INSERT INTO stock_adjustments (shop_id, client_uuid, product_id, quantity_change, reason, note, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [shopId, input.clientUuid, input.productId, change, input.reason, input.note, req.user.id]
            );
            const updated = await client.query(
                "UPDATE products SET stock_base = stock_base + $1 WHERE id = $2 AND shop_id = $3 RETURNING stock_base",
                [change, input.productId, shopId]
            );
            const note = REASON_TEXT[input.reason] + (input.note ? ": " + input.note : "");
            await client.query(
                `INSERT INTO stock_movements (shop_id, product_id, movement_type, quantity_change, stock_after,
                                              ref_type, note, created_by)
                 VALUES ($1, $2, 'adjustment', $3, $4, 'adjustment', $5, $6)`,
                [shopId, input.productId, change, updated.rows[0].stock_base, note, req.user.id]
            );
            await logAudit(client, {
                shopId, userId: req.user.id, action: "stock.adjust", entityType: "product", entityId: input.productId,
                details: { change, reason: input.reason, note: input.note }, ip: req.ip
            });
            return { duplicate: false, name: product.name, stockBase: updated.rows[0].stock_base };
        });

        res.json({
            success: true,
            message: result.duplicate ? "This change was already saved." : "Stock updated.",
            data: result
        });
    })
);

// ---------------------------------------------------------------------
// Stock-take: the shelf says X, the system says Y. Make the system match the shelf.
// ---------------------------------------------------------------------
router.post(
    "/stock-take",
    requireRole("owner"),
    asyncHandler(async (req, res) => {
        const input = parseStockTake(req.body);
        const shopId = req.user.shopId;

        const result = await pool.withTransaction(async (client) => {
            const ids = input.counts.map((c) => c.productId).sort((a, b) => a - b);
            const rows = (await client.query(
                `SELECT id, name, stock_base FROM products
                 WHERE id = ANY($1::bigint[]) AND shop_id = $2 ORDER BY id FOR UPDATE`,
                [ids, shopId]
            )).rows;
            if (rows.length !== ids.length) throw new HttpError(400, "A counted product could not be found.");
            const products = new Map(rows.map((p) => [p.id, p]));

            // Same stock-take sent twice? Nothing more to do.
            const uuids = ids.map((id) => derivedUuid(input.clientUuid, id));
            const seen = await client.query(
                "SELECT 1 FROM stock_adjustments WHERE shop_id = $1 AND client_uuid = ANY($2::uuid[]) LIMIT 1",
                [shopId, uuids]
            );
            if (seen.rowCount > 0) return { duplicate: true, applied: 0, unchanged: 0, changes: [] };

            const changes = [];
            let unchanged = 0;
            for (const count of input.counts) {
                const product = products.get(count.productId);
                const difference = count.countedBase - product.stock_base;
                if (difference === 0) { unchanged++; continue; }

                await client.query(
                    `INSERT INTO stock_adjustments (shop_id, client_uuid, product_id, quantity_change, system_qty,
                                                    counted_qty, reason, note, created_by)
                     VALUES ($1, $2, $3, $4, $5, $6, 'counted', $7, $8)`,
                    [shopId, derivedUuid(input.clientUuid, count.productId), count.productId, difference,
                     product.stock_base, count.countedBase, input.note, req.user.id]
                );
                await client.query("UPDATE products SET stock_base = $1 WHERE id = $2 AND shop_id = $3",
                    [count.countedBase, count.productId, shopId]);
                await client.query(
                    `INSERT INTO stock_movements (shop_id, product_id, movement_type, quantity_change, stock_after,
                                                  ref_type, note, created_by)
                     VALUES ($1, $2, 'stock_take', $3, $4, 'adjustment', $5, $6)`,
                    [shopId, count.productId, difference, count.countedBase,
                     `Stock-take: system had ${product.stock_base}, counted ${count.countedBase}` + (input.note ? ". " + input.note : ""),
                     req.user.id]
                );
                changes.push({ productId: product.id, name: product.name, system: product.stock_base, counted: count.countedBase, difference });
            }

            await logAudit(client, {
                shopId, userId: req.user.id, action: "stock.take", entityType: "shop", entityId: shopId,
                details: { applied: changes.length, unchanged, note: input.note }, ip: req.ip
            });
            return { duplicate: false, applied: changes.length, unchanged, changes };
        });

        res.json({
            success: true,
            message: result.duplicate ? "This stock-take was already saved." : "Stock-take saved.",
            data: result
        });
    })
);

module.exports = router;
