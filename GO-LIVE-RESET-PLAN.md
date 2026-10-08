# CCPL ERP — Go-live reset & manual PO numbering

**Status: code ready, reset NOT executed.** Nothing is deleted until the super admin runs the reset after you approve the scope below.

## 1. Reset scope (needs your approval)

| Data | Firestore collection | Action |
|---|---|---|
| Purchase orders (incl. service POs, line items, history) | `purchaseOrders` | **DELETE** |
| Inward: invoice / gate entry, GRN, Kanta, QC, rejected vehicles, payment holds | `receipts` | **DELETE** |
| Dispatch / delivery challans | `outwards` | **DELETE** |
| Stock transfers | `transfers` | **DELETE** |
| Write-offs / adjustments / opening stock entries | `adjustments` | **DELETE** |
| Process RM → Ready | `conversions` | **DELETE** |
| Quotations, sales orders, proforma invoices | `quotations`, `salesOrders`, `proformaInvoices` | **DELETE** |
| Stock balances (transaction-generated) | `inventory` | **DELETE** (all items start at 0) |
| Stock ledger | `stockLedger` | **DELETE** |
| Activity log (test activity) | `activity` | **DELETE** (one new "GO-LIVE RESET" entry is written) |
| Vendor & customer master | `parties` | **DELETE** |
| Issued-numbers register, PO-number register | `docNumbers`, `poNumbers` | **DELETE** |
| Attachments (invoices, COA, Kanta slips, write-off files) | Storage `CCPL-IMS/…` | **DELETE** (after a private copy) |
| Running counters for GRN, GE, SO, PI, DC… | `counters` | **RESTART** at the numbers you enter |
| **Item master** (codes and all item details) | `items` | **KEEP** |
| Company settings, bank details, number formats, warehouses | `settings`, `warehouses` | **KEEP** (system configuration) |
| User accounts, roles, access | `users` + Firebase Auth | **KEEP** |
| Login-session audit (security log) | `sessions` | **KEEP** |

Please confirm or change two judgement calls: **warehouses** (kept as configuration) and the **login-session audit** (kept as a security log).

## 2. How the reset runs (Admin → Backup & Reset → "Go-live reset", super admin only)
1. Screen shows the exact scope with live record counts; you tick "I approve", type `RESET` and enter the separate reset password.
2. **Data entry is paused** for every user (enforced by the database rules, banner shown on every page).
3. **Protected backup**: full JSON backup downloaded to your PC *and* saved in private cloud storage; attachments copied server-side to `backups/attachments-<time>/`. Backups are readable only by the super admin.
4. Deletion of the scope above (attachments are deleted only if their backup copy is verified).
5. **Verification**: every deleted collection = 0, attachments = 0, item count identical to before. Any mismatch stops the run and keeps data entry paused.
6. Data entry resumes; activity log records "GO-LIVE RESET". Restore from the backup file is available on the same page.

## 3. Manual PO numbers
- New PO form has an editable **PO Number** field; any prefix / series / FY / sequence is allowed (letters, digits, spaces, `/ - _ . ( ) # & :`, max 60).
- **"Use last PO no."** copies only the number of the most recently *created* PO (not the highest number) into the field for editing. Nothing else is copied.
- With no PO saved: "No previous PO number available. Enter your first PO number."
- Duplicate check ignores case and leading/trailing/repeated spaces: "This PO number already exists. Please enter a different PO number." Saving is blocked.
- Enforced in the database: a register `poNumbers/{number}` is created in the same transaction as the PO and Firestore rules refuse a second registration — simultaneous saves cannot both succeed (tested with 10 at once).
- Editing a PO with its own number works; changing it to a free number releases the old one; cancelled/deleted PO numbers stay reserved forever.
- The PH / Monthly automatic PO series are removed from the form and Settings (old POs keep their series label).

## 4. Security changes
- Attachments are private: no public download links; files open only via `api/file.php`, which checks the Firebase sign-in and active profile on every request. Storage rules deny all browser reads.
- Backup files: super admin only, served through the same check.
- Data-entry pause and reset grant enforced in `firestore.rules` / `storage.rules`.
- Removed hard-coded secrets (Gmail app password, OTP key) from `api/config.php`; login API no longer leaks error details.
- `.htaccess`: HTTPS redirect, HSTS, `noindex` on everything, `robots.txt` disallow, blocks `vendor/`, `admin/`, `tests/`, `.json`, `.env`, hidden files; no-cache for pages and API.

## 5. Deployment steps
1. **Rotate the Gmail app password** (`rzrb…`) — it was inside `api/config.php` in the previous zip.
2. Move `.env` and `service-account.json` **one level above `public_html`** (the code looks there first). They are not in this zip.
3. Upload the zip contents to `public_html` (overwrite).
4. Publish the new rules: Firebase console → Firestore → Rules (paste `firestore.rules`) and Storage → Rules (paste `storage.rules`), or `node admin/deploy-rules.mjs` on a PC with Node.
5. Super admin: Backup & Reset → set reset password (first time) → review scope → run after approval.

## 6. Acceptance evidence (automated, Firebase emulators)
- `tests/po-numbers.mjs`: 36/36 passed — duplicates (case/space), bypass attempts, 2 and 10 simultaneous saves, edit same number, renumber, cancelled reserved, pause, reset password/grant, item master intact after reset.
- `tests/e2e.mjs` (full ERP in a browser): 160/160 passed — PO → inward → GRN → Kanta → stock, transfers, write-offs, quotations → SO → dispatch, roles/security, plus the new PO-number UI checks.
