// utils/payments.js - connects a saved (pending) subscription payment to Pesapal and back.
//
//   startPayment()   after checkout: opens a Pesapal payment page and returns its address.
//   settlePayment()  after Pesapal says "something changed": asks Pesapal what really happened, then
//                    - COMPLETED  -> applySuccessfulPayment() (days are added, shop works again)
//                    - FAILED     -> the payment is marked failed, nothing is added
//                    - REVERSED   -> flagged for review (see below)
//                    - anything else -> still pending, nothing changes
// Both the Pesapal notification and the customer coming back call settlePayment(), and so does the
// "Check payment" button. It is safe to run any number of times for the same payment.
const HttpError = require("./httpError");
const { logAudit } = require("./audit");
const pesapal = require("./pesapal");
const S = require("./subscriptions");

const paymentsEnabled = () => String(process.env.PAYMENTS_ENABLED || "").toLowerCase() === "true";

/** Is online payment switched on and set up? */
function onlinePaymentsReady() {
    return paymentsEnabled() && pesapal.isConfigured();
}

/**
 * Open a Pesapal payment page for a pending payment. Returns the address to send the owner to, or null
 * when online payment is not switched on (the order is then just saved with its reference).
 */
async function startPayment(pool, user, payment) {
    if (!onlinePaymentsReady() || payment.status !== "pending" || payment.provider !== "pesapal") return null;

    const stored = (await pool.query(
        "SELECT provider_ref, raw_response FROM subscription_payments WHERE id = $1 AND shop_id = $2",
        [payment.id, user.shopId]
    )).rows[0];
    // Asked twice (double tap, retry): hand back the same payment page instead of opening a second order.
    if (stored && stored.provider_ref && stored.raw_response && stored.raw_response.redirectUrl) {
        return stored.raw_response.redirectUrl;
    }

    const who = (await pool.query(
        "SELECT u.phone, s.name AS shop_name FROM users u JOIN shops s ON s.id = u.shop_id WHERE u.id = $1",
        [user.id]
    )).rows[0] || {};
    const order = await pesapal.submitOrder(payment, { phone: who.phone, shopName: who.shop_name });

    await pool.query(
        `UPDATE subscription_payments
            SET provider_ref = $2, raw_response = COALESCE(raw_response, '{}'::jsonb) || $3::jsonb
          WHERE id = $1 AND status = 'pending'`,
        [payment.id, order.orderTrackingId, JSON.stringify({ redirectUrl: order.redirectUrl })]
    );
    return order.redirectUrl;
}

/**
 * Ask Pesapal what happened to one order and update our records.
 * orderTrackingId comes from Pesapal's notification / return address, but it is only used as a question:
 * the answer (amount, our reference, completed or not) comes from Pesapal's own server.
 * Returns { state, merchantRef } where state is successful | failed | reversed | pending | unknown.
 */
async function settlePayment(pool, orderTrackingId) {
    const id = String(orderTrackingId || "").trim();
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) throw new HttpError(400, "That payment reference is not valid.");

    const status = await pesapal.getStatus(id);

    return pool.withTransaction(async (client) => {
        // Find the payment by the order number we saved when we opened it; if Pesapal's answer also names
        // our reference (it normally does), use that as a fallback for an order whose number we failed to save.
        let pay = (await client.query(
            "SELECT * FROM subscription_payments WHERE provider = 'pesapal' AND provider_ref = $1 FOR UPDATE", [id]
        )).rows[0];
        if (!pay && status.merchantRef) {
            pay = (await client.query(
                "SELECT * FROM subscription_payments WHERE provider = 'pesapal' AND merchant_ref = $1 FOR UPDATE",
                [status.merchantRef]
            )).rows[0];
        }
        if (!pay) return { state: "unknown", merchantRef: null };
        // Pesapal must be talking about the order we opened for this payment.
        if (status.merchantRef && status.merchantRef !== pay.merchant_ref) return { state: "unknown", merchantRef: pay.merchant_ref };
        if (pay.provider_ref && pay.provider_ref !== id) return { state: "unknown", merchantRef: pay.merchant_ref };

        if (status.state === "successful") {
            // The amount Pesapal took must match the price we saved. Otherwise do not give days: flag it.
            if (status.currency !== "UGX" || Math.round(status.amount) !== Number(pay.amount)) {
                await logAudit(client, {
                    shopId: pay.shop_id, userId: null, action: "subscription.payment_mismatch",
                    entityType: "subscription_payment", entityId: pay.id,
                    details: { expected: Number(pay.amount), paid: status.amount, currency: status.currency }
                });
                await client.query(
                    "UPDATE subscription_payments SET failure_reason = $2, raw_response = COALESCE(raw_response, '{}'::jsonb) || $3::jsonb WHERE id = $1",
                    [pay.id, "The amount paid does not match the price. Duka support is checking it.", JSON.stringify({ status: status.raw })]
                );
                return { state: "pending", merchantRef: pay.merchant_ref };
            }
            await S.applySuccessfulPayment(client, {
                merchantRef: pay.merchant_ref, providerRef: id, method: status.method,
                rawResponse: Object.assign({}, pay.raw_response || {}, { status: status.raw })
            });
            return { state: "successful", merchantRef: pay.merchant_ref };
        }

        if (status.state === "failed" && pay.status === "pending") {
            await client.query(
                `UPDATE subscription_payments
                    SET status = 'failed', provider_ref = COALESCE(provider_ref, $2), method = COALESCE($3, method),
                        failure_reason = $4, raw_response = COALESCE(raw_response, '{}'::jsonb) || $5::jsonb
                  WHERE id = $1`,
                [pay.id, id, status.method, "The payment was not completed. You have not been charged for Duka.",
                 JSON.stringify({ status: status.raw })]
            );
            await logAudit(client, {
                shopId: pay.shop_id, userId: null, action: "subscription.payment_failed",
                entityType: "subscription_payment", entityId: pay.id, details: { reason: status.description }
            });
            return { state: "failed", merchantRef: pay.merchant_ref };
        }

        if (status.state === "reversed") {
            // Money was returned after a successful payment. Days already given are not taken back
            // automatically: a person decides. Leave a record so it can be found.
            await logAudit(client, {
                shopId: pay.shop_id, userId: null, action: "subscription.payment_reversed",
                entityType: "subscription_payment", entityId: pay.id, details: { was: pay.status }
            });
            if (pay.status === "pending") {
                await client.query(
                    "UPDATE subscription_payments SET status = 'failed', failure_reason = 'The payment was reversed.' WHERE id = $1",
                    [pay.id]
                );
            }
            return { state: "reversed", merchantRef: pay.merchant_ref };
        }

        return { state: pay.status === "successful" ? "successful" : "pending", merchantRef: pay.merchant_ref };
    });
}

/** The owner pressed "Check payment": re-ask Pesapal about one of their own pending payments. */
async function checkOwnPayment(pool, user, merchantRef) {
    const pay = (await pool.query(
        "SELECT status, provider_ref FROM subscription_payments WHERE merchant_ref = $1 AND shop_id = $2",
        [String(merchantRef || ""), user.shopId]
    )).rows[0];
    if (!pay) throw new HttpError(404, "That payment could not be found.");
    if (pay.status !== "pending" || !pay.provider_ref || !onlinePaymentsReady()) {
        return { state: pay.status === "successful" ? "successful" : pay.status === "pending" ? "pending" : "failed" };
    }
    const out = await settlePayment(pool, pay.provider_ref);
    return { state: out.state === "unknown" ? "pending" : out.state };
}

module.exports = { onlinePaymentsReady, startPayment, settlePayment, checkOwnPayment };
