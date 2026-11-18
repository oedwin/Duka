// utils/pesapal.js - talks to Pesapal (API 3.0). Nothing else in Duka calls Pesapal directly.
//
// Environment variables (set them in Vercel -> Settings -> Environment Variables, never in code):
//   PESAPAL_ENV              "sandbox" (test, fake money) or "live"            default: sandbox
//   PESAPAL_CONSUMER_KEY     from your Pesapal account
//   PESAPAL_CONSUMER_SECRET  from your Pesapal account
//   APP_URL                  your site address, e.g. https://duka.vercel.app  (no slash at the end)
//   PESAPAL_IPN_ID           optional: the id Pesapal gave your notification address. If it is missing,
//                            Duka registers the address itself (Pesapal returns the same id for the same address).
const HttpError = require("./httpError");

const BASES = {
    sandbox: "https://cybqa.pesapal.com/pesapalv3/api",
    live: "https://pay.pesapal.com/v3/api"
};

function settings() {
    const env = String(process.env.PESAPAL_ENV || "sandbox").toLowerCase() === "live" ? "live" : "sandbox";
    return {
        env,
        base: BASES[env],
        key: process.env.PESAPAL_CONSUMER_KEY || "",
        secret: process.env.PESAPAL_CONSUMER_SECRET || "",
        appUrl: String(process.env.APP_URL || "").replace(/\/+$/, "")
    };
}

function isConfigured() {
    const s = settings();
    return Boolean(s.key && s.secret && /^https?:\/\//.test(s.appUrl));
}

// One call to Pesapal. Network trouble or a bad answer becomes a plain HttpError (502), never a crash.
async function call(method, path, { body, token, query } = {}) {
    const s = settings();
    const url = s.base + path + (query ? "?" + new URLSearchParams(query).toString() : "");
    let res;
    try {
        res = await fetch(url, {
            method,
            headers: Object.assign(
                { Accept: "application/json", "Content-Type": "application/json" },
                token ? { Authorization: "Bearer " + token } : {}
            ),
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(15000)
        });
    } catch (error) {
        throw new HttpError(502, "Could not reach the payment service. Please try again in a moment.");
    }
    let json = null;
    try { json = await res.json(); } catch (error) { /* not JSON */ }
    if (!res.ok || !json) {
        throw new HttpError(502, "The payment service did not answer properly. Please try again in a moment.");
    }
    return json;
}

// The access token lasts a few minutes: keep it in memory and ask again shortly before it ends.
let cached = { token: null, until: 0, env: null };
async function getToken() {
    const s = settings();
    if (cached.token && cached.env === s.env && Date.now() < cached.until - 30000) return cached.token;
    const json = await call("POST", "/Auth/RequestToken", { body: { consumer_key: s.key, consumer_secret: s.secret } });
    if (!json.token) {
        console.error("Pesapal token refused:", JSON.stringify(json.error || json.message || json));
        throw new HttpError(502, "Online payment is not set up correctly yet. Please contact Duka support.");
    }
    const until = json.expiryDate ? Date.parse(json.expiryDate) : NaN;
    cached = { token: json.token, until: Number.isFinite(until) ? until : Date.now() + 4 * 60 * 1000, env: s.env };
    return json.token;
}

// The address Pesapal tells us about payment changes (the "IPN").
let cachedIpn = { id: null, env: null };
async function getIpnId(token) {
    const s = settings();
    if (process.env.PESAPAL_IPN_ID) return process.env.PESAPAL_IPN_ID;
    if (cachedIpn.id && cachedIpn.env === s.env) return cachedIpn.id;
    const json = await call("POST", "/URLSetup/RegisterIPN", {
        token, body: { url: s.appUrl + "/api/pesapal/ipn", ipn_notification_type: "GET" }
    });
    if (!json.ipn_id) {
        console.error("Pesapal IPN registration failed:", JSON.stringify(json.error || json.message || json));
        throw new HttpError(502, "Online payment is not set up correctly yet. Please contact Duka support.");
    }
    cachedIpn = { id: json.ipn_id, env: s.env };
    return json.ipn_id;
}

/**
 * Ask Pesapal to open a payment page for one pending payment.
 * Returns { orderTrackingId, redirectUrl }.
 *   payment: { merchantRef, amount, months, planName }   payer: { phone, shopName }
 */
async function submitOrder(payment, payer) {
    const s = settings();
    const token = await getToken();
    const ipnId = await getIpnId(token);
    const phone = String(payer.phone || "").replace(/\D/g, "");
    const json = await call("POST", "/Transactions/SubmitOrderRequest", {
        token,
        body: {
            id: payment.merchantRef,
            currency: "UGX",
            amount: Number(payment.amount),
            description: `Duka ${payment.planName} plan, ${payment.months} month${payment.months > 1 ? "s" : ""}`.slice(0, 100),
            callback_url: s.appUrl + "/api/pesapal/callback",
            cancellation_url: s.appUrl + "/api/pesapal/callback",
            notification_id: ipnId,
            billing_address: {
                phone_number: phone || undefined,
                email_address: payer.email || undefined,
                country_code: "UG",
                first_name: String(payer.shopName || "Duka").slice(0, 50)
            }
        }
    });
    if (!json.order_tracking_id || !json.redirect_url) {
        console.error("Pesapal order refused:", JSON.stringify(json.error || json.message || json));
        throw new HttpError(502, "Could not start the payment. Please try again, or contact Duka support.");
    }
    return { orderTrackingId: json.order_tracking_id, redirectUrl: json.redirect_url };
}

/**
 * The only trusted answer about a payment: ask Pesapal directly (never believe a notification on its own).
 * Returns { state: 'successful'|'failed'|'reversed'|'pending', merchantRef, amount, currency, method, phone,
 *           confirmationCode, description, raw }.
 *   Pesapal status_code: 0 INVALID (not paid yet / unknown), 1 COMPLETED, 2 FAILED, 3 REVERSED.
 */
async function getStatus(orderTrackingId) {
    const token = await getToken();
    const json = await call("GET", "/Transactions/GetTransactionStatus", { token, query: { orderTrackingId } });
    const code = Number(json.status_code);
    const state = code === 1 ? "successful" : code === 2 ? "failed" : code === 3 ? "reversed" : "pending";
    return {
        state,
        merchantRef: json.merchant_reference || null,
        amount: Number(json.amount),
        currency: json.currency || null,
        method: json.payment_method ? String(json.payment_method).toLowerCase().slice(0, 20) : null,
        phone: null, // Pesapal only gives a masked number, so it is not saved
        confirmationCode: json.confirmation_code || null,
        description: json.payment_status_description || json.description || null,
        raw: json
    };
}

module.exports = { isConfigured, settings, submitOrder, getStatus };
