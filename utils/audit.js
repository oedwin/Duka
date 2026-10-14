// utils/audit.js - writes "who did what" to audit_log.
// `db` can be the pool or a transaction client, so the log entry is saved
// (or undone) together with the change itself.
async function logAudit(db, { shopId, userId, action, entityType, entityId, details, ip }) {
    await db.query(
        `INSERT INTO audit_log (shop_id, user_id, action, entity_type, entity_id, details, ip_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
            shopId || null,
            userId || null,
            action,
            entityType || null,
            entityId || null,
            details ? JSON.stringify(details) : null,
            ip || null
        ]
    );
}

module.exports = { logAudit };
