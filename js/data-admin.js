// Backup, fresh start (delete trial data) and restore — super admin only.
// Every destructive step needs the super-admin login AND the separate reset password, and is enforced by
// firestore.rules (/secure/resetGrant). A full backup is always taken (downloaded + kept in the cloud) first.
import {
  db, reportError, state, initPage, pageHeader, esc, toast, openModal, busy, logActivity, qty, fmtDateTime,
  downloadBlob, NUMBER_LABELS, isSuperAdmin
} from "./core.js";
import { storage } from "./firebase-config.js";
import {
  collection, doc, getDoc, getDocs, setDoc, deleteDoc, writeBatch, query, limit, getCountFromServer, serverTimestamp,
  Timestamp, GeoPoint, Bytes, DocumentReference
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { ref, uploadBytes, getDownloadURL, listAll, getMetadata } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

/* ---------------- What is backed up / cleared / restored ---------------- */
const GROUPS = [
  { key: "tx", label: "Transactions", note: "POs, inward, stock, sales, transfers, write-offs, processing, ledger, activity log", wipe: true,
    colls: ["purchaseOrders", "receipts", "outwards", "transfers", "adjustments", "conversions", "quotations", "salesOrders", "proformaInvoices", "inventory", "stockLedger", "activity"] },
  { key: "num", label: "Document numbering", note: "running counters and the register of issued numbers", wipe: true, colls: ["counters", "docNumbers"] },
  { key: "masters", label: "Masters", note: "vendors & customers, items & packaging", wipe: true, colls: ["parties", "items"] },
  { key: "setup", label: "Setup", note: "company settings, warehouses — backed up and restored, never deleted", wipe: false, colls: ["settings", "warehouses"] },
  { key: "users", label: "Users (reference only)", note: "login profiles — backed up for reference, never deleted or restored", wipe: false, colls: ["users"] }
];
const LABEL = {
  purchaseOrders: "Purchase orders", receipts: "Inward receipts (GE / GRN / Kanta)", outwards: "Dispatches", transfers: "Stock transfers",
  adjustments: "Write-offs / opening stock", conversions: "Process RM → Ready", quotations: "Quotations", salesOrders: "Sales orders",
  proformaInvoices: "Proforma invoices", inventory: "Stock balances", stockLedger: "Stock ledger", activity: "Activity log",
  counters: "Number counters", docNumbers: "Issued numbers register", parties: "Vendors & customers", items: "Items & packaging",
  settings: "Settings", warehouses: "Warehouses", users: "Users"
};
const ALL = GROUPS.flatMap((g) => g.colls);
const WIPEABLE = GROUPS.filter((g) => g.wipe).flatMap((g) => g.colls);
const RESTORABLE = GROUPS.filter((g) => g.key !== "users").flatMap((g) => g.colls);
const FORMAT = "CCPL-ERP-BACKUP";
const BATCH_DOCS = 300;
const BATCH_BYTES = 4 * 1024 * 1024;

/* ---------------- Helpers ---------------- */
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (text) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
const randomSalt = () => hex(crypto.getRandomValues(new Uint8Array(16)));
const stamp = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;
const kb = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

// Firestore values ⇄ JSON (timestamps etc. survive the round trip exactly).
function encode(v) {
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Timestamp) return { __t: "ts", s: v.seconds, n: v.nanoseconds };
  if (v instanceof DocumentReference) return { __t: "ref", p: v.path };
  if (v instanceof GeoPoint) return { __t: "geo", lat: v.latitude, lng: v.longitude };
  if (v instanceof Bytes) return { __t: "bytes", b: v.toBase64() };
  if (Array.isArray(v)) return v.map(encode);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)]));
}
function decode(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(decode);
  if (v.__t === "ts" && typeof v.s === "number") return new Timestamp(v.s, v.n || 0);
  if (v.__t === "ref" && typeof v.p === "string") return doc(db, v.p);
  if (v.__t === "geo") return new GeoPoint(v.lat, v.lng);
  if (v.__t === "bytes") return Bytes.fromBase64String(v.b);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x)]));
}

async function countOf(name) {
  try { return (await getCountFromServer(collection(db, name))).data().count; } catch { return null; }
}

/* ---------------- Reset password (grant) ---------------- */
let grant = null; // { proof, at } — kept in memory only while an operation runs

async function readInfo() {
  const snap = await getDoc(doc(db, "secure", "resetInfo"));
  return snap.exists() ? snap.data() : null;
}
async function openGrant(password, purpose) {
  const info = await readInfo();
  if (!info) throw new Error("Set the reset password first.");
  const proof = await sha256(`${info.salt}:${password}`);
  try {
    await setDoc(doc(db, "secure", "resetGrant"), { uid: state.user.uid, at: serverTimestamp(), proof, purpose });
  } catch (error) {
    if (error.code === "permission-denied") {
      await logFailedAttempt(purpose);
      throw new Error("Wrong reset password.");
    }
    throw error;
  }
  grant = { proof, purpose, at: Date.now() };
}
// The rules allow 30 minutes per grant; renew well before that during long operations.
async function keepGrant() {
  if (!grant || Date.now() - grant.at < 10 * 60 * 1000) return;
  await setDoc(doc(db, "secure", "resetGrant"), { uid: state.user.uid, at: serverTimestamp(), proof: grant.proof, purpose: grant.purpose });
  grant.at = Date.now();
}
async function closeGrant() {
  grant = null;
  await deleteDoc(doc(db, "secure", "resetGrant")).catch(() => {});
}
let failed = [];
async function logFailedAttempt(purpose) {
  failed = [...failed.filter((t) => Date.now() - t < 15 * 60 * 1000), Date.now()];
  const batch = writeBatch(db);
  logActivity(batch, { module: "Data", action: "WRONG RESET PASSWORD", summary: `Wrong reset password entered (${purpose})` });
  await batch.commit().catch(() => {});
}
const lockedOut = () => failed.filter((t) => Date.now() - t < 15 * 60 * 1000).length >= 5;

/* ---------------- Backup ---------------- */
async function buildBackup(reason, onStep = () => {}) {
  const collections = {};
  const counts = {};
  for (const name of ALL) {
    onStep(`Reading ${LABEL[name]}…`);
    const snap = await getDocs(collection(db, name));
    collections[name] = snap.docs.map((d) => ({ id: d.id, data: encode(d.data()) })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    counts[name] = collections[name].length;
  }
  const checksum = await sha256(JSON.stringify(collections));
  const file = {
    format: FORMAT, version: 1, createdAt: new Date().toISOString(), reason,
    createdBy: { name: state.profile.name || "", email: state.user.email }, projectId: db.app.options.projectId,
    counts, checksum, collections
  };
  return { file, text: JSON.stringify(file), filename: `CCPL-backup-${stamp()}-${reason}.json` };
}
/** Takes a full backup, downloads it AND keeps a copy in the cloud. Throws if the cloud copy fails. */
async function takeBackup(reason, onStep = () => {}) {
  const backup = await buildBackup(reason, onStep);
  const blob = new Blob([backup.text], { type: "application/json" });
  onStep(`Downloading ${backup.filename} (${kb(blob.size)})…`);
  downloadBlob(blob, backup.filename);
  onStep("Saving a copy in the cloud…");
  await uploadBytes(ref(storage, `backups/${backup.filename}`), blob, { contentType: "application/json" });
  return { ...backup, size: blob.size };
}

/* ---------------- Bulk delete / write ---------------- */
async function wipe(name, onStep) {
  let deleted = 0;
  for (;;) {
    await keepGrant();
    const snap = await getDocs(query(collection(db, name), limit(BATCH_DOCS)));
    if (snap.empty) break;
    const batch = writeBatch(db);
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    deleted += snap.size;
    onStep(`${LABEL[name]}: ${qty(deleted)} deleted`);
  }
  return deleted;
}
async function writeAll(name, docs, onStep) {
  let written = 0;
  let batch = writeBatch(db); let n = 0; let bytes = 0;
  const flush = async () => {
    if (!n) return;
    await keepGrant();
    await batch.commit();
    written += n;
    onStep(`${LABEL[name]}: ${qty(written)} / ${qty(docs.length)} restored`);
    batch = writeBatch(db); n = 0; bytes = 0;
  };
  for (const d of docs) {
    const size = JSON.stringify(d.data).length;
    if (n >= BATCH_DOCS || (n && bytes + size > BATCH_BYTES)) await flush();
    batch.set(doc(db, name, d.id), decode(d.data));
    n += 1; bytes += size;
  }
  await flush();
  return written;
}

/* ---------------- Backup file validation ---------------- */
async function readBackupFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { throw new Error("This is not a valid backup file (cannot read JSON)."); }
  if (data?.format !== FORMAT || typeof data.collections !== "object" || !data.collections) throw new Error("This is not a CCPL ERP backup file.");
  if (data.version !== 1) throw new Error(`Backup version ${data.version} is not supported by this app version.`);
  if (await sha256(JSON.stringify(data.collections)) !== data.checksum) throw new Error("The backup file is damaged or was edited (checksum does not match). Use the original file.");
  const problems = [];
  Object.entries(data.collections).forEach(([name, docs]) => {
    if (!Array.isArray(docs)) problems.push(`${name}: not a list`);
    else if (docs.some((d) => typeof d?.id !== "string" || !d.id || d.id.includes("/") || typeof d.data !== "object" || !d.data)) problems.push(`${name}: invalid document`);
  });
  if (problems.length) throw new Error(`Backup file problems: ${problems.slice(0, 3).join("; ")}`);
  return data;
}

/* ---------------- Page ---------------- */
async function start() {
  let running = false;
  window.addEventListener("beforeunload", (e) => { if (running) { e.preventDefault(); e.returnValue = ""; } });

  page.innerHTML = `${pageHeader("Admin", "Backup, Fresh Start & Restore", "Only for the super admin. Every reset or restore needs the separate reset password and always takes a full backup first.")}
    <div class="card" id="pwCard"></div>
    <div class="grid cols-3" style="margin-bottom:16px">
      <div class="card"><div class="card-body"><h3 style="margin-top:0"><i class="fa-solid fa-download"></i> Backup now</h3><p class="small muted">Downloads every record as one JSON file and keeps a copy in the cloud. Safe — changes nothing.</p><button class="btn primary" id="backupBtn">Download full backup</button></div></div>
      <div class="card"><div class="card-body"><h3 style="margin-top:0"><i class="fa-solid fa-broom"></i> Fresh start</h3><p class="small muted">Deletes trial transactions (and optionally masters) after a full backup. Settings, warehouses and users stay.</p><button class="btn danger" id="resetBtn">Delete trial data…</button></div></div>
      <div class="card"><div class="card-body"><h3 style="margin-top:0"><i class="fa-solid fa-upload"></i> Restore</h3><p class="small muted">Puts the data back exactly as it was in a backup file (after backing up the current data).</p><button class="btn" id="restoreBtn">Restore from backup file…</button></div></div>
    </div>
    <div class="card" id="runCard" hidden><div class="card-head"><h3 id="runTitle">Working…</h3></div><div class="card-body"><div class="segbar lg" style="margin-bottom:10px"><i class="seg-acc" id="runBar" style="width:0%"></i></div><ol class="small" id="runLog" style="margin:0;padding-left:18px"></ol></div></div>
    <div class="card"><div class="card-head"><h3>Data now</h3><button class="btn sm" id="refreshCounts"><i class="fa-solid fa-rotate"></i> Refresh</button></div><div class="table-wrap"><table class="table"><thead><tr><th>Group</th><th>Records</th><th class="num">Count</th></tr></thead><tbody id="countRows"></tbody></table></div></div>
    <div class="card"><div class="card-head"><h3>Backups in the cloud</h3></div><div class="table-wrap"><table class="table"><thead><tr><th>File</th><th>Saved</th><th class="num">Size</th><th></th></tr></thead><tbody id="cloudRows"></tbody></table></div></div>`;

  /* ----- reset password card ----- */
  const renderPw = async () => {
    const info = await readInfo();
    const card = page.querySelector("#pwCard");
    card.innerHTML = info
      ? `<div class="card-head"><h3><i class="fa-solid fa-key"></i> Reset password</h3><button class="btn sm" id="changePw">Change reset password</button></div>
         <div class="card-body small muted">Set on ${esc(fmtDateTime(info.at))}. It is stored only as a one-way hash — nobody (not even admins) can read it. It is separate from your login password.</div>`
      : `<div class="card-head"><h3><i class="fa-solid fa-key"></i> Set the reset password (first time)</h3></div>
         <div class="card-body"><form id="setPwForm" class="form-grid" autocomplete="off">
           <label class="field"><span>Reset password</span><input type="password" name="pw" autocomplete="new-password" /></label>
           <label class="field"><span>Repeat</span><input type="password" name="pw2" autocomplete="new-password" /></label>
           <div class="field" style="justify-content:flex-end"><button class="btn primary" type="submit">Set password</button></div></form>
           <p class="small muted" style="margin-bottom:0">At least 6 characters. Needed for every fresh start or restore. Keep it secret; it is never saved in readable form.</p></div>`;
    card.querySelector("#setPwForm")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const pw = e.target.pw.value; const pw2 = e.target.pw2.value;
      if (pw.length < 6) { toast("The reset password must have at least 6 characters.", "error"); return; }
      if (pw !== pw2) { toast("The two passwords do not match.", "error"); return; }
      const done = busy(e.submitter);
      try {
        const salt = randomSalt();
        const batch = writeBatch(db);
        batch.set(doc(db, "secure", "resetLock"), { hash: await sha256(await sha256(`${salt}:${pw}`)), at: serverTimestamp(), by: state.user.email });
        batch.set(doc(db, "secure", "resetInfo"), { salt, at: serverTimestamp(), by: state.user.email });
        logActivity(batch, { module: "Data", action: "RESET PASSWORD SET", summary: "Reset password set" });
        await batch.commit();
        toast("Reset password set.", "ok");
        await renderPw();
      } catch (error) { reportError(error); } finally { done(); }
    });
    card.querySelector("#changePw")?.addEventListener("click", () => {
      const modal = openModal({
        title: "Change reset password",
        body: `<form id="cpForm" class="form-grid" style="grid-template-columns:1fr" autocomplete="off">
          <label class="field"><span>Current reset password</span><input type="password" name="cur" autocomplete="off" /></label>
          <label class="field"><span>New reset password</span><input type="password" name="pw" autocomplete="new-password" /></label>
          <label class="field"><span>Repeat new</span><input type="password" name="pw2" autocomplete="new-password" /></label></form>`,
        footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="cpSave">Change</button>'
      });
      modal.el.querySelector("#cpSave").addEventListener("click", async (event) => {
        const f = modal.el.querySelector("#cpForm");
        if (f.pw.value.length < 6) { toast("The new password must have at least 6 characters.", "error"); return; }
        if (f.pw.value !== f.pw2.value) { toast("The new passwords do not match.", "error"); return; }
        if (lockedOut()) { toast("Too many wrong attempts — wait 15 minutes.", "error"); return; }
        const done = busy(event.currentTarget);
        try {
          await openGrant(f.cur.value, "change password");
          const salt = randomSalt();
          const batch = writeBatch(db);
          batch.set(doc(db, "secure", "resetLock"), { hash: await sha256(await sha256(`${salt}:${f.pw.value}`)), at: serverTimestamp(), by: state.user.email });
          batch.set(doc(db, "secure", "resetInfo"), { salt, at: serverTimestamp(), by: state.user.email });
          logActivity(batch, { module: "Data", action: "RESET PASSWORD CHANGED", summary: "Reset password changed" });
          await batch.commit();
          toast("Reset password changed.", "ok");
          modal.close();
          await renderPw();
        } catch (error) { reportError(error); } finally { await closeGrant(); done(); }
      });
    });
    return info;
  };

  /* ----- counts & cloud backups ----- */
  const renderCounts = async () => {
    const counts = await Promise.all(ALL.map(countOf));
    const byName = Object.fromEntries(ALL.map((c, i) => [c, counts[i]]));
    page.querySelector("#countRows").innerHTML = GROUPS.map((g) => g.colls.map((c, i) => `<tr>${i === 0 ? `<td rowspan="${g.colls.length}" class="strong">${esc(g.label)}<div class="small muted" style="font-weight:400">${esc(g.note)}</div></td>` : ""}<td>${esc(LABEL[c])}</td><td class="num" data-count="${c}">${byName[c] === null ? "—" : qty(byName[c])}</td></tr>`).join("")).join("");
    return byName;
  };
  const renderCloud = async () => {
    const rows = page.querySelector("#cloudRows");
    try {
      const list = await listAll(ref(storage, "backups"));
      const files = await Promise.all(list.items.map(async (it) => ({ it, meta: await getMetadata(it) })));
      files.sort((a, b) => b.meta.timeCreated.localeCompare(a.meta.timeCreated));
      rows.innerHTML = files.map(({ it, meta }) => `<tr><td class="mono small">${esc(it.name)}</td><td class="small">${esc(fmtDateTime(new Date(meta.timeCreated)))}</td><td class="num">${kb(meta.size)}</td><td><button class="btn sm" data-dl="${esc(it.fullPath)}">Download</button></td></tr>`).join("")
        || '<tr><td class="empty" colspan="4">No backups yet.</td></tr>';
    } catch (error) {
      rows.innerHTML = `<tr><td class="empty" colspan="4">Could not list cloud backups (${esc(error.code || error.message)}).</td></tr>`;
    }
  };
  page.querySelector("#cloudRows").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-dl]"); if (!b) return;
    try { window.open(await getDownloadURL(ref(storage, b.dataset.dl)), "_blank", "noopener"); } catch (error) { reportError(error); }
  });
  page.querySelector("#refreshCounts").addEventListener("click", renderCounts);

  /* ----- run log ----- */
  const run = {
    begin(title, steps) {
      running = true;
      this.total = steps; this.done = 0;
      page.querySelector("#runCard").hidden = false;
      page.querySelector("#runTitle").textContent = title;
      page.querySelector("#runLog").innerHTML = "";
      page.querySelector("#runBar").style.width = "0%";
      page.querySelectorAll("#backupBtn,#resetBtn,#restoreBtn").forEach((b) => { b.disabled = true; });
      page.querySelector("#runCard").scrollIntoView({ behavior: "smooth", block: "start" });
    },
    step(text) {
      const log = page.querySelector("#runLog");
      const last = log.lastElementChild;
      if (last && last.dataset.live === "1") last.textContent = text; else { const li = document.createElement("li"); li.dataset.live = "1"; li.textContent = text; log.append(li); }
    },
    next(text) {
      // the running line of this step is replaced by its result, so each step is one line
      const log = page.querySelector("#runLog");
      const live = log.lastElementChild?.dataset.live === "1" ? log.lastElementChild : null;
      this.done += 1;
      page.querySelector("#runBar").style.width = `${Math.min(100, Math.round((this.done / this.total) * 100))}%`;
      if (text) { const li = live || document.createElement("li"); li.dataset.live = "0"; li.innerHTML = text; if (!live) log.append(li); } else if (live) live.dataset.live = "0";
    },
    end(title, ok) {
      running = false;
      page.querySelector("#runTitle").innerHTML = `${ok ? '<i class="fa-solid fa-circle-check" style="color:var(--success)"></i>' : '<i class="fa-solid fa-circle-xmark" style="color:var(--danger)"></i>'} ${esc(title)}`;
      if (ok) page.querySelector("#runBar").style.width = "100%";
      page.querySelectorAll("#backupBtn,#resetBtn,#restoreBtn").forEach((b) => { b.disabled = false; });
    }
  };

  /* ----- backup only ----- */
  page.querySelector("#backupBtn").addEventListener("click", async () => {
    run.begin("Backup", 2);
    try {
      const b = await takeBackup("manual", (t) => run.step(t));
      run.next(`Backup <b>${esc(b.filename)}</b> (${kb(b.size)}) downloaded and saved in the cloud.`);
      const batch = writeBatch(db);
      logActivity(batch, { module: "Data", action: "BACKUP", refNo: b.filename, summary: `Full backup ${b.filename}: ${Object.entries(b.file.counts).map(([k, v]) => `${LABEL[k]} ${v}`).join(", ")}` });
      await batch.commit();
      run.next();
      run.end("Backup complete", true);
      toast("Backup complete.", "ok");
      await renderCloud();
    } catch (error) { run.end(`Backup failed: ${error.message}`, false); reportError(error); }
  });

  /* ----- fresh start ----- */
  page.querySelector("#resetBtn").addEventListener("click", async () => {
    if (!(await readInfo())) { toast("Set the reset password first.", "error"); return; }
    const counters = (await getDocs(collection(db, "counters"))).docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.id.localeCompare(b.id));
    const modal = openModal({
      title: "Fresh start — delete trial data",
      size: "wide",
      body: `<div class="notice error"><i class="fa-solid fa-triangle-exclamation"></i><div>This permanently deletes the selected data. A full backup is downloaded and saved in the cloud first, and the data can be put back with <b>Restore</b>.</div></div>
        <form id="rsForm" autocomplete="off">
        <div class="section-title">What to delete</div>
        <label class="small" style="display:block;margin-bottom:6px"><input type="checkbox" checked disabled /> <b>All transactions</b> — POs, inward / GRN / Kanta / QC, stock & stock ledger, dispatch, quotations, SO, proforma, transfers, write-offs, processing, activity log</label>
        <label class="small" style="display:block;margin-bottom:6px"><input type="checkbox" name="masters" /> Also delete <b>masters</b> (vendors & customers, items & packaging)</label>
        <label class="small" style="display:block;margin-bottom:6px"><input type="checkbox" name="numbers" checked /> <b>Restart document numbers</b> (clears the register of issued numbers and sets each counter below)</label>
        <p class="small muted">Always kept: company settings, warehouses, users and the private access audit.</p>
        <div id="numBox">${counters.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Document</th><th>Period</th><th class="num">Next now</th><th class="num" style="width:140px">Restart at</th></tr></thead><tbody>
          ${counters.map((c) => `<tr><td>${esc(NUMBER_LABELS[c.type] || c.type || c.id)}</td><td class="small">${esc(c.fy || "")}</td><td class="num">${esc(c.next)}</td><td><input type="number" min="1" step="1" class="num" data-counter="${esc(c.id)}" value="${esc(c.setNext || 1)}" /></td></tr>`).join("")}</tbody></table></div>
          <p class="small muted">"Restart at" defaults to the number you last set in Settings (or 1).</p>` : '<p class="small muted">No counters yet.</p>'}</div>
        <div class="form-grid" style="margin-top:12px">
          <label class="field"><span>Type <b>RESET</b> to confirm</span><input name="confirmWord" autocomplete="off" /></label>
          <label class="field"><span>Reset password</span><input type="password" name="pw" autocomplete="off" /></label>
        </div></form>`,
      footer: '<button class="btn" data-close>Cancel</button><button class="btn danger" id="rsGo"><i class="fa-solid fa-broom"></i> Back up &amp; delete</button>'
    });
    const f = modal.el.querySelector("#rsForm");
    f.numbers.addEventListener("change", () => { modal.el.querySelector("#numBox").hidden = !f.numbers.checked; });
    modal.el.querySelector("#rsGo").addEventListener("click", async () => {
      const opts = { masters: f.masters.checked, numbers: f.numbers.checked };
      const restartAt = [...f.querySelectorAll("[data-counter]")].map((i) => ({ id: i.dataset.counter, next: Number(i.value) }));
      if (f.confirmWord.value.trim() !== "RESET") { toast("Type RESET to confirm.", "error"); return; }
      if (opts.numbers && restartAt.some((c) => !Number.isInteger(c.next) || c.next < 1)) { toast("Restart numbers must be whole numbers from 1.", "error"); return; }
      if (lockedOut()) { toast("Too many wrong attempts — wait 15 minutes.", "error"); return; }
      const pw = f.pw.value;
      modal.close();
      const colls = [...GROUPS[0].colls, ...(opts.numbers ? ["docNumbers"] : []), ...(opts.masters ? GROUPS[2].colls : [])];
      run.begin("Fresh start", colls.length + 5);
      try {
        run.step("Checking the reset password…");
        await openGrant(pw, "reset");
        run.next("Reset password accepted.");
        const b = await takeBackup("before-reset", (t) => run.step(t));
        run.next(`Backup <b>${esc(b.filename)}</b> downloaded and saved in the cloud.`);
        const deleted = {};
        for (const name of colls) {
          run.step(`${LABEL[name]}: deleting…`);
          deleted[name] = await wipe(name, (t) => run.step(t));
          run.next(`${esc(LABEL[name])}: ${qty(deleted[name])} deleted.`);
        }
        if (opts.numbers && restartAt.length) {
          const batch = writeBatch(db);
          restartAt.forEach((c) => batch.set(doc(db, "counters", c.id), { next: c.next, updatedAt: serverTimestamp() }, { merge: true }));
          await batch.commit();
        }
        run.next(opts.numbers ? `Document numbers restarted (${restartAt.length} counter${restartAt.length === 1 ? "" : "s"}).` : "Document numbers kept as they were.");
        run.step("Checking…");
        const left = (await Promise.all(colls.map(async (c) => [c, await countOf(c)]))).filter(([, n]) => n);
        if (left.length) throw new Error(`Some records could not be deleted: ${left.map(([c, n]) => `${LABEL[c]} ${n}`).join(", ")}. Run Fresh start again.`);
        const batch = writeBatch(db);
        logActivity(batch, { module: "Data", action: "DATA RESET", refNo: b.filename, summary: `Fresh start by ${state.user.email}: deleted ${Object.entries(deleted).map(([k, v]) => `${LABEL[k]} ${v}`).join(", ")}${opts.masters ? "" : " · masters kept"}${opts.numbers ? " · numbering restarted" : ""}. Backup: ${b.filename}` });
        await batch.commit();
        run.next("Verified: nothing left. Activity log entry “DATA RESET” recorded.");
        await closeGrant();
        run.next();
        run.end("Fresh start complete", true);
        toast("Fresh start complete.", "ok");
      } catch (error) {
        await closeGrant();
        run.end(`Stopped: ${error.message}`, false);
        reportError(error);
      }
      await Promise.all([renderCounts(), renderCloud()]);
    });
  });

  /* ----- restore ----- */
  page.querySelector("#restoreBtn").addEventListener("click", async () => {
    if (!(await readInfo())) { toast("Set the reset password first.", "error"); return; }
    let backup = null;
    const modal = openModal({
      title: "Restore from backup file",
      size: "wide",
      body: `<p class="small muted" style="margin-top:0">Choose a backup file (.json) downloaded from this page. The current data is backed up first, then every transaction, number and master
        is replaced by the backup; settings and warehouses are overwritten from the backup. Users and the access audit are never changed.</p>
        <form id="rtForm" autocomplete="off"><label class="field"><span>Backup file</span><input type="file" name="file" accept=".json,application/json" /></label>
        <div id="rtPreview" style="margin-top:12px"></div>
        <div class="form-grid" style="margin-top:12px" id="rtConfirm" hidden>
          <label class="field"><span>Type <b>RESTORE</b> to confirm</span><input name="confirmWord" autocomplete="off" /></label>
          <label class="field"><span>Reset password</span><input type="password" name="pw" autocomplete="off" /></label>
        </div></form>`,
      footer: '<button class="btn" data-close>Cancel</button><button class="btn danger" id="rtGo" disabled><i class="fa-solid fa-upload"></i> Back up current &amp; restore</button>'
    });
    const f = modal.el.querySelector("#rtForm");
    f.file.addEventListener("change", async () => {
      const box = modal.el.querySelector("#rtPreview");
      backup = null; modal.el.querySelector("#rtGo").disabled = true; modal.el.querySelector("#rtConfirm").hidden = true;
      const file = f.file.files[0]; if (!file) { box.innerHTML = ""; return; }
      try {
        backup = await readBackupFile(file);
        const now = await renderCounts();
        const names = RESTORABLE.filter((c) => backup.collections[c]);
        const unknown = Object.keys(backup.collections).filter((c) => !ALL.includes(c));
        box.innerHTML = `<div class="notice ok"><i class="fa-solid fa-circle-check"></i><div>Valid backup from <b>${esc(fmtDateTime(new Date(backup.createdAt)))}</b> by ${esc(backup.createdBy?.email || "—")} (${esc(backup.reason || "")}). Checksum OK.
            ${backup.projectId && backup.projectId !== db.app.options.projectId ? `<br><b>Note:</b> it was made on project ${esc(backup.projectId)}.` : ""}</div></div>
          <div class="table-wrap"><table class="table"><thead><tr><th>Records</th><th class="num">Now</th><th class="num">In backup (after restore)</th></tr></thead><tbody>
          ${RESTORABLE.map((c) => `<tr><td>${esc(LABEL[c])}</td><td class="num">${now[c] === null ? "—" : qty(now[c])}</td><td class="num strong">${backup.collections[c] ? qty(backup.collections[c].length) : WIPEABLE.includes(c) ? "0 (not in file)" : "kept as now"}</td></tr>`).join("")}</tbody></table></div>
          ${unknown.length ? `<p class="small muted">Ignored (not part of this app): ${esc(unknown.join(", "))}</p>` : ""}
          ${backup.collections.users ? '<p class="small muted">Users in the file are for reference only and are not restored.</p>' : ""}`;
        modal.el.querySelector("#rtConfirm").hidden = !names.length;
        modal.el.querySelector("#rtGo").disabled = !names.length;
      } catch (error) {
        box.innerHTML = `<div class="notice error"><i class="fa-solid fa-circle-xmark"></i><div>${esc(error.message)}</div></div>`;
      }
    });
    modal.el.querySelector("#rtGo").addEventListener("click", async () => {
      if (!backup) return;
      if (f.confirmWord.value.trim() !== "RESTORE") { toast("Type RESTORE to confirm.", "error"); return; }
      if (lockedOut()) { toast("Too many wrong attempts — wait 15 minutes.", "error"); return; }
      const pw = f.pw.value;
      const source = backup;
      modal.close();
      const writes = RESTORABLE.filter((c) => source.collections[c]);
      run.begin("Restore", WIPEABLE.length + writes.length + 5);
      try {
        run.step("Checking the reset password…");
        await openGrant(pw, "restore");
        run.next("Reset password accepted.");
        const b = await takeBackup("before-restore", (t) => run.step(t));
        run.next(`Current data backed up as <b>${esc(b.filename)}</b> (downloaded and saved in the cloud).`);
        for (const name of WIPEABLE) {
          run.step(`${LABEL[name]}: clearing…`);
          const n = await wipe(name, (t) => run.step(t));
          run.next(`${esc(LABEL[name])}: ${qty(n)} cleared.`);
        }
        for (const name of writes) {
          run.step(`${LABEL[name]}: restoring…`);
          const n = await writeAll(name, source.collections[name], (t) => run.step(t));
          run.next(`${esc(LABEL[name])}: ${qty(n)} restored.`);
        }
        run.step("Verifying…");
        const mismatch = [];
        for (const name of WIPEABLE) {
          const expected = source.collections[name]?.length || 0;
          const actual = await countOf(name);
          if (actual !== expected) mismatch.push(`${LABEL[name]} expected ${expected}, found ${actual}`);
        }
        if (mismatch.length) throw new Error(`Restore check failed: ${mismatch.join("; ")}. Run the restore again with the same file.`);
        run.next("Verified: every collection matches the backup.");
        const batch = writeBatch(db);
        logActivity(batch, { module: "Data", action: "DATA RESTORE", refNo: f.file.files[0]?.name || "", summary: `Restored by ${state.user.email} from the backup of ${source.createdAt} (${writes.map((c) => `${LABEL[c]} ${source.collections[c].length}`).join(", ")}). Data before restore saved as ${b.filename}` });
        await batch.commit();
        await closeGrant();
        run.next("Activity log entry “DATA RESTORE” recorded.");
        run.next();
        run.end("Restore complete", true);
        toast("Restore complete.", "ok");
      } catch (error) {
        await closeGrant();
        run.end(`Stopped: ${error.message}`, false);
        reportError(error);
      }
      await Promise.all([renderCounts(), renderCloud()]);
    });
  });

  await Promise.all([renderPw(), renderCounts(), renderCloud()]);
  document.body.dataset.loaded = "1";
}

// Start last: everything above (constants, helpers) must be initialised before the page runs.
const page = await initPage("data", { superAdminOnly: true });
if (page && isSuperAdmin()) start();
