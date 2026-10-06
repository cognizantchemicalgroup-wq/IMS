# CCPL ERP — Cognizant Chemical Pvt. Ltd.

Static web app (HTML + JavaScript modules) on **Firebase** (Authentication, Firestore, Storage).
No build step: every page is a plain `.html` file with one script in `js/`.
On Apache/Hostinger, `.htaccess` serves each existing HTML page at its extensionless URL and redirects direct `.html` requests to the clean URL. The page filenames remain unchanged.

**Purpose:** the ERP runs day-to-day operations — PO, inward (invoice → GRN → Kanta), transport, rejected vehicles,
stock, transfers, quotations, SO, proforma invoices and dispatch. **Tally remains the system for billing and
accounting entries.** The ERP's statuses (payable quantity after Kanta, "Payment Hold — Rejected Inward", transport cost)
are instructions for the accounts team when they make the Tally entries; nothing in the ERP posts to or blocks Tally.

## What's in it

| Area | Page | Script |
|---|---|---|
| Sign in (email + password, only listed users) | `index.html` | `js/login.js` |
| Dashboard | `dashboard.html` | `js/dashboard.js` |
| Exceptions — only what needs attention (overdue POs, GRN waiting for Kanta, Kanta short/excess, invoice ≠ payable, partial POs, manual stock entries) | `exceptions.html` | `js/exceptions.js`, `js/exceptions-data.js` |
| Purchase Orders — PO series (PH / Monthly), create, PDF, item-wise PO / GRN / Kanta / Short-Excess / Inward / Pending / Payable, internal transport cost, close | `purchase-orders.html` | `js/purchase-orders.js` |
| Invoice → GRN → Kanta → stock inward (multi-item invoices; Kanta is final and payable); transport arrangement & amount; **Vehicle Rejected** with payment hold | `inward.html` | `js/inward.js` |
| Vendors & Customers (one shared list, Party Type Customer / Supplier / Both) and Items & Packaging — import template (Excel / CSV), import with preview, row/column errors, skip or update duplicates, report (also accepts Zoho Books exports), export | `parties.html`, `items.html` | `js/masters.js` |
| Quotations → Sales Orders / Proforma Invoices (Document Type dropdown switches SO ⇄ PI and keeps what was typed; every party can be selected) | `quotations.html`, `sales-orders.html`, `proforma.html` | `js/sales-docs.js`, `js/proforma.js`, `js/sales-draft.js` |
| Warehouses — create, rename (stock and history stay linked), View details: address, contact person, phone, note | `warehouses.html` | `js/warehouses.js` |
| Proforma Invoices — standalone or from a Sales Order; IGST/CGST+SGST, terms → due date, HSN summary, bank details, Balance Due; mark paid / cancel | `proforma.html` | `js/proforma.js` |
| Outward / Dispatch (deducts product **and** drums/carboys/bottles) + Delivery Challan PDF | `outward.html` | `js/outward.js` |
| Stock by warehouse, split into **RM** and **Ready**, packaging, **Under QC (not in stock)**, **Process RM → Ready** (BMR optional), item ledger, **Add Existing / Opening Stock** | `inventory.html` | `js/inventory.js` |
| Stock transfer between warehouses (in transit → received, transit loss) | `transfers.html` | `js/transfers.js` |
| Write-off / adjustment (damaged, destroyed, count correction; admin can delete/reverse) | `adjustments.html` | `js/adjustments.js` |
| Activity log (who did what, to the second; cannot be edited) | `activity.html` | `js/activity.js` |
| Settings: company legal details, bank details, number formats (PH series, Monthly series, PI…), users & roles | `settings.html` | `js/settings.js` |
| **Backup, Fresh Start & Restore** — full backup (download + cloud copy), delete trial data, restore from a backup file; needs the separate reset password (**only rupesh.mudliar@cognizantchemical.com**) | `data-admin.html` | `js/data-admin.js` |
| Access Audit — logins, last active, logout, who did GRN / Kanta and GRN→Kanta time (**only rupesh.mudliar@cognizantchemical.com**) | `access.html` | `js/access.js` |

Shared code: `js/core.js` (login guard, layout, GST maths, numbering, **stock engine**, activity log),
`js/pdf.js` (PO / Quotation / SO / Proforma Invoice / Challan PDF layout), `js/security-deterrent.js` (blocks right-click / dev-tools shortcuts; a deterrent only), `js/line-editor.js`, `js/uploads.js`, `css/app.css` (theme).

Security: `firestore.rules` and `storage.rules`. Nobody can read or write anything unless they are signed in
**and** have an active profile in `users/{uid}`. The activity log and stock ledger cannot be edited or deleted by anyone.

Warehouses: **PG-106, PG-153, Breeze, Taloja Unit** to start with. Admins and managers add or rename them on the Warehouses page.
The code (e.g. `TALOJA`) never changes, so a renamed warehouse keeps all stock, transfers and history.

## How PO quantities are tracked

Flow: **PO → Invoice / Receipt → GRN → Kanta → Stock inward → Payable quantity.**
GRN records what physically arrived; **Kanta is the final truth** — only the Kanta quantity goes into stock and is payable.
One invoice can carry several PO items, and a PO can receive any number of invoices until every item is complete.

| Item | PO Qty | GRN Qty | Kanta Qty | Short/Excess | Inward | Pending |
|---|---|---|---|---|---|---|
| Apple | 10 kg | 5 kg | 5 kg | 0 | 5 kg | 5 kg |
| Methanol | 20,000 kg | 10,000 kg | 9,970 kg | −30 kg | 9,970 kg | 10,030 kg |

PO statuses: **Open → Partially Received** (invoice entered) **→ Awaiting Kanta** (GRN done) **→ Awaiting QC** (weighed, in quarantine) **→ Partially Inwarded → Completed**,
or **Closed** (manager closes a PO that will not be fully supplied, with a reason) / **Cancelled**.
A PO completes automatically within the tolerance in Settings (default 0.5 %).

Document numbers are issued automatically from the format set in Settings and are **never repeated** — every issued number
is registered, so if a counter is set back by mistake the system skips to the next free number. Numbers are assigned inside the
save itself, so two people saving at the same moment always get different numbers.

### PO series
Every new PO picks a **PO Series**:

| Series | Format (Settings) | Numbers | Restarts |
|---|---|---|---|
| PH | `CCPL/PH/{SEQ}/{FY}`, 3 digits | CCPL/PH/055/26-27, 056, 057… | every financial year |
| Monthly | `CCPL/{MON} {YY}/{SEQ}`, 2 digits | CCPL/OCT 26/01, 02… then CCPL/NOV 26/01 | every month (from the PO date) |

Each series has its own counter; set the starting number in **Settings → Document numbering**. Editing a PO never changes its number.

### One supplier bill against several POs
In **New Invoice / Receipt** choose the supplier: every open goods PO of that party is listed line by line. Type the quantity
for each PO line, or type the **total on the bill** for an item and it is allocated to the oldest PO first (e.g. 190 kg →
100 kg on PO 1 + 90 kg on PO 2). Each receipt line is linked to its own PO line, so GRN, Kanta, stock and every PO's
received / rejected / pending quantities stay exact. Only the accepted Kanta quantity (190 kg) goes into stock.

### Close PO with Balance (passive close)
A manager/admin can **Close PO with Balance** when the rest will not be supplied (e.g. 90 of 100 kg received). The PO shows
**Closed with Balance** (different from Completed); each item keeps ordered, received, rejected and **closed balance** (10 kg)
separately; the balance is kept in history but is no longer pending; reason, user and time are recorded; no more inward is
accepted. **Reopen** makes the balance pending again (stock is not changed). Every close / reopen is kept in the PO history.

### Service PO
Choose **PO Type → Service PO** for transportation and other services (service items have category *Service*, e.g. the seeded
"Transportation Charges" and "Other Services"). A Service PO needs no inward, GRN or Kanta and never touches stock. When the
supplier bill / service confirmation arrives, a manager/admin clicks **Mark service completed & close** (bill no., date, amount, note).

### Payment terms
Payment terms are text: "30 Days", "Advance", "Against delivery", "50% advance, balance against delivery" or anything else.
A number typed alone becomes "30 Days". When the terms contain a number of days, the proforma invoice due date is calculated from it.

### Short / excess, rejection
Short/Excess = Kanta − GRN and always shows a number (**0** when there is no difference). At Kanta, a **partial rejection** records
the rejected quantity per item with a reason: only the accepted quantity goes into stock and counts toward the PO; the rejected
quantity is kept separately and shows "Payment Hold — Rejected Inward" against the rejected portion. A **full rejection**
(Vehicle Rejected) is described below.

### PO status at a glance
Opening a PO shows a stage flow — **Ordered → Invoiced → GRN → Kanta → QC → In stock → Pending / Closed** — with the quantity
at each stage, coloured tiles (accepted, in process, rejected, pending, closed balance) and a stacked bar per item
(green = in stock, purple = in QC quarantine, brown = awaiting Kanta, blue = invoiced awaiting GRN, hatched = closed balance,
grey = still to come). The PO list shows the same bar for single-item POs.

### QC quarantine (optional)
QC quarantine is **optional**. *Settings → QC quarantine after Kanta*: **Off** (default) — a GRN defaults to *Approved* and Kanta adds
stock directly; **On** — every GRN defaults to *Pending QC*. Either way the QC status can be changed on each GRN.
When a GRN is saved as **Pending QC — hold in quarantine**, after Kanta the material is weighed but goes to
**Awaiting QC (quarantine)**: it is **not** added to stock and not payable; the PO shows *Awaiting QC* and Stock → *Under QC (not in stock)*
lists it. A **manager or admin** then opens Inward → Awaiting QC → **QC release**:
- **Release to stock** — the released quantity goes into RM stock; any *QC rejected* quantity (with a reason and report reference)
  never enters stock, counts as rejected on the PO and goes on payment hold for that part only.
- **QC failed — reject all** — the whole receipt is rejected; nothing ever enters inventory or the stock ledger, and the PO
  quantity stays pending. Example: one PO, first invoice released, second invoice rejected → only the first is in stock.

If QC was already done (or is not needed), choose **Approved** at GRN — Kanta then adds stock directly.
The rules enforce that only a manager / admin can take material out of quarantine (release or reject it). GRNs saved by older
versions with "Pending QC" are not quarantined (they keep the behaviour they were entered with).

### Backup, fresh start & restore (super admin only)
**Admin → Backup & Reset** is visible only to rupesh.mudliar@cognizantchemical.com.
1. **First time:** set the *reset password* on that page (separate from the login password). It is stored only as a one-way hash —
   nobody can read it, it is not in the code, and the database rules check it. Change it later with *Change reset password*.
2. **Backup now** — downloads every record (transactions, stock, ledger, activity, numbering, masters, settings, warehouses; users for
   reference) as one JSON file with a checksum, and keeps a copy in the cloud (listed on the page). Changes nothing.
3. **Fresh start** — type RESET + the reset password. A full backup is taken first (downloaded + cloud), then all transactions, stock,
   ledger and activity log are deleted; optionally masters too; document numbers restart at the number last set in Settings (editable
   per counter). Settings, warehouses, users and the access audit are kept. The result is checked and one "DATA RESET" entry is logged.
4. **Restore** — choose a backup file: it is checked (an edited or damaged file is refused) and a preview shows the counts. Type RESTORE +
   the reset password. The current data is backed up first, then the data is put back exactly as in the file (same numbers, dates,
   stock and history) and verified collection by collection. If anything stops half-way, simply run the same restore again.
Other admins cannot do any of this — the database rules refuse bulk delete/restore without the reset password, even from the
browser console. Five wrong passwords lock the page for 15 minutes, and wrong attempts are logged. Uploaded documents (invoice / Kanta
slip files) are not deleted by a fresh start, so restored records still open their attachments.

### RM and Ready stock (BMR optional)
Every item can be held as **RM** (raw / as purchased — all inward lands here) and **Ready** (processed) in each warehouse — even the
same product (e.g. Acetone RM and Acetone Ready). **Stock → Process RM → Ready** takes quantity out of RM and puts the output into
Ready (same or a different product), shows the process loss, and gets a number `CCPL/PR/{FY}/{SEQ}`. **BMR No. and Batch No. are
optional** — leave them blank when there is no BMR. Admin can reverse a process entry. Dispatch picks Ready stock by default when
enough is available, otherwise RM (changeable per line); transfers and write-offs choose RM or Ready per line. Packaging is always RM.

### Transport (inward)
Each inward entry records **Transport Arrangement** (Self / CCPL Transport or Party Transport) and the **Transportation Amount**,
with who created it and when. The amount can be corrected later ("Edit transport", logged). It is internal: shown on the inward
history and the PO screen, **not** printed on the PO PDF and **not** added to the PO total.

### Vehicle rejected / payment hold
A vehicle can be marked **Vehicle Rejected** at gate entry, at GRN, at Kanta, or (manager/admin) after Kanta — then its stock is
taken back out. A rejected entry adds no stock, counts **zero** against the PO (the PO quantity stays pending) and stays visible
in the inward history and on the PO with its reason, user and time. It shows **"Payment Hold — Rejected Inward"** so accounts do
not pay it; only that receipt is held, never the other receipts on the PO. A manager/admin can **Resolve payment hold** with a
note (e.g. credit note received). The ERP has no payment approval of its own, and the hold does not block anything in Tally.

PDFs carry "System Generated Document — No Signature Required." instead of a signature box.

## Updating the live site after a new version

1. Upload the new files to the hosting (Hostinger `public_html`, keeping `vendor/`; or the GitHub repo if the site is deployed from it).
   **Never upload `.env`, `service-account.json` or `admin/users.json` into `public_html`** — keep them one folder above it
   (the PHP login looks there first).
2. **Publish the new security rules** — new features (Backup / Fresh start / Restore, QC quarantine / "Awaiting QC", RM → Ready processing, proforma invoices,
   rejected vehicles / payment hold, warehouses by managers) are refused by the old rules until this is done:
   ```bash
   npm install
   GOOGLE_APPLICATION_CREDENTIALS=./service-account.json npm run deploy:rules
   ```
3. Sign in as admin → **Settings → Document numbering**: set the next **PH series** number (e.g. 55) and check the Monthly series.

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
   addresses; check the bank details printed on quotations / proforma invoices.

After that, add or deactivate users from **Settings → Users** (admin only).

### Importing customers and suppliers (template)
Vendors & Customers → **Import template** → download the Excel (or CSV) template. Columns are labelled **(Required)** or
**(Optional)**; only *Party Name* and *Party Type* (Customer / Supplier / Both) are required. A company that is both a customer
and a supplier is one row with Party Type **Both** — it then appears in PO, SO and PI dropdowns without a duplicate record.
**Import Excel / CSV** shows a preview first: every error with its row number and column, duplicates inside the file (merged),
and records that already exist (matched by GSTIN, or by name without GSTIN) — choose **Skip** or **Update** (update never blanks
out existing data or renames the party). The report shows how many were added, updated, skipped and failed, and the failed rows
can be downloaded to fix and re-import.

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
It runs 149 checks: login security, vendor Excel import (own template and Zoho Books export, duplicate GSTINs merged), PO numbering and GST, the 10-apples partial/short scenario,
short close, auto-complete, 0.5 % tanker tolerance, IGST, PH and Monthly PO series (month change, edit keeps number, two users saving
at once), transport amount kept off the PO PDF, vehicle rejected at entry / Kanta / after Kanta with payment hold and its resolution,
party import (template, row/column errors, skip/update, report, CSV, Zoho), warehouse create/rename/details,
one bill split across two POs (190 kg = 100 + 90) with Close with Balance and reopen, partial rejection at Kanta, Service PO,
text payment terms,
transfer PG-106 → Taloja with transit loss, write-off + delete, quotation → SO → dispatch with drum deduction,
SO ⇄ PI document type with a supplier as customer, proforma invoice from a sales order (IGST, due date, PDF, mark paid), stock ledger, activity log, and that operators/outsiders are blocked by the rules.
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
| manager | POs, quotations, sales orders, short-close, write-offs, **QC release** + all operations |
| operator | Inward, kanta, GRN, dispatch, transfers, RM → Ready processing, masters |
| viewer | Read only |
