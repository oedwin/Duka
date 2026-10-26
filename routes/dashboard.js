// routes/dashboard.js - "today at a glance" for the Home screen.
//   GET /api/dashboard
// Owner: the whole shop (sales, money in by method, credit given, expenses, profit, who owes whom,
//        low stock, best sellers, 30-day chart).
// Cashier: only their own sales and money taken today, plus low stock. Never profit, cost or debts.
const express = require("express");

const pool = require("../db");
const asyncHandler = require("../utils/asyncHandler");
const { profitFigures } = require("../utils/profit");
const { lowStockDefault, loadUnitsAndPrices } = require("../utils/productData");
const { todayInShop, addDays, dayRange, SHOP_TZ } = require("../utils/time");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

router.get(
    "/",
    asyncHandler(async (req, res) => {
        const shopId = req.user.shopId;
        const isOwner = req.user.role === "owner";
        const today = todayInShop();

        // Cashiers only ever see what they sold and took themselves.
        const params = isOwner ? [shopId, today] : [shopId, today, req.user.id];
        const ownSales = isOwner ? "" : "AND s.served_by = $3";
        const ownPayments = isOwner ? "" : "AND p.received_by = $3 AND p.kind = 'sale_payment'";
        const todayOf = (column) => dayRange(column, "$2", "$2");

        const sales = (await pool.query(
            `SELECT COUNT(*) AS n, COALESCE(SUM(s.total_amount), 0)::bigint AS total,
                    COALESCE(SUM(s.balance_due), 0)::bigint AS credit, COALESCE(SUM(s.cogs), 0)::bigint AS cogs
             FROM sales s WHERE s.shop_id = $1 AND s.status = 'completed' AND ${todayOf("s.created_at")} ${ownSales}`,
            params
        )).rows[0];

        const received = (await pool.query(
            `SELECT p.kind, p.method, SUM(p.amount)::bigint AS total FROM payments p
             WHERE p.shop_id = $1 AND p.voided_at IS NULL AND ${todayOf("p.paid_at")} ${ownPayments}
             GROUP BY p.kind, p.method`,
            params
        )).rows;
        const collected = { cash: 0, mobile_money: 0, bank: 0, total: 0 };
        let debtPaymentsToday = 0;
        for (const r of received) {
            collected[r.method] += r.total;
            collected.total += r.total;
            if (r.kind === "debt_payment") debtPaymentsToday += r.total;
        }

        // Low stock is useful to everyone at the till.
        const lowDefault = await lowStockDefault(pool, shopId);
        const lowCondition = `p.stock_base <= 0 OR p.stock_base <= CASE WHEN p.reorder_level > 0 THEN p.reorder_level ELSE $2 END`;
        const lowCount = (await pool.query(
            `SELECT COUNT(*) FILTER (WHERE p.stock_base <= 0) AS out_count,
                    COUNT(*) FILTER (WHERE p.stock_base > 0) AS low_count
             FROM products p WHERE p.shop_id = $1 AND p.is_active AND (${lowCondition})`,
            [shopId, lowDefault]
        )).rows[0];
        const lowRows = (await pool.query(
            `SELECT p.id, p.name, p.stock_base FROM products p
             WHERE p.shop_id = $1 AND p.is_active AND (${lowCondition})
             ORDER BY p.stock_base ASC, LOWER(p.name) LIMIT 8`,
            [shopId, lowDefault]
        )).rows;
        const lowUnits = (await loadUnitsAndPrices(pool, lowRows.map((r) => r.id))).units;

        const data = {
            today,
            sales: { count: sales.n, total: sales.total, credit: sales.credit },
            collected,
            lowStock: {
                out: lowCount.out_count, low: lowCount.low_count,
                items: lowRows.map((r) => ({ id: r.id, name: r.name, stockBase: r.stock_base, units: lowUnits.get(r.id) || [], isOut: r.stock_base <= 0 }))
            }
        };

        if (isOwner) {
            const p = [shopId, today];
            const returns = (await pool.query(
                `SELECT COALESCE(SUM(r.refund_amount), 0)::bigint AS refunds,
                        COALESCE(SUM(ROUND(si.cost_total::numeric * r.quantity / si.quantity)), 0)::bigint AS returned_cost
                 FROM sale_returns r JOIN sale_items si ON si.id = r.sale_item_id
                 WHERE r.shop_id = $1 AND ${todayOf("r.created_at")}`, p
            )).rows[0];
            const expenses = (await pool.query(
                `SELECT COALESCE(SUM(amount), 0)::bigint AS total FROM expenses
                 WHERE shop_id = $1 AND voided_at IS NULL AND expense_date = $2::date`, p
            )).rows[0].total;
            const figures = profitFigures({
                salesTotal: sales.total, refunds: returns.refunds, cogs: sales.cogs,
                returnedCost: returns.returned_cost, expenses
            });

            const owedToUs = (await pool.query(
                "SELECT COALESCE(SUM(balance), 0)::bigint AS total, COUNT(*) AS n FROM customers WHERE shop_id = $1 AND balance > 0", [shopId]
            )).rows[0];
            const weOwe = (await pool.query(
                "SELECT COALESCE(SUM(balance), 0)::bigint AS total, COUNT(*) AS n FROM suppliers WHERE shop_id = $1 AND balance > 0", [shopId]
            )).rows[0];

            // Best sellers and the chart look back 30 days.
            const from30 = addDays(today, -29);
            const from7 = addDays(today, -6);
            const best = (await pool.query(
                `SELECT pr.id, pr.name, SUM(si.line_total)::bigint AS revenue, SUM(si.quantity_base)::bigint AS qty
                 FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products pr ON pr.id = si.product_id
                 WHERE s.shop_id = $1 AND s.status = 'completed' AND ${dayRange("s.created_at", "$2", "$3")}
                 GROUP BY pr.id, pr.name ORDER BY revenue DESC LIMIT 5`,
                [shopId, from7, today]
            )).rows;
            const bestUnits = (await loadUnitsAndPrices(pool, best.map((r) => r.id))).units;

            const dailyRows = (await pool.query(
                `SELECT (s.created_at AT TIME ZONE '${SHOP_TZ}')::date AS day, SUM(s.total_amount)::bigint AS total
                 FROM sales s WHERE s.shop_id = $1 AND s.status = 'completed' AND ${dayRange("s.created_at", "$2", "$3")}
                 GROUP BY 1`,
                [shopId, from30, today]
            )).rows;
            const byDay = new Map(dailyRows.map((r) => [r.day, r.total]));
            const chart = [];
            for (let i = 0; i < 30; i++) {
                const day = addDays(from30, i);
                chart.push({ day, total: byDay.get(day) || 0 });
            }

            Object.assign(data, {
                refunds: returns.refunds,
                expenses,
                profit: figures.netProfit,
                debtPaymentsToday,
                owedToUs: { total: owedToUs.total, customers: owedToUs.n },
                weOwe: { total: weOwe.total, suppliers: weOwe.n },
                bestSelling: best.map((r) => ({ id: r.id, name: r.name, revenue: r.revenue, qtyBase: r.qty, units: bestUnits.get(r.id) || [] })),
                chart
            });
        }

        res.json({ success: true, data });
    })
);

module.exports = router;
