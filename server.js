require("dotenv").config();

const path = require("path");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");

const pool = require("./db"); // Connect the database to Duka's server
const { notFound, errorHandler } = require("./middleware/errorHandler");

// One router file per module (more are added in each build step)
const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const settingsRoutes = require("./routes/settings");
const categoryRoutes = require("./routes/categories");
const productRoutes = require("./routes/products");
const customerRoutes = require("./routes/customers");
const saleRoutes = require("./routes/sales");
const stockRoutes = require("./routes/stock");
const supplierRoutes = require("./routes/suppliers");
const purchaseRoutes = require("./routes/purchases");

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Behind Vercel's proxy, req.ip must come from the proxy header,
// otherwise the login limiter would treat every customer as one person.
if (process.env.NODE_ENV === "production" || process.env.VERCEL) {
    app.set("trust proxy", 1);
}

// ---------- Security and basics ----------
// Safe browser headers. Scripts may only come from our own files, so keep
// JavaScript in /public/js files instead of inline <script> or onclick="...".
app.use(
    helmet({
        contentSecurityPolicy: {
            useDefaults: true,
            directives: {
                "script-src": ["'self'"],
                "img-src": ["'self'", "data:", "blob:"],
                "upgrade-insecure-requests": null // lets http://localhost work
            }
        }
    })
);

// The app and API share one address, so CORS is OFF unless you list origins
// in .env, e.g. CORS_ORIGIN=https://duka.vercel.app,http://localhost:3000
app.use(
    cors({
        origin: process.env.CORS_ORIGIN
            ? process.env.CORS_ORIGIN.split(",").map((origin) => origin.trim())
            : false
    })
);

// Allow the server to read JSON request bodies
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------- Routes ----------
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/products", productRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/sales", saleRoutes);
app.use("/api/stock", stockRoutes);
app.use("/api/suppliers", supplierRoutes);
app.use("/api/purchases", purchaseRoutes);

// Health-check route
app.get("/health", (req, res) => {
    res.json({
        status: "OK",
        application: "Duka"
    });
});

/* Small API endpoint that checks whether the server can communicate with PostgreSQL. */
app.get("/api/db-test", async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT current_database() AS database"
        );

        res.json({
            status: "connected",
            database: result.rows[0].database
        });
    } catch (error) {
        console.error("Database test failed:", error.message);

        res.status(500).json({
            status: "error",
            message: "Database connection failed"
        });
    }
});

// ---------- Errors (always JSON, always the same shape) ----------
app.use("/api", notFound);
app.use(errorHandler);

// ---------- Start ----------
// Only listen when run directly (node server.js). When Vercel imports this
// file later, it uses the exported app instead.
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Duka server running at http://localhost:${PORT}`);
    });
}

module.exports = app;
