require("dotenv").config();

const path = require("path");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");

const pool = require("./db"); // Connect the database to Duka's server
const { notFound, errorHandler } = require("./middleware/errorHandler");
const { requireAuth, requireFeature } = require("./middleware/auth");

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
const expenseRoutes = require("./routes/expenses");
const reportRoutes = require("./routes/reports");
const dashboardRoutes = require("./routes/dashboard");
const closingRoutes = require("./routes/closings");
const orderRoutes = require("./routes/orders");
const productPhotoRoutes = require("./routes/product-photos");
const subscriptionRoutes = require("./routes/subscription");
const pesapalRoutes = require("./routes/pesapal");
const adminRoutes = require("./routes/admin");

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

/* ---------- Clean URLs for HTML pages ---------- */

// If someone opens /closing.html, send them to /closing (index.html -> /).
// IMPORTANT: keep the part after the "?" (e.g. ?id=5&new=1). Pages such as the receipt, a customer
// or a supplier need it to know which record to show; without it they cannot work.
app.get(/^\/([a-zA-Z0-9_-]+)\.html$/, (req, res) => {
    const page = req.params[0];
    const queryStart = req.originalUrl.indexOf("?");
    const query = queryStart === -1 ? "" : req.originalUrl.slice(queryStart);
    res.redirect((page === "index" ? "/" : `/${page}`) + query);
});

// "extensions: ['html']" makes /closing serve public/closing.html,
// /pos serve pos.html, and so on. Real files (css, js, images) still work.
app.use(
    express.static(path.join(__dirname, "public"), {
        extensions: ["html"]
    })
);

// The install name of the app: the shop's own name (Duka's browser code asks for /api/manifest?n=Shop%20Name).
// Anyone can call this, so the name is cleaned and cut short. Without a name the app is just "Duka".
app.get("/api/manifest", (req, res) => {
    const shop = String(req.query.n || "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
    const icons = [
        { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
    ];
    res.set("Cache-Control", "no-cache").type("application/manifest+json").send(JSON.stringify({
        name: shop || "Duka",
        short_name: (shop || "Duka").slice(0, 12),
        description: "Sales, stock and customers for your shop.",
        id: "/", start_url: "/", scope: "/", display: "standalone",
        background_color: "#edf2ee", theme_color: "#0a5a37", lang: "en",
        icons,
        shortcuts: [
            { name: "Sell", url: "/pos", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
            { name: "Sales", url: "/sales", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] }
        ]
    }));
});

// ---------- Routes ----------
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/products", productRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/sales", saleRoutes);
app.use("/api/stock", stockRoutes);
// Suppliers and purchases belong to the Business plan and above (only enforced when SUBSCRIPTION_ENFORCE=true).
app.use("/api/suppliers", requireAuth, requireFeature("suppliers"), supplierRoutes);
app.use("/api/purchases", requireAuth, requireFeature("purchasing"), purchaseRoutes);
app.use("/api/expenses", expenseRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/closings", closingRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/product-photos", productPhotoRoutes);
app.use("/api/subscription", subscriptionRoutes);
// Called by Pesapal and by the customer coming back from paying: no login (see routes/pesapal.js).
app.use("/api/pesapal", pesapalRoutes);
// The Duka administrator only (own login, admin_accounts table): see routes/admin.js.
app.use("/api/admin", adminRoutes);

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