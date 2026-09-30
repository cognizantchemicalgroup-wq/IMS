# CCPL ERP — Cognizant Chemical Pvt. Ltd.

Static web app (HTML + JavaScript modules) on **Firebase** (Authentication, Firestore, Storage).
No build step: every page is a plain `.html` file with one script in `js/`.

## What's in it

| Area | Page | Script |
|---|---|---|
| Sign in (email + password, only listed users) | `index.html` | `js/login.js` |
| Dashboard | `dashboard.html` | `js/dashboard.js` |
| Exceptions — only what needs attention (overdue POs, GRN waiting for Kanta, Kanta short/excess, invoice ≠ payable, partial POs, manual stock entries) | `exceptions.html` | `js/exceptions.js`, `js/exceptions-data.js` |
| Purchase Orders — create, PDF, item-wise PO / GRN / Kanta / Short-Excess / Inward / Pending / Payable, close | `purchase-orders.html` | `js/purchase-orders.js` |
| Invoice → GRN → Kanta → stock inward (multi-item invoices; Kanta is final and payable) | `inward.html` | `js/inward.js` |
| Vendors & Customers (one shared list) and Items & Packaging — Excel template, import (also accepts Zoho Books exports), export | `parties.html`, `items.html` | `js/masters.js` |
| Quotations → Sales Orders | `quotations.html`, `sales-orders.html` | `js/sales-docs.js` |
| Outward / Dispatch (deducts product **and** drums/carboys/bottles) + Delivery Challan PDF | `outward.html` | `js/outward.js` |
| Stock by warehouse + item ledger + **Add Existing / Opening Stock** | `inventory.html` | `js/inventory.js` |
| Stock transfer between warehouses (in transit → received, transit loss) | `transfers.html` | `js/transfers.js` |
| Write-off / adjustment (damaged, destroyed, count correction; admin can delete/reverse) | `adjustments.html` | `js/adjustments.js` |
| Activity log (who did what, to the second; cannot be edited) | `activity.html` | `js/activity.js` |
| Settings: company legal details, warehouses, number formats (e.g. CCPL/PO/26-27/001), users & roles | `settings.html` | `js/settings.js` |
| Access Audit — logins, last active, logout, who did GRN / Kanta and GRN→Kanta time (**only rupesh.mudliar@cognizantchemical.com**) | `access.html` | `js/access.js` |

Shared code: `js/core.js` (login guard, layout, GST maths, numbering, **stock engine**, activity log),
`js/pdf.js` (PO / Quotation / SO / Challan PDF layout), `js/line-editor.js`, `js/uploads.js`, `css/app.css` (theme).

Security: `firestore.rules` and `storage.rules`. Nobody can read or write anything unless they are signed in
**and** have an active profile in `users/{uid}`. The activity log and stock ledger cannot be edited or deleted by anyone.

Warehouses: **PG-106, PG-153, Breeze, Taloja Unit** (edit addresses in Settings).

## How PO quantities are tracked

Flow: **PO → Invoice / Receipt → GRN → Kanta → Stock inward → Payable quantity.**
GRN records what physically arrived; **Kanta is the final truth** — only the Kanta quantity goes into stock and is payable.
One invoice can carry several PO items, and a PO can receive any number of invoices until every item is complete.

| Item | PO Qty | GRN Qty | Kanta Qty | Short/Excess | Inward | Pending |
|---|---|---|---|---|---|---|
| Apple | 10 kg | 5 kg | 5 kg | 0 | 5 kg | 5 kg |
| Methanol | 20,000 kg | 10,000 kg | 9,970 kg | −30 kg | 9,970 kg | 10,030 kg |

PO statuses: **Open → Partially Received** (invoice entered) **→ Awaiting Kanta** (GRN done) **→ Partially Inwarded → Completed**,
or **Closed** (manager closes a PO that will not be fully supplied, with a reason) / **Cancelled**.
A PO completes automatically within the tolerance in Settings (default 0.5 %).

Document numbers are issued automatically from the format set in Settings and are **never repeated** — every issued number
is registered, so if a counter is set back by mistake the system skips to the next free number.

PDFs carry "System Generated Document — No Signature Required." instead of a signature box.

## First-time setup (live Firebase project `ccpl-ims`)

1. Install [Node.js 20+](https://nodejs.org), then in this folder run `npm install`.
2. Firebase console → *Authentication → Sign-in method*: enable **Email/Password** only (disable Google if not needed).
   Also turn on *Settings → User actions → Email enumeration protection*.
3. Firebase console → *Project settings → Service accounts → Generate new private key*. Save it in this folder as
   `service-account.json` (it is git-ignored — never commit it).
4. Copy `admin/users.example.json` to `admin/users.json` and put the passwords in (git-ignored).
5. Lock the database and create the logins, company details, 4 warehouses and packaging items — one command:
   ```bash
   GOOGLE_APPLICATION_CREDENTIALS=./service-account.json npm run golive
   ```
   (`npm run deploy:rules` alone publishes only the security rules.) Afterwards you can delete the key in the
   Firebase console (*Service accounts → Manage keys*) — it is only needed again for these scripts.
6. The site itself is hosted on **Vercel** from this GitHub repo: every pull request gets a preview link (posted on
   the PR by the Vercel bot) and merging into `main` updates the live site. `vercel.json` / `.vercelignore` keep the
   admin scripts and tests off the public site.
7. Sign in → Settings: set the next PO number (e.g. 824 to continue after CCPL/PG/823/26-27), fill Breeze and Taloja
   addresses and bank details.

After that, add or deactivate users from **Settings → Users** (admin only).

### Importing your existing vendors/customers from Zoho Books
Vendors & Customers → **Import Excel** → choose the Zoho *Vendors* or *Contacts* export as-is. The preview shows
what will be added; the same company entered twice in Zoho (same GSTIN) is merged into one record, Inactive
contacts stay inactive, and rows with an invalid GSTIN are listed so you can fix them in Excel and import again.
Importing the same file twice updates instead of duplicating.

## How to check everything works

### Automatic test (recommended — runs the full business flow on a throw-away local database)
Needs Java 11+ and Node 20+:
```bash
npm install
npx playwright install chromium
npm test
```
It runs 64 checks: login security, vendor Excel import (own template and Zoho Books export, duplicate GSTINs merged), PO numbering and GST, the 10-apples partial/short scenario,
short close, auto-complete, 0.5 % tanker tolerance, IGST, transfer PG-106 → Taloja with transit loss, write-off + delete, quotation → SO →
dispatch with drum deduction, stock ledger, activity log, and that operators/outsiders are blocked by the rules.
PDFs and screenshots are written to `tests/output/`.

### Manual test without touching live data
```bash
npx firebase emulators:start --project demo-ccpl --only auth,firestore,storage
node admin/setup.mjs --emulator --users admin/users.json     # in a second terminal
npm run serve                                                   # third terminal
```
Open http://localhost:5500/index.html?emulator=1 — a yellow **TEST MODE** badge shows you are on the emulator.
Open without `?emulator=1` (or with `?emulator=0`) to use live data again.

## Roles

| Role | Can do |
|---|---|
| admin | Everything, incl. settings, users, delete/reverse entries |
| manager | POs, quotations, sales orders, short-close, write-offs + all operations |
| operator | Inward, kanta, GRN, dispatch, transfers, masters |
| viewer | Read only |
