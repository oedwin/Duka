// utils/productData.js - product lookups shared by the product screens and the till.

async function lowStockDefault(db, shopId) {
    const { rows } = await db.query(
        "SELECT value FROM settings WHERE shop_id = $1 AND key = 'low_stock_default'", [shopId]
    );
    const value = rows[0] ? parseInt(rows[0].value, 10) : 10;
    return Number.isFinite(value) ? value : 10;
}

/** Units and prices for several products at once (two queries, not one per product). */
async function loadUnitsAndPrices(db, productIds) {
    const units = new Map();
    const prices = new Map();
    if (productIds.length === 0) return { units, prices };

    const unitRows = await db.query(
        `SELECT id, product_id, name, factor_to_base FROM product_units
         WHERE product_id = ANY($1::bigint[]) ORDER BY factor_to_base`,
        [productIds]
    );
    for (const row of unitRows.rows) {
        if (!units.has(row.product_id)) units.set(row.product_id, []);
        units.get(row.product_id).push({ id: row.id, name: row.name, factor: row.factor_to_base });
    }

    const priceRows = await db.query(
        `SELECT product_id, unit_id, level, price, min_qty, customer_id FROM product_prices
         WHERE product_id = ANY($1::bigint[]) ORDER BY unit_id, level, min_qty`,
        [productIds]
    );
    for (const row of priceRows.rows) {
        if (!prices.has(row.product_id)) prices.set(row.product_id, []);
        prices.get(row.product_id).push({
            unitId: row.unit_id, level: row.level, price: row.price,
            minQty: row.min_qty, customerId: row.customer_id
        });
    }
    return { units, prices };
}

module.exports = { lowStockDefault, loadUnitsAndPrices };
