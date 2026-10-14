// test-db.js - checks that Duka can talk to PostgreSQL
// Run with:  node test-db.js   (or: npm run db:test)
const pool = require("./db");

async function testConnection() {
    try {
        const info = await pool.query(
            "SELECT current_database() AS database, NOW() AS server_time"
        );
        console.log("Connected to database:", info.rows[0].database);
        console.log("Server time:", info.rows[0].server_time);

        const tables = await pool.query(
            `SELECT table_name FROM information_schema.tables
             WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
             ORDER BY table_name`
        );
        const names = tables.rows.map((row) => row.table_name);
        console.log(`Tables found: ${names.length}`);

        // Quick look at the demo data (only if the tables exist)
        for (const table of ["shops", "users", "products", "customers", "suppliers"]) {
            if (names.includes(table)) {
                const count = await pool.query(`SELECT COUNT(*) AS n FROM ${table}`);
                console.log(`  ${table}: ${count.rows[0].n} row(s)`);
            }
        }

        if (!names.includes("shops")) {
            console.log("\nThe Duka tables are missing. Run:  npm run db:setup");
        }
    } catch (error) {
        console.error("Database test FAILED:", error.message);
        console.error("Check the DB_* values in your .env file and that PostgreSQL is running.");
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

testConnection();
