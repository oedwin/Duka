// db.js - PostgreSQL connection for Duka
// Works with your local database (DB_HOST, DB_PORT, ...) and, later, with a
// hosted one (DATABASE_URL, e.g. from Neon or Supabase) with no code changes.
require("dotenv").config();

const { Pool, types } = require("pg");

// PostgreSQL BIGINT normally arrives in JavaScript as TEXT ("25000").
// UGX amounts and ids are far below the safe number limit, so convert them
// to real numbers. This avoids bugs like "25000" + "5000" = "250005000".
types.setTypeParser(20, (value) => parseInt(value, 10));

// If DATABASE_URL is set we use it, otherwise we use the separate DB_* values.
const connection = process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD
    };

const pool = new Pool({
    ...connection,
    // Keep this small: on Vercel every function opens its own pool.
    max: Number(process.env.DB_POOL_MAX) || 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    // Hosted databases need SSL. Locally leave DB_SSL=false.
    ssl: process.env.DB_SSL === "true"
});

// Stops an idle-connection problem from crashing the whole server.
pool.on("error", (error) => {
    console.error("Unexpected database error:", error.message);
});

/**
 * Run several queries as ONE all-or-nothing transaction.
 * If anything throws, everything is rolled back.
 *
 *   await pool.withTransaction(async (client) => {
 *       await client.query("UPDATE products SET ...");
 *       await client.query("INSERT INTO sales ...");
 *   });
 */
pool.withTransaction = async function withTransaction(work) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await work(client);
        await client.query("COMMIT");
        return result;
    } catch (error) {
        try {
            await client.query("ROLLBACK");
        } catch (rollbackError) {
            console.error("Rollback failed:", rollbackError.message);
        }
        throw error;
    } finally {
        client.release();
    }
};

// Same export as before, so require("./db") keeps working everywhere.
module.exports = pool;
