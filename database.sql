-- =====================================================================
-- DUKA DATABASE  (schema v2)
-- Run with:   npm run db:setup      (safe to re-run; skips what exists)
-- Fresh start: npm run db:reset     (DELETES everything, then rebuilds)
--
-- RULES USED THROUGHOUT
--  * Money  = whole UGX stored as BIGINT (no decimals, ever).
--  * Stock  = whole numbers in the product's SMALLEST (base) unit.
--             Example: sugar base unit is "Kg", so 1 sack of 50kg = 50.
--  * Every table has created_at and updated_at (updated_at is automatic).
--  * shop_id is on all key tables so branches can be added later.
--  * Phone numbers are stored as digits only, with country code,
--    e.g. 256772123456 (the app will convert 0772123456 to this).
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- used only to hash the demo passwords

-- ---------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------

-- Keeps updated_at correct without the app having to remember.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- 1. SHOPS (the business / each branch)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shops (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name                 VARCHAR(150) NOT NULL,
    address              TEXT,
    phone                VARCHAR(30),
    tin                  VARCHAR(30),                 -- optional Tax ID
    logo                 TEXT,                        -- small image as data URL
    receipt_footer       VARCHAR(300) NOT NULL DEFAULT 'Thank you for shopping with us!',
    receipt_paper        VARCHAR(10)  NOT NULL DEFAULT '80mm'
                         CHECK (receipt_paper IN ('58mm', '80mm', 'A4')),
    allow_negative_stock BOOLEAN NOT NULL DEFAULT FALSE,
    currency             CHAR(3) NOT NULL DEFAULT 'UGX',
    is_active            BOOLEAN NOT NULL DEFAULT TRUE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- 2. USERS (login is by phone number)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shop_id       BIGINT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
    full_name     VARCHAR(150) NOT NULL,
    phone         VARCHAR(15)  NOT NULL UNIQUE
                  CHECK (phone ~ '^[0-9]{9,15}$'),
    password_hash TEXT NOT NULL,
    role          VARCHAR(20) NOT NULL DEFAULT 'cashier'
                  CHECK (role IN ('owner', 'cashier')),
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    last_login_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- 3. CATEGORIES
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shop_id    BIGINT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
    name       VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (shop_id, name)
);

-- ---------------------------------------------------------------------
-- 4. PRODUCTS
--    cost_price = cost of ONE BASE UNIT.   stock_base = stock in base units.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shop_id       BIGINT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
    category_id   BIGINT REFERENCES categories(id) ON DELETE SET NULL,
    name          VARCHAR(200) NOT NULL,
    barcode       VARCHAR(60),
    sku           VARCHAR(60),
    cost_price    BIGINT NOT NULL DEFAULT 0 CHECK (cost_price >= 0),
    reorder_level BIGINT NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
    stock_base    BIGINT NOT NULL DEFAULT 0,   -- may go below 0 only if the shop allows it
    expiry_date   DATE,
    photo         TEXT,                        -- small image as data URL
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Refuse negative stock unless the shop's setting allows it.
-- This is the last line of defence: even a bug in the app cannot oversell.
CREATE OR REPLACE FUNCTION enforce_stock_rule() RETURNS trigger AS $$
BEGIN
    IF NEW.stock_base < 0
       AND NOT (SELECT allow_negative_stock FROM shops WHERE id = NEW.shop_id) THEN
        RAISE EXCEPTION 'Not enough stock for "%" (would become %)', NEW.name, NEW.stock_base
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_products_stock_rule ON products;
CREATE TRIGGER trg_products_stock_rule
    BEFORE INSERT OR UPDATE OF stock_base ON products
    FOR EACH ROW EXECUTE FUNCTION enforce_stock_rule();

-- ---------------------------------------------------------------------
-- 5. PRODUCT UNITS  (carton / pack / piece ...)
--    factor_to_base = how many BASE units are in one of this unit.
--    The base unit itself is a row with factor 1 (exactly one per product).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_units (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id     BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    name           VARCHAR(50) NOT NULL,
    factor_to_base INTEGER NOT NULL CHECK (factor_to_base >= 1),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (product_id, name)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_one_base_unit
    ON product_units (product_id) WHERE factor_to_base = 1;

-- ---------------------------------------------------------------------
-- 6. CUSTOMERS
--    balance = money the customer owes us (cached; customer_ledger is the proof)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shop_id       BIGINT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
    name          VARCHAR(150) NOT NULL,
    phone         VARCHAR(15) CHECK (phone IS NULL OR phone ~ '^[0-9]{9,15}$'),
    location      VARCHAR(150),
    customer_type VARCHAR(10) NOT NULL DEFAULT 'retail'
                  CHECK (customer_type IN ('retail', 'wholesale')),
    credit_limit  BIGINT CHECK (credit_limit IS NULL OR credit_limit >= 0),
    notes         TEXT,
    balance       BIGINT NOT NULL DEFAULT 0,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- 7. PRODUCT PRICES  (retail / wholesale / special, per unit)
--    min_qty: price applies when quantity sold is at least this much.
--    customer_id: only for 'special' prices set for one customer.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_prices (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id  BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    unit_id     BIGINT NOT NULL REFERENCES product_units(id) ON DELETE CASCADE,
    level       VARCHAR(10) NOT NULL CHECK (level IN ('retail', 'wholesale', 'special')),
    price       BIGINT NOT NULL CHECK (price >= 0),
    min_qty     INTEGER NOT NULL DEFAULT 1 CHECK (min_qty >= 1),
    customer_id BIGINT REFERENCES customers(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_price
    ON product_prices (product_id, unit_id, level, min_qty, COALESCE(customer_id, 0));

-- ---------------------------------------------------------------------
-- 8. SUPPLIERS
--    balance = money WE owe the supplier (cached)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suppliers (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shop_id           BIGINT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
    name              VARCHAR(150) NOT NULL,
    phone             VARCHAR(15) CHECK (phone IS NULL OR phone ~ '^[0-9]{9,15}$'),
    products_supplied TEXT,
    notes             TEXT,
    balance           BIGINT NOT NULL DEFAULT 0,
    is_active         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- 9. RECEIPT COUNTERS  (gap-free sequential numbers per shop)
--    The app locks the row (SELECT ... FOR UPDATE) inside the sale transaction.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS receipt_counters (
    shop_id      BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    counter_type VARCHAR(20) NOT NULL CHECK (counter_type IN ('sale', 'payment')),
    last_number  BIGINT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (shop_id, counter_type)
);

-- ---------------------------------------------------------------------
-- 10. SALES
--     client_uuid = made by the phone/browser. Sending the same sale twice
--     (double tap, retry, offline sync) can never create two sales.
--     status 'held' = parked sale to resume later (no stock taken yet).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shop_id          BIGINT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
    client_uuid      UUID NOT NULL,
    receipt_number   VARCHAR(40),                  -- filled when the sale is completed
    temp_receipt_ref VARCHAR(40),                  -- offline temporary number, mapped on sync
    customer_id      BIGINT REFERENCES customers(id) ON DELETE SET NULL,  -- NULL = Walk-in
    sale_type        VARCHAR(10) NOT NULL DEFAULT 'retail'
                     CHECK (sale_type IN ('retail', 'wholesale')),
    status           VARCHAR(10) NOT NULL DEFAULT 'completed'
                     CHECK (status IN ('held', 'completed', 'voided')),
    subtotal         BIGINT NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
    discount_amount  BIGINT NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
    total_amount     BIGINT NOT NULL CHECK (total_amount >= 0),
    amount_paid      BIGINT NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
    balance_due      BIGINT NOT NULL DEFAULT 0 CHECK (balance_due >= 0),  -- becomes customer debt
    cogs             BIGINT NOT NULL DEFAULT 0 CHECK (cogs >= 0),         -- cost of goods sold
    served_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
    notes            TEXT,
    voided_at        TIMESTAMPTZ,
    voided_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
    void_reason      TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (shop_id, client_uuid),
    UNIQUE (shop_id, receipt_number),
    CHECK (total_amount = subtotal - discount_amount),
    CHECK (amount_paid + balance_due = total_amount),
    CHECK (status <> 'voided' OR void_reason IS NOT NULL)
);

-- Lines on a sale. Names/units are copied so old receipts never change
-- even if the product is renamed later.
CREATE TABLE IF NOT EXISTS sale_items (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sale_id        BIGINT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    product_id     BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    unit_id        BIGINT NOT NULL REFERENCES product_units(id) ON DELETE RESTRICT,
    product_name   VARCHAR(200) NOT NULL,
    unit_name      VARCHAR(50)  NOT NULL,
    quantity       INTEGER NOT NULL CHECK (quantity > 0),          -- in the unit sold
    factor_to_base INTEGER NOT NULL CHECK (factor_to_base >= 1),
    quantity_base  BIGINT  NOT NULL CHECK (quantity_base > 0),     -- what stock is reduced by
    unit_price     BIGINT  NOT NULL CHECK (unit_price >= 0),       -- price per unit sold
    line_total     BIGINT  NOT NULL CHECK (line_total >= 0),
    cost_total     BIGINT  NOT NULL DEFAULT 0 CHECK (cost_total >= 0),  -- cost of this line
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Returns / refunds on a completed sale (one row per returned line).
CREATE TABLE IF NOT EXISTS sale_returns (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shop_id       BIGINT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
    client_uuid   UUID NOT NULL,
    sale_id       BIGINT NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
    sale_item_id  BIGINT NOT NULL REFERENCES sale_items(id) ON DELETE RESTRICT,
    quantity      INTEGER NOT NULL CHECK (quantity > 0),
    quantity_base BIGINT  NOT NULL CHECK (quantity_base > 0),
    refund_amount BIGINT  NOT NULL CHECK (refund_amount >= 0),
    refund_method VARCHAR(15) NOT NULL DEFAULT 'cash'
                  CHECK (refund_method IN ('cash', 'mobile_money', 'bank', 'credit_note')),
    reason        TEXT NOT NULL,
    created_by    BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (shop_id, client_uuid)
);

-- ---------------------------------------------------------------------
-- 11. PAYMENTS  (money received from customers)
--     Split payments = several rows for one sale.
--     'Credit' is NOT a payment method: it is the unpaid balance_due on the sale.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shop_id         BIGINT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
    client_uuid     UUID NOT NULL,
    kind            VARCHAR(15) NOT NULL
                    CHECK (kind IN ('sale_payment', 'debt_payment')),
    sale_id         BIGINT REFERENCES sales(id) ON DELETE RESTRICT,
    customer_id     BIGINT REFERENCES customers(id) ON DELETE RESTRICT,
    amount          BIGINT NOT NULL CHECK (amount > 0),
    method          VARCHAR(15) NOT NULL CHECK (method IN ('cash', 'mobile_money', 'bank')),
    mobile_provider VARCHAR(10) CHECK (mobile_provider IS NULL OR mobile_provider IN ('mtn', 'airtel')),
    reference       VARCHAR(80),                 -- mobile money / bank reference
    receipt_number  VARCHAR(40),                 -- for debt payment receipts
    note            TEXT,
    received_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
    paid_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    voided_at       TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (shop_id, client_uuid)
);

-- ---------------------------------------------------------------------
-- 12. CUSTOMER LEDGER  (the running debt book, never edited, only added to)
--     amount: POSITIVE = customer owes us more, NEGATIVE = customer owes less.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_ledger (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shop_id       BIGINT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
    customer_id   BIGINT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    entry_type    VARCHAR(20) NOT NULL
                  CHECK (entry_type IN ('opening_balance', 'credit_sale', 'payment',
                                        'void_reversal', 'refund', 'adjustment')),
    amount        BIGINT NOT NULL CHECK (amount <> 0),
    balance_after BIGINT NOT NULL,
    sale_id       BIGINT REFERENCES sales(id) ON DELETE SET NULL,
    payment_id    BIGINT REFERENCES payments(id) ON DELETE SET NULL,
    note          TEXT,
    created_by    BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- 13. PURCHASES (stock bought from suppliers, maybe on credit)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchases (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shop_id       BIGINT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
    client_uuid   UUID NOT NULL,
    supplier_id   BIGINT REFERENCES suppliers(id) ON DELETE RESTRICT,
    reference_no  VARCHAR(60),                   -- supplier's invoice / delivery note
    purchase_date DATE NOT NULL DEFAULT CURRENT_DATE,
    total_cost    BIGINT NOT NULL CHECK (total_cost >= 0),
    amount_paid   BIGINT NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
    balance_due   BIGINT NOT NULL DEFAULT 0 CHECK (balance_due >= 0),  -- what we owe
    status        VARCHAR(10) NOT NULL DEFAULT 'completed'
                  CHECK (status IN ('completed', 'voided')),
    note          TEXT,
    void_reason   TEXT,
    created_by    BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (shop_id, client_uuid),
    CHECK (amount_paid + balance_due = total_cost)
);

CREATE TABLE IF NOT EXISTS purchase_items (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    purchase_id    BIGINT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
    product_id     BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    unit_id        BIGINT NOT NULL REFERENCES product_units(id) ON DELETE RESTRICT,
    unit_name      VARCHAR(50) NOT NULL,
    quantity       INTEGER NOT NULL CHECK (quantity > 0),
    factor_to_base INTEGER NOT NULL CHECK (factor_to_base >= 1),
    quantity_base  BIGINT  NOT NULL CHECK (quantity_base > 0),
    unit_cost      BIGINT  NOT NULL CHECK (unit_cost >= 0),   -- cost per unit bought
    line_total     BIGINT  NOT NULL CHECK (line_total >= 0),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cost history: shows how a product's cost price changed over time.
CREATE TABLE IF NOT EXISTS product_cost_history (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id  BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    cost_price  BIGINT NOT NULL CHECK (cost_price >= 0),   -- per base unit
    purchase_id BIGINT REFERENCES purchases(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Payments WE make to suppliers (partial payments allowed).
CREATE TABLE IF NOT EXISTS supplier_payments (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shop_id     BIGINT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
    client_uuid UUID NOT NULL,
    supplier_id BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
    purchase_id BIGINT REFERENCES purchases(id) ON DELETE SET NULL,
    amount      BIGINT NOT NULL CHECK (amount > 0),
    method      VARCHAR(15) NOT NULL CHECK (method IN ('cash', 'mobile_money', 'bank')),
    reference   VARCHAR(80),
    note        TEXT,
    paid_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
    paid_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (shop_id, client_uuid)
);

-- Added in Step 6: a cancelled customer payment keeps its reason.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS void_reason TEXT;

-- Added in Step 5: a wrong supplier payment is cancelled (kept, marked), never deleted.
ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS voided_at  TIMESTAMPTZ;
ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS void_reason TEXT;

-- ---------------------------------------------------------------------
-- 14. STOCK MOVEMENTS (full history: every change to stock is one row)
--     quantity_change is in BASE units: + stock in, - stock out.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_movements (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shop_id         BIGINT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
    product_id      BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    movement_type   VARCHAR(20) NOT NULL
                    CHECK (movement_type IN ('opening', 'purchase', 'purchase_void', 'sale',
                                             'sale_void', 'return', 'adjustment', 'stock_take')),
    quantity_change BIGINT NOT NULL CHECK (quantity_change <> 0),
    stock_after     BIGINT NOT NULL,
    ref_type        VARCHAR(30),                 -- e.g. 'sale', 'purchase', 'adjustment'
    ref_id          BIGINT,
    note            TEXT,
    created_by      BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Manual adjustments and stock-take results, with a reason.
CREATE TABLE IF NOT EXISTS stock_adjustments (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shop_id         BIGINT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
    client_uuid     UUID NOT NULL,
    product_id      BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    quantity_change BIGINT NOT NULL CHECK (quantity_change <> 0),   -- base units
    system_qty      BIGINT,                      -- what the system said (stock-take)
    counted_qty     BIGINT,                      -- what was physically counted (stock-take)
    reason          VARCHAR(15) NOT NULL
                    CHECK (reason IN ('damaged', 'expired', 'lost', 'counted', 'found', 'other')),
    note            TEXT,
    created_by      BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (shop_id, client_uuid)
);

-- ---------------------------------------------------------------------
-- 15. EXPENSES
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expense_categories (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shop_id    BIGINT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
    name       VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (shop_id, name)
);

CREATE TABLE IF NOT EXISTS expenses (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shop_id        BIGINT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
    client_uuid    UUID NOT NULL,
    category_id    BIGINT REFERENCES expense_categories(id) ON DELETE SET NULL,
    amount         BIGINT NOT NULL CHECK (amount > 0),
    description    VARCHAR(300),
    payment_method VARCHAR(15) NOT NULL DEFAULT 'cash'
                   CHECK (payment_method IN ('cash', 'mobile_money', 'bank')),
    expense_date   DATE NOT NULL DEFAULT CURRENT_DATE,
    created_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
    voided_at      TIMESTAMPTZ,
    void_reason    TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (shop_id, client_uuid)
);

-- ---------------------------------------------------------------------
-- 16. END-OF-DAY CLOSING (expected cash vs counted cash)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS day_closings (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shop_id       BIGINT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
    closing_date  DATE NOT NULL,
    expected_cash BIGINT NOT NULL,
    counted_cash  BIGINT NOT NULL CHECK (counted_cash >= 0),
    difference    BIGINT NOT NULL,               -- counted - expected (negative = missing money)
    note          TEXT,
    closed_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (shop_id, closing_date)
);

-- ---------------------------------------------------------------------
-- 17. AUDIT LOG (who did what; voids and edits are recorded here)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shop_id     BIGINT REFERENCES shops(id) ON DELETE SET NULL,
    user_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,
    action      VARCHAR(60) NOT NULL,            -- e.g. 'sale.void', 'stock.adjust'
    entity_type VARCHAR(40),
    entity_id   BIGINT,
    details     JSONB,
    ip_address  VARCHAR(60),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- 18. SETTINGS (simple key/value per shop: language, low-stock default...)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shop_id    BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    key        VARCHAR(60) NOT NULL,
    value      TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (shop_id, key)
);

-- ---------------------------------------------------------------------
-- 19. SYNC QUEUE (groundwork for offline sales, Phase 2)
--     Each offline record arrives here first with its client_uuid, so
--     repeating a sync can never duplicate or lose anything.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_queue (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shop_id       BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    client_uuid   UUID NOT NULL,
    user_id       BIGINT REFERENCES users(id) ON DELETE SET NULL,
    entity_type   VARCHAR(30) NOT NULL
                  CHECK (entity_type IN ('sale', 'payment', 'customer', 'expense')),
    payload       JSONB NOT NULL,
    status        VARCHAR(10) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'applied', 'failed', 'conflict')),
    error_message TEXT,
    attempts      INTEGER NOT NULL DEFAULT 0,
    received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (shop_id, client_uuid)
);

-- ---------------------------------------------------------------------
-- INDEXES (for the things shopkeepers search and filter by most)
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_users_shop            ON users (shop_id);
CREATE INDEX IF NOT EXISTS idx_products_shop         ON products (shop_id, is_active);
CREATE INDEX IF NOT EXISTS idx_products_name         ON products (shop_id, LOWER(name) text_pattern_ops);
CREATE UNIQUE INDEX IF NOT EXISTS uq_products_barcode ON products (shop_id, barcode) WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_category     ON products (category_id);
CREATE INDEX IF NOT EXISTS idx_product_units_product ON product_units (product_id);
CREATE INDEX IF NOT EXISTS idx_product_prices_lookup ON product_prices (product_id, unit_id);
CREATE INDEX IF NOT EXISTS idx_customers_shop_name   ON customers (shop_id, LOWER(name) text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_customers_phone       ON customers (shop_id, phone);
CREATE INDEX IF NOT EXISTS idx_suppliers_shop        ON suppliers (shop_id);
CREATE INDEX IF NOT EXISTS idx_sales_shop_date       ON sales (shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_customer        ON sales (customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_served_by       ON sales (served_by);
CREATE INDEX IF NOT EXISTS idx_sales_debt            ON sales (shop_id, customer_id) WHERE balance_due > 0 AND status = 'completed';
CREATE INDEX IF NOT EXISTS idx_sale_items_sale       ON sale_items (sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_product    ON sale_items (product_id);
CREATE INDEX IF NOT EXISTS idx_payments_shop_date    ON payments (shop_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_customer     ON payments (customer_id);
CREATE INDEX IF NOT EXISTS idx_payments_sale         ON payments (sale_id);
CREATE INDEX IF NOT EXISTS idx_ledger_customer       ON customer_ledger (customer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_purchases_shop_date   ON purchases (shop_id, purchase_date DESC);
CREATE INDEX IF NOT EXISTS idx_purchases_supplier    ON purchases (supplier_id);
CREATE INDEX IF NOT EXISTS idx_purchase_items_purch  ON purchase_items (purchase_id);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_sup ON supplier_payments (supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_purchase ON supplier_payments (purchase_id);
CREATE INDEX IF NOT EXISTS idx_stock_mv_product      ON stock_movements (product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_mv_shop_date    ON stock_movements (shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_shop_date    ON expenses (shop_id, expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_audit_shop_date       ON audit_log (shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_queue_pending    ON sync_queue (shop_id, status) WHERE status <> 'applied';

-- ---------------------------------------------------------------------
-- Attach the automatic updated_at trigger to every table that has it
-- ---------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
    FOR t IN
        SELECT c.table_name
        FROM information_schema.columns c
        JOIN information_schema.tables tb
          ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
        WHERE c.table_schema = 'public'
          AND c.column_name = 'updated_at'
          AND tb.table_type = 'BASE TABLE'
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_updated_at ON %I', t, t);
        EXECUTE format(
            'CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON %I
             FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
    END LOOP;
END $$;

-- =====================================================================
-- DEMO DATA  (only inserted when the database has no shops yet)
-- Demo logins:  phone 0700000001 (Owner)  /  0700000002 (Cashier)
-- Demo password for both: demo1234   -> CHANGE IT before real use!
-- =====================================================================
DO $$
DECLARE
    v_shop  BIGINT;
    v_owner BIGINT;
BEGIN
    IF EXISTS (SELECT 1 FROM shops) THEN
        RAISE NOTICE 'Demo data skipped: shops already exist.';
        RETURN;
    END IF;

    INSERT INTO shops (name, address, phone, receipt_footer)
    VALUES ('Nakawa General Stores', 'Plot 12, Port Bell Road, Nakawa, Kampala',
            '0700 000 000', 'Thank you for shopping with us! Goods sold are not returnable after 24 hours.')
    RETURNING id INTO v_shop;

    INSERT INTO users (shop_id, full_name, phone, password_hash, role)
    VALUES (v_shop, 'Demo Owner', '256700000001', crypt('demo1234', gen_salt('bf', 10)), 'owner')
    RETURNING id INTO v_owner;

    INSERT INTO users (shop_id, full_name, phone, password_hash, role)
    VALUES (v_shop, 'Demo Cashier', '256700000002', crypt('demo1234', gen_salt('bf', 10)), 'cashier');

    INSERT INTO categories (shop_id, name)
    VALUES (v_shop, 'Groceries'), (v_shop, 'Drinks'), (v_shop, 'Household');

    -- Products: cost_price is per BASE unit, stock_base is in BASE units.
    INSERT INTO products (shop_id, category_id, name, cost_price, reorder_level, stock_base)
    SELECT v_shop, c.id, v.name, v.cost, v.reorder, v.stock
    FROM (VALUES
        ('Sugar',           'Groceries', 4200,  20, 150),   -- Kg
        ('Cooking Oil 1L',  'Groceries', 7500,  12,  60),   -- bottles
        ('Laundry Soap',    'Household', 1200,  30, 240),   -- pieces
        ('Rice',            'Groceries', 3800,  20, 100),   -- Kg
        ('Soda 500ml',      'Drinks',    1500,  24,  96),   -- bottles
        ('Maize Flour',     'Groceries', 2800,  20,  80)    -- Kg
    ) AS v(name, cat, cost, reorder, stock)
    JOIN categories c ON c.shop_id = v_shop AND c.name = v.cat;

    -- Units: the base unit has factor 1; bigger units say how many base units they hold.
    INSERT INTO product_units (product_id, name, factor_to_base)
    SELECT p.id, v.unit, v.factor
    FROM (VALUES
        ('Sugar',          'Kg',            1),
        ('Sugar',          'Sack (50kg)',  50),
        ('Cooking Oil 1L', 'Bottle',        1),
        ('Cooking Oil 1L', 'Carton (12)',  12),
        ('Laundry Soap',   'Piece',         1),
        ('Laundry Soap',   'Pack (10)',    10),
        ('Laundry Soap',   'Carton (12 packs)', 120),
        ('Rice',           'Kg',            1),
        ('Rice',           'Sack (50kg)',  50),
        ('Soda 500ml',     'Bottle',        1),
        ('Soda 500ml',     'Crate (24)',   24),
        ('Maize Flour',    'Kg',            1),
        ('Maize Flour',    'Sack (50kg)',  50)
    ) AS v(pname, unit, factor)
    JOIN products p ON p.shop_id = v_shop AND p.name = v.pname;

    -- Prices per unit. min_qty on wholesale = "wholesale price applies from this quantity".
    INSERT INTO product_prices (product_id, unit_id, level, price, min_qty)
    SELECT p.id, u.id, v.level, v.price, v.min_qty
    FROM (VALUES
        ('Sugar',          'Kg',            'retail',     5000,   1),
        ('Sugar',          'Kg',            'wholesale',  4700,  10),
        ('Sugar',          'Sack (50kg)',   'wholesale', 225000,  1),
        ('Cooking Oil 1L', 'Bottle',        'retail',     9000,   1),
        ('Cooking Oil 1L', 'Bottle',        'wholesale',  8500,   6),
        ('Cooking Oil 1L', 'Carton (12)',   'wholesale', 100000,  1),
        ('Laundry Soap',   'Piece',         'retail',     1500,   1),
        ('Laundry Soap',   'Pack (10)',     'retail',    14000,   1),
        ('Laundry Soap',   'Pack (10)',     'wholesale', 13500,   1),
        ('Laundry Soap',   'Carton (12 packs)', 'wholesale', 155000, 1),
        ('Rice',           'Kg',            'retail',     4500,   1),
        ('Rice',           'Kg',            'wholesale',  4200,  10),
        ('Rice',           'Sack (50kg)',   'wholesale', 205000,  1),
        ('Soda 500ml',     'Bottle',        'retail',     2000,   1),
        ('Soda 500ml',     'Crate (24)',    'wholesale',  42000,  1),
        ('Maize Flour',    'Kg',            'retail',     3300,   1),
        ('Maize Flour',    'Kg',            'wholesale',  3000,  10),
        ('Maize Flour',    'Sack (50kg)',   'wholesale', 145000,  1)
    ) AS v(pname, unit, level, price, min_qty)
    JOIN products p       ON p.shop_id = v_shop AND p.name = v.pname
    JOIN product_units u  ON u.product_id = p.id AND u.name = v.unit;

    -- Record the opening stock in the stock history.
    INSERT INTO stock_movements (shop_id, product_id, movement_type, quantity_change,
                                 stock_after, ref_type, note, created_by)
    SELECT v_shop, id, 'opening', stock_base, stock_base, 'opening', 'Opening stock', v_owner
    FROM products WHERE shop_id = v_shop AND stock_base > 0;

    INSERT INTO product_cost_history (product_id, cost_price)
    SELECT id, cost_price FROM products WHERE shop_id = v_shop;

    -- Customers (Mukasa John already owes UGX 85,000 from before)
    INSERT INTO customers (shop_id, name, phone, location, customer_type, credit_limit, balance, notes)
    VALUES
        (v_shop, 'Nakato Sarah',          '256700000101', 'Kawempe',      'retail',    100000,      0, NULL),
        (v_shop, 'Kato Wholesale Traders','256700000102', 'Owino Market', 'wholesale', 2000000,     0, 'Buys sacks and cartons'),
        (v_shop, 'Mukasa John',           '256700000103', 'Bukoto',       'retail',    200000,  85000, 'Pays at month end');

    INSERT INTO customer_ledger (shop_id, customer_id, entry_type, amount, balance_after, note, created_by)
    SELECT v_shop, id, 'opening_balance', 85000, 85000, 'Debt brought forward', v_owner
    FROM customers WHERE shop_id = v_shop AND name = 'Mukasa John';

    -- Suppliers
    INSERT INTO suppliers (shop_id, name, phone, products_supplied)
    VALUES
        (v_shop, 'Owino Market Wholesalers', '256700000201', 'Sugar, rice, maize flour'),
        (v_shop, 'Nile Beverages Depot',     '256700000202', 'Sodas, water, juice'),
        (v_shop, 'Ndeeba Household Supplies','256700000203', 'Soap, cooking oil, detergents');

    -- Expense categories
    INSERT INTO expense_categories (shop_id, name)
    VALUES (v_shop, 'Rent'), (v_shop, 'Transport'), (v_shop, 'Electricity'),
           (v_shop, 'Wages'), (v_shop, 'Airtime'), (v_shop, 'Water'),
           (v_shop, 'Packaging'), (v_shop, 'Other');

    -- Starter settings
    INSERT INTO settings (shop_id, key, value)
    VALUES (v_shop, 'language', 'en'),
           (v_shop, 'low_stock_default', '10');
END $$;
