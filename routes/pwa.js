// routes/pwa.js - serves /sw.js, the service worker (see templates/sw.template.js).
// The list of files to keep on the phone and the version number are worked out from the
// files in /public, so a changed file automatically means a new version.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");

const router = express.Router();
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const TEMPLATE = path.join(__dirname, "..", "templates", "sw.template.js");

// If the files cannot be listed (some hosts), these core pages are still saved.
const FALLBACK = ["/", "/dashboard", "/pos", "/sales", "/receipt", "/products", "/offline", "/css/app.css",
    "/js/api.js", "/js/ui.js", "/js/shell.js", "/js/pwa.js", "/manifest.json"];

function walk(dir, base = "") {
    let out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = base + "/" + entry.name;
        if (entry.isDirectory()) out = out.concat(walk(path.join(dir, entry.name), rel));
        else out.push(rel);
    }
    return out;
}

function build() {
    let files;
    try { files = walk(PUBLIC_DIR); } catch (error) { files = []; }

    const urls = [];
    const fingerprint = crypto.createHash("sha1");
    for (const rel of files.sort()) {
        let url = null;
        if (rel.endsWith(".html")) url = rel === "/index.html" ? "/" : rel.replace(/\.html$/, "");
        else if (/\.(css|js|png|json|svg|ico|webp)$/.test(rel)) url = rel;
        if (!url) continue;
        urls.push(url);
        const stat = fs.statSync(path.join(PUBLIC_DIR, rel));
        fingerprint.update(rel + ":" + stat.size + ":" + Math.round(stat.mtimeMs));
    }
    if (urls.length === 0) urls.push(...FALLBACK);

    const version = fingerprint.digest("hex").slice(0, 10);
    const template = fs.readFileSync(TEMPLATE, "utf8");
    return template.replace("__VERSION__", version).replace("__PRECACHE__", JSON.stringify(urls));
}

let cached = null;
let builtAt = 0;
const DEV = process.env.NODE_ENV !== "production" && !process.env.VERCEL;

router.get("/sw.js", (req, res, next) => {
    try {
        // While developing, look at the files every time; in production once every 5 minutes.
        if (!cached || DEV || Date.now() - builtAt > 5 * 60 * 1000) {
            cached = build();
            builtAt = Date.now();
        }
        res.set({
            "Content-Type": "application/javascript; charset=utf-8",
            "Cache-Control": "no-cache",
            "Service-Worker-Allowed": "/"
        });
        res.send(cached);
    } catch (error) {
        next(error);
    }
});

module.exports = router;
