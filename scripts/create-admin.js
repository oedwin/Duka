// scripts/create-admin.js - create a Duka administrator, or reset one's password.
//   node scripts/create-admin.js "Edwin Onyango" 0772123456
// It asks for the password (typing is hidden). Run it on your own computer with your .env (DATABASE_URL) in place.
// If that phone number already has an admin account, its name and password are replaced (use this when you forget it).
require("dotenv").config();
const readline = require("readline");
const bcrypt = require("bcryptjs");
const pool = require("../db");
const { normalizePhone } = require("../utils/phone");

function askHidden(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        rl._writeToOutput = (text) => { if (text.includes(question)) process.stdout.write(question); };
        rl.question(question, (answer) => { rl.close(); process.stdout.write("\n"); resolve(answer); });
    });
}

(async () => {
    const name = String(process.argv[2] || "").trim();
    const phone = normalizePhone(process.argv[3]);
    if (!name || !phone) {
        console.log('Use:  node scripts/create-admin.js "Your Name" 0772123456');
        process.exit(1);
    }
    const password = await askHidden("Password (at least 10 characters): ");
    const again = await askHidden("Type it again: ");
    if (password !== again) { console.log("The two passwords are different. Nothing was saved."); process.exit(1); }
    if (password.length < 10) { console.log("The password must be at least 10 characters. Nothing was saved."); process.exit(1); }

    const hash = await bcrypt.hash(password, 12);
    await pool.query(
        `INSERT INTO admin_accounts (full_name, phone, password_hash) VALUES ($1, $2, $3)
         ON CONFLICT (phone) DO UPDATE SET full_name = EXCLUDED.full_name, password_hash = EXCLUDED.password_hash, is_active = TRUE`,
        [name, phone, hash]
    );
    console.log(`Done. ${name} (${phone}) can now log in at /admin-login`);
    if (pool.end) await pool.end();
})().catch((error) => { console.error("Could not save:", error.message); process.exit(1); });
