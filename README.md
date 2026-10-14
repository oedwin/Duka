# Duka

Simple, mobile-first shop management for retail and wholesale shops in Uganda:
sales, stock, customers, debts, suppliers, profit and reports.

Stack: Node.js + Express, PostgreSQL (`pg`), plain HTML/CSS/JavaScript in `/public`.

## Setup (on your computer)

1. Install Node.js 18+ and PostgreSQL. Create an empty database, e.g. `duka_db`.
2. In this folder run: `npm install`
3. Build the tables and demo data: `npm run db:reset` (type `yes`; this deletes everything in that database)
   - Later, `npm run db:setup` safely adds anything that is missing without deleting data.
4. Check the connection: `npm run db:test`
5. Start the server: `npm run dev`, then open http://localhost:3000

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
| GET | `/health` | anyone | Server check |

Send the token as `Authorization: Bearer <token>`.
