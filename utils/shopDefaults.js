// utils/shopDefaults.js - what every NEW shop starts with, so the owner
// can begin working straight away.
async function createShopDefaults(client, shopId) {
    await client.query(
        "INSERT INTO categories (shop_id, name) VALUES ($1, 'General')",
        [shopId]
    );

    await client.query(
        `INSERT INTO expense_categories (shop_id, name)
         SELECT $1::bigint, name FROM unnest(ARRAY['Rent','Transport','Electricity','Wages',
                                           'Airtime','Water','Packaging','Other']) AS name`,
        [shopId]
    );

    await client.query(
        `INSERT INTO settings (shop_id, key, value)
         VALUES ($1, 'language', 'en'), ($1, 'low_stock_default', '10')`,
        [shopId]
    );

    // Counters for gap-free receipt numbers (used from Step 4).
    await client.query(
        `INSERT INTO receipt_counters (shop_id, counter_type)
         VALUES ($1, 'sale'), ($1, 'payment')`,
        [shopId]
    );
}

module.exports = { createShopDefaults };
