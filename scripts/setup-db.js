// scripts/setup-db.js - builds the Duka database from database.sql
//
//   npm run db:setup    Creates anything missing. Safe to run again.
//   npm run db:reset    DELETES ALL DATA, then rebuilds from scratch.
//
// Works with local PostgreSQL and, later, a hosted one (via DATABASE_URL).
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const pool = require("../db");

function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim().toLowerCase());
        });
    });
}

async function main() {
    const reset = process.argv.includes("--reset");

    try {
        const { rows } = await pool.query("SELECT current_database() AS name");
        const dbName = rows[0].name;

        if (reset) {
            if (process.env.NODE_ENV === "production") {
                throw new Error("Reset is blocked when NODE_ENV=production.");
            }
            const answer = await ask(
                `This will DELETE ALL DATA in database "${dbName}". Type yes to continue: `
            );
            if (answer !== "yes") {
                console.log("Cancelled. Nothing was changed.");
                return;
            }
            await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
            console.log("Old tables removed.");
        }

        const sql = fs.readFileSync(path.join(__dirname, "..", "database.sql"), "utf8");
        await pool.query(sql);
        console.log(`Database "${dbName}" is ready.`);
        console.log("Demo login: phone 0700000001 / password demo1234 (owner)");
    } catch (error) {
        console.error("Database setup FAILED:", error.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

main();
