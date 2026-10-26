# Duka

Simple, mobile-first shop management for retail and wholesale shops in Uganda:
sales, stock, customers, debts, suppliers, profit and reports.

Stack: Node.js + Express, PostgreSQL (`pg`), plain HTML/CSS/JavaScript in `/public`.

## Setup (on your computer)

1. Install Node.js 18+ and PostgreSQL. Create an empty database, e.g. `duka_db`.
2. In this folder run: `npm install`
3. Copy `.env.example` to `.env` and fill in your database password and a long random `JWT_SECRET`.
4. Build the tables and demo data: `npm run db:reset` (type `yes`; this deletes everything in that database)
   - Later, `npm run db:setup` safely adds anything that is missing without deleting data.
5. Check the connection: `npm run db:test`
6. Start the server: `npm run dev`, then open http://localhost:3000

Demo login: phone `0700000001`, password `demo1234` (owner). Cashier: `0700000002`.
Change these before real use.

## Folders

| Folder | What is in it |
|---|---|
| `public/` | The app people see: pages, `css/`, `js/` |
| `routes/` | One Express router per module |
| `middleware/` | Login check, error handling, rate limiting |
| `utils/` | Small helpers (phone numbers, validation, audit log) |
| `scripts/` | `setup-db.js` builds the database |
| `database.sql` | Full schema and demo data |

## How units and prices work

- Each product has a **base unit** (the smallest, e.g. Kg or Piece) and optional bigger units with a count, e.g. `Pack = 10 Piece`, `Carton = 120 Piece`.
- Stock is stored in the base unit only, so mixing units can never make stock wrong. Screens show it as "3 Cartons, 5 Pieces".
- Cost price is stored per base unit. The product form lets the shopkeeper type the cost per carton or sack and does the division.
- Prices: one retail price for the base unit (required), optional wholesale prices (with a minimum quantity) and optional prices per bigger unit. A bigger unit without its own price is sold at the base retail price multiplied by how many are inside.

## How a sale is saved (Step 4)

- One sale = one database transaction: receipt number, lines, payments, stock and the customer's debt all save together, or none do.
- Every sale (and return) carries a `clientUuid` made by the browser. Sending it twice returns the first sale, so a double tap or retry can never duplicate a sale.
- Product rows are locked while a sale is written, so two tills cannot sell the last item twice.
- Selling below cost, or taking a customer over their credit limit, needs a confirmation (the server answers with a `code` and the till asks "Sell anyway?").
- Voiding or returning never deletes anything. It adds stock movements, ledger lines and an audit entry with the reason.
- Receipt numbers are sequential per shop (`000001`, `000002`, ...). Held sales have no number until completed.
- "Today" and all date filters use Kampala time.

## Stock and purchases (Step 5)

- Stock changes only through: sales, sale voids, returns, purchases, purchase cancellations, adjustments and stock-takes. Each one writes a row in `stock_movements` (who, when, why, and the stock left).
- A purchase is one transaction: stock up, history, supplier balance and payment together. It carries a `clientUuid`, so repeating it never adds stock twice.
- `suppliers.balance` always equals the unpaid part of that supplier's active purchases. A payment is spread over the oldest unpaid purchases first.
- Money owed to a supplier from before Duka is stored as a purchase with no items (reference `OPENING`).
- A purchase with no supplier must be paid in full; its payment stays on the purchase itself.
- Cancelling a purchase takes the stock off again (refused if that stock was already sold) and never reverses cost-price updates.
- If you update an existing database, run `npm run db:setup` once: it adds two columns to `supplier_payments` and keeps your data.

## Customers, credit and repayments (Step 6)

- `customers.balance` (what they owe) only changes together with a `customer_ledger` line, in one transaction: credit sales add, payments and credit notes subtract, cancelled sales and payments reverse.
- A repayment counts against the OLDEST debt first. The age of a debt is worked out from the ledger (newest credit entries are added up backwards until they cover the balance; the oldest one needed is when the unpaid debt began), so it can never drift out of step.
- A customer is overdue when their debt is older than `overdue_days` (Settings, default 30).
- A repayment cannot be more than the customer owes. Receipt numbers for payments are `P000001`, `P000002`, ...
- Only the owner can set credit limits, record money owed from before Duka, receive repayments and cancel them. Cashiers can still add a customer at the till.
- Run `npm run db:setup` once after updating: it adds a `void_reason` column to `payments` and keeps your data.

## Profit, reports and closing (Step 7)

- **One definition of profit** (`utils/profit.js`), used by the dashboard and every report:
  sales after returns, minus the cost of the goods sold (after returned goods), is gross profit; minus expenses is net profit.
  Returns are counted on the day they came back.
- All days are Kampala days. A period is "from day" to "to day", both included.
- **Expected cash** in the drawer for a day = cash at the start (counted at the last closing) + cash from sales and debt repayments
  - cash handed back for cancelled payments and returns - cash expenses, cash supplier payments and goods bought in cash.
  Mobile Money and bank are never in the drawer.
- Cashiers only see their own sales and takings on the dashboard, and can close the day, but never see profit, cost, expenses or debts.
- PDF: the Print button opens the print window, where "Save as PDF" is available on phones and computers. Excel: CSV files open directly.
- Run `npm run db:setup` once after updating: it adds a `payment_method` column to `purchases` and keeps your data.

## Rules the code follows

- Money is whole UGX (integers). Stock is whole numbers in the smallest unit.
- Every query is parameterized. Passwords are hashed with bcrypt.
- Answers always look like `{ "success": true, "data": ... }` or `{ "success": false, "message": "..." }`.
- Inline JavaScript is blocked by the security headers: put scripts in `public/js/`.

## API overview (grows with each step)

| Method | Address | Who | What |
|---|---|---|---|
| POST | `/api/auth/register` | anyone | Create a shop and its owner |
| POST | `/api/auth/login` | anyone | Phone + password, returns a token |
| GET | `/api/auth/me` | logged in | Who am I |
| POST | `/api/auth/change-password` | logged in | Change my password |
| GET | `/api/users` | owner | List staff |
| POST | `/api/users` | owner | Add staff |
| PATCH | `/api/users/:id` | owner | Change name/role, switch on or off |
| POST | `/api/users/:id/reset-password` | owner | Set a new password |
| GET | `/api/settings` | logged in | Shop details and defaults |
| PUT | `/api/settings` | owner | Save settings |
| GET | `/api/categories` | logged in | List categories |
| POST / PATCH / DELETE | `/api/categories`, `/api/categories/:id` | owner | Add, rename, remove a category |
| GET | `/api/products` | logged in | List: `?search=&categoryId=&filter=low\|out\|expiring&status=active\|inactive&page=&limit=` (cost price only for owner) |
| GET | `/api/products/:id` | logged in | One product with units, prices, photo |
| POST | `/api/products` | owner | Add a product with units, prices, opening stock |
| PATCH | `/api/products/:id` | owner | Change any part, remove or put back (`isActive`). Not stock. |
| GET | `/api/products/export` | owner | All products as rows for a CSV (`?template=1` for the blank template) |
| POST | `/api/products/import` | owner | Add up to 300 CSV rows at a time |
| GET | `/api/customers?search=` | logged in | Find customers |
| POST | `/api/customers` | logged in | Quick-add a customer at the till |
| GET | `/api/sales/catalog` | logged in | Products for the till (`?search=`, `?barcode=`, `?ids=1,2`); never includes cost |
| POST | `/api/sales` | logged in | Complete a sale (`status:"completed"`) or hold one (`status:"held"`). Needs a `clientUuid`. |
| GET | `/api/sales` | owner: all, cashier: own | History: `?from=&to=&status=&method=&cashierId=&customerId=&search=&page=` with totals |
| GET | `/api/sales/held` | logged in | Held sales |
| DELETE | `/api/sales/held/:id` | owner / who held it | Remove a held sale |
| GET | `/api/sales/:id` | owner: any, cashier: own | One sale with items, payments, returns and receipt header |
| POST | `/api/sales/:id/void` | owner | Cancel a sale (needs a reason). Stock and debt are put back. |
| POST | `/api/sales/:id/returns` | owner | Take items back and refund (needs a `clientUuid` and a reason) |
| GET | `/api/stock/summary` | logged in | Low / out / expiring counts; stock value (cost and selling price) for the owner |
| GET | `/api/stock/movements` | owner | The log of every change to stock (`?productId=&type=&from=&to=&page=`) |
| POST | `/api/stock/adjustments` | owner | Take out damaged / expired / lost stock, or add found stock (needs `clientUuid`) |
| POST | `/api/stock/stock-take` | owner | Set stock to what was counted on the shelf (needs `clientUuid`) |
| GET / POST / PATCH | `/api/suppliers`, `/api/suppliers/:id` | owner | Suppliers and what you owe them |
| POST | `/api/suppliers/:id/payments` | owner | Pay a supplier; spread over the oldest unpaid purchases first |
| POST | `/api/suppliers/:id/payments/:pid/void` | owner | Cancel a wrong payment |
| GET | `/api/purchases`, `/api/purchases/:id` | owner | Purchases with totals; one purchase with items and payments |
| POST | `/api/purchases` | owner | Record stock received (cash, part-paid or on credit; needs `clientUuid`) |
| POST | `/api/purchases/:id/void` | owner | Cancel a purchase made by mistake |
| GET | `/api/customers/overview` | owner | Debtors list: `?filter=all\|owing\|overdue&sort=balance\|oldest\|name&search=` with totals |
| GET / PATCH | `/api/customers/:id` | owner | Profile with debt ledger and age of debt; change details, credit limit, switch off |
| POST | `/api/customers/:id/payments` | owner | Receive a repayment (needs `clientUuid`); gives a payment receipt number |
| GET | `/api/customers/:id/payments/:pid` | owner | One payment with its receipt data |
| POST | `/api/customers/:id/payments/:pid/void` | owner | Cancel a wrong payment |
| GET | `/api/dashboard` | logged in | Today at a glance. Owner: whole shop with profit, debts, best sellers, chart. Cashier: own sales only. |
| GET / POST | `/api/expenses` | owner | Expenses for a period with totals by category; record one (needs `clientUuid`) |
| POST | `/api/expenses/:id/void` | owner | Cancel a wrong expense |
| GET / POST / PATCH / DELETE | `/api/expenses/categories` | owner | Expense categories |
| GET | `/api/reports/summary` | owner | Profit and loss, money received, retail vs wholesale, cashiers, daily sales (`?from=&to=`) |
| GET | `/api/reports/products` | owner | Profit per product and category, fast and slow sellers (`?sort=profit\|revenue\|quantity\|name`) |
| GET | `/api/closings/preview?date=` | logged in | Cash that should be in the drawer for a day |
| POST | `/api/closings` | logged in | Save the counted cash (the owner may correct a closed day) |
| GET | `/api/closings` | owner | Past closings |
| GET | `/health` | anyone | Server check |

Send the token as `Authorization: Bearer <token>`.
