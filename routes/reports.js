// routes/reports.js - how the shop is doing (owner only).
//   GET /api/reports/summary?from=&to=    sales, profit and loss, payments, retail vs wholesale, cashiers, daily figures
//   GET /api/reports/products?from=&to=   profit per product and category, fastest and slowest sellers
//
// Dates are shop days in Kampala. No dates = today. See utils/profit.js for how profit is worked out.
const express = require("express");

const pool = require("../db");
const HttpError = require("../utils/httpError");
const asyncHandler = require("../utils/asyncHandler");
const { cleanDate } = require("../utils/productInput");
const { profitFigures } = require("../utils/profit");
const { loadUnitsAndPrices } = require("../utils/productData");
const { resolveRange, dayRange, SHOP_TZ, addDays } = require("../utils/time");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireRole("owner"));

function rangeFrom(query) {
    return resolveRange(cleanDate(query.from, "the start date"), cleanDate(query.to, "the end date"));
}

// ---------------------------------------------------------------------
router.get(
    "/summary",
    asyncHandler(async (req, res) => {
        const shopId = req.user.shopId;
        const { from, to } = rangeFrom(req.query);
        const p = [shopId, from, to];
        const inRange = (column) => dayRange(column, "$2", "$3");

        const sales = (await pool.query(
            `SELECT COUNT(*) AS n, COALESCE(SUM(total_amount), 0)::bigint AS total,
                    COALESCE(SUM(discount_amount), 0)::bigint AS discounts,
                    COALESCE(SUM(cogs), 0)::bigint AS cogs, COALESCE(SUM(balance_due), 0)::bigint AS credit
             FROM sales s WHERE s.shop_id = $1 AND s.status = 'completed' AND ${inRange("s.created_at")}`, p
        )).rows[0];

        const returns = (await pool.query(
            `SELECT COALESCE(SUM(r.refund_amount), 0)::bigint AS refunds,
                    COALESCE(SUM(ROUND(si.cost_total::numeric * r.quantity / si.quantity)), 0)::bigint AS returned_cost
             FROM sale_returns r JOIN sale_items si ON si.id = r.sale_item_id
             WHERE r.shop_id = $1 AND ${inRange("r.created_at")}`, p
        )).rows[0];

        const expenseRows = (await pool.query(
            `SELECT COALESCE(c.name, 'No category') AS category, SUM(e.amount)::bigint AS total
             FROM expenses e LEFT JOIN expense_categories c ON c.id = e.category_id
             WHERE e.shop_id = $1 AND e.voided_at IS NULL AND e.expense_date BETWEEN $2::date AND $3::date
             GROUP BY COALESCE(c.name, 'No category') ORDER BY total DESC`, p
        )).rows;
        const expenses = expenseRows.reduce((sum, r) => sum + r.total, 0);

        const figures = profitFigures({
            salesTotal: sales.total, refunds: returns.refunds, cogs: sales.cogs,
            returnedCost: returns.returned_cost, expenses
        });

        // Money actually received, by how it was paid
        const received = (await pool.query(
            `SELECT kind, method, SUM(amount)::bigint AS total FROM payments
             WHERE shop_id = $1 AND voided_at IS NULL AND ${inRange("paid_at")}
             GROUP BY kind, method`, p
        )).rows;
        const empty = () => ({ cash: 0, mobile_money: 0, bank: 0, total: 0 });
        const collected = empty();
        const debtPayments = empty();
        for (const r of received) {
            const target = r.kind === "sale_payment" ? collected : debtPayments;
            target[r.method] += r.total;
            target.total += r.total;
        }

        const byType = (await pool.query(
            `SELECT s.sale_type, COUNT(*) AS n, SUM(s.total_amount)::bigint AS total, SUM(s.cogs)::bigint AS cogs
             FROM sales s WHERE s.shop_id = $1 AND s.status = 'completed' AND ${inRange("s.created_at")}
             GROUP BY s.sale_type ORDER BY s.sale_type DESC`, p
        )).rows;

        const byCashier = (await pool.query(
            `SELECT COALESCE(u.full_name, 'Unknown') AS name, COUNT(*) AS n, SUM(s.total_amount)::bigint AS total,
                    SUM(s.cogs)::bigint AS cogs
             FROM sales s LEFT JOIN users u ON u.id = s.served_by
             WHERE s.shop_id = $1 AND s.status = 'completed' AND ${inRange("s.created_at")}
             GROUP BY u.id, u.full_name ORDER BY total DESC`, p
        )).rows;

        const daily = (await pool.query(
            `SELECT (s.created_at AT TIME ZONE '${SHOP_TZ}')::date AS day, COUNT(*) AS n,
                    SUM(s.total_amount)::bigint AS total, SUM(s.cogs)::bigint AS cogs
             FROM sales s WHERE s.shop_id = $1 AND s.status = 'completed' AND ${inRange("s.created_at")}
             GROUP BY 1 ORDER BY 1`, p
        )).rows;

        res.json({
            success: true,
            data: {
                range: { from, to },
                sales: { count: sales.n, total: sales.total, discounts: sales.discounts, credit: sales.credit },
                refunds: returns.refunds,
                costOfGoodsBeforeReturns: sales.cogs, returnedCost: returns.returned_cost,
                ...figures,
                expenses: { total: expenses, byCategory: expenseRows },
                collected, debtPayments,
                byType: byType.map((r) => ({ type: r.sale_type, count: r.n, total: r.total, profit: r.total - r.cogs })),
                byCashier: byCashier.map((r) => ({ name: r.name, count: r.n, total: r.total, profit: r.total - r.cogs })),
                daily: daily.map((r) => ({ day: r.day, count: r.n, total: r.total, profit: r.total - r.cogs }))
            }
        });
    })
);

// ---------------------------------------------------------------------
router.get(
    "/products",
    asyncHandler(async (req, res) => {
        const shopId = req.user.shopId;
        const { from, to } = rangeFrom(req.query);
        const p = [shopId, from, to];
        const inRange = (column) => dayRange(column, "$2", "$3");

        const SORTS = {
            profit: "(SUM(si.line_total) - SUM(si.cost_total)) DESC",
            revenue: "SUM(si.line_total) DESC",
            quantity: "COUNT(DISTINCT si.sale_id) DESC",
            name: "LOWER(pr.name)"
        };
        const sort = SORTS[req.query.sort || "profit"];
        if (!sort) throw new HttpError(400, "Unknown sort.");

        const rows = (await pool.query(
            `SELECT si.product_id, pr.name, c.name AS category,
                    SUM(si.quantity_base)::bigint AS qty_base, SUM(si.line_total)::bigint AS revenue,
                    SUM(si.cost_total)::bigint AS cost, COUNT(DISTINCT si.sale_id) AS times_sold
             FROM sale_items si
             JOIN sales s ON s.id = si.sale_id
             JOIN products pr ON pr.id = si.product_id
             LEFT JOIN categories c ON c.id = pr.category_id
             WHERE s.shop_id = $1 AND s.status = 'completed' AND ${inRange("s.created_at")}
             GROUP BY si.product_id, pr.name, c.name
             ORDER BY ${sort}, LOWER(pr.name) LIMIT 300`, p
        )).rows;

        const { units } = await loadUnitsAndPrices(pool, rows.map((r) => r.product_id));
        const products = rows.map((r) => ({
            id: r.product_id, name: r.name, category: r.category || "No category",
            qtyBase: r.qty_base, units: units.get(r.product_id) || [], timesSold: r.times_sold,
            revenue: r.revenue, cost: r.cost, profit: r.revenue - r.cost,
            margin: r.revenue > 0 ? Math.round(((r.revenue - r.cost) * 100) / r.revenue) : 0
        }));

        const categoryMap = new Map();
        for (const x of products) {
            const c = categoryMap.get(x.category) || { category: x.category, revenue: 0, cost: 0, products: 0 };
            c.revenue += x.revenue; c.cost += x.cost; c.products += 1;
            categoryMap.set(x.category, c);
        }
        const categories = [...categoryMap.values()]
            .map((c) => ({ ...c, profit: c.revenue - c.cost }))
            .sort((a, b) => b.profit - a.profit);

        // Fast movers: sold in the most separate sales. Slow movers: in stock but NOT sold at all in the period.
        const fast = [...products].sort((a, b) => b.timesSold - a.timesSold || b.revenue - a.revenue).slice(0, 10);

        const slowRows = (await pool.query(
            `SELECT pr.id, pr.name, pr.stock_base, pr.cost_price,
                    (SELECT MAX(s2.created_at) FROM sale_items si2 JOIN sales s2 ON s2.id = si2.sale_id
                      WHERE si2.product_id = pr.id AND s2.status = 'completed') AS last_sold
             FROM products pr
             WHERE pr.shop_id = $1 AND pr.is_active AND pr.stock_base > 0
               AND NOT EXISTS (SELECT 1 FROM sale_items si3 JOIN sales s3 ON s3.id = si3.sale_id
                                WHERE si3.product_id = pr.id AND s3.status = 'completed' AND ${inRange("s3.created_at")})
             ORDER BY last_sold NULLS FIRST, LOWER(pr.name) LIMIT 30`, p
        )).rows;
        const slowUnits = (await loadUnitsAndPrices(pool, slowRows.map((r) => r.id))).units;
        const slow = slowRows.map((r) => ({
            id: r.id, name: r.name, stockBase: r.stock_base, units: slowUnits.get(r.id) || [],
            stockValue: r.stock_base * r.cost_price, lastSold: r.last_sold
        }));

        res.json({ success: true, data: { range: { from, to }, products, categories, fast, slow } });
    })
);

module.exports = router;
