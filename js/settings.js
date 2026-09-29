import {
  db, reportError, auth, state, initPage, pageHeader, esc, toast, openModal, confirmDialog, busy, formValues, isAdmin,
  listCollection, logActivity, fmtDateTime, financialYear, NUMBER_FORMATS, badge
} from "./core.js";
import { USING_EMULATOR } from "./firebase-config.js";
import { doc, runTransaction, serverTimestamp, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signOut, sendPasswordResetEmail,
  EmailAuthProvider, reauthenticateWithCredential, updatePassword
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const page = await initPage("settings");
if (page) start();

export function generatePassword(length = 14) {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "@#$%&*!?"];
  const all = sets.join("");
  const bytes = crypto.getRandomValues(new Uint32Array(length));
  const chars = sets.map((s, i) => s[bytes[i] % s.length]);
  for (let i = sets.length; i < length; i += 1) chars.push(all[bytes[i] % all.length]);
  for (let i = chars.length - 1; i > 0; i -= 1) { const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join("");
}

async function start() {
  const admin = isAdmin();
  const c = state.company;
  page.innerHTML = `${pageHeader("Admin", "Settings & Users", admin ? "Company legal details, warehouses, numbering and user access." : "Your account.")}
    <div class="card"><div class="card-head"><h3>My account</h3></div><div class="card-body">
      <div class="detail-grid"><div><span>Name</span><b>${esc(state.profile.name)}</b></div><div><span>Email</span><b>${esc(state.user.email)}</b></div><div><span>Role</span><b style="text-transform:capitalize">${esc(state.profile.role)}</b></div></div>
      <form id="pwForm" class="form-grid" style="margin-top:16px"><label class="field"><span>Current password</span><input type="password" name="current" autocomplete="current-password" /></label><label class="field"><span>New password (min 10 chars)</span><input type="password" name="next" autocomplete="new-password" /></label><div class="field" style="justify-content:flex-end"><button class="btn" type="submit">Change password</button></div></form>
    </div></div>
    ${admin ? `
    <div class="card"><div class="card-head"><h3>Users</h3><button class="btn primary sm" id="addUser"><i class="fa-solid fa-user-plus"></i> Add user</button></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Added</th><th></th></tr></thead><tbody id="users"></tbody></table></div>
      <div class="card-body small muted" style="border-top:1px solid var(--border)">Only users listed here with status Active can sign in. Deactivating a user blocks them immediately. Roles: <b>admin</b> everything · <b>manager</b> POs, quotations, SOs, short-close, write-offs + operations · <b>operator</b> inward, kanta, GRN, dispatch, transfers · <b>viewer</b> read only.</div></div>
    <div class="card"><div class="card-head"><h3>Company legal details (printed on PO / Quotation / SO)</h3></div><div class="card-body">
      <form id="coForm" class="form-grid">
        <label class="field span-2"><span>Legal name</span><input name="name" value="${esc(c.name)}" /></label>
        <label class="field"><span>GSTIN</span><input name="gstin" value="${esc(c.gstin)}" /></label>
        <label class="field"><span>PAN</span><input name="pan" value="${esc(c.pan)}" /></label>
        <label class="field span-2"><span>Registered address (one line per row)</span><textarea name="addressLines" rows="3">${esc(c.addressLines.join("\n"))}</textarea></label>
        <label class="field"><span>State</span><input name="state" value="${esc(c.state)}" /></label>
        <label class="field"><span>State code</span><input name="stateCode" value="${esc(c.stateCode)}" /></label>
        <label class="field"><span>Email</span><input name="email" value="${esc(c.email)}" /></label>
        <label class="field"><span>Phone</span><input name="phone" value="${esc(c.phone)}" /></label>
        <label class="field"><span>Bank name</span><input name="bankName" value="${esc(c.bankName)}" /></label>
        <label class="field"><span>Bank A/c no.</span><input name="bankAccount" value="${esc(c.bankAccount)}" /></label>
        <label class="field"><span>IFSC</span><input name="bankIfsc" value="${esc(c.bankIfsc)}" /></label>
        <label class="field"><span>Branch</span><input name="bankBranch" value="${esc(c.bankBranch)}" /></label>
        <label class="field"><span>PO auto-complete tolerance %</span><input type="number" step="any" min="0" max="10" name="poTolerancePct" value="${esc(c.poTolerancePct ?? 0)}" /><small class="help">e.g. 0.5 → a 20 MT PO auto-completes at 19.9 MT</small></label>
        <label class="field span-all"><span>Default PO terms & conditions</span><textarea name="poTerms" rows="6">${esc(c.poTerms)}</textarea></label>
        <label class="field span-2"><span>Default quotation terms</span><textarea name="quoteTerms" rows="5">${esc(c.quoteTerms)}</textarea></label>
        <label class="field span-2"><span>Default sales order terms</span><textarea name="soTerms" rows="5">${esc(c.soTerms)}</textarea></label>
        <div class="span-all" style="display:flex;justify-content:flex-end"><button class="btn primary" type="submit">Save company details</button></div>
      </form></div></div>
    <div class="card"><div class="card-head"><h3>Warehouses / units</h3><button class="btn sm" id="addWh"><i class="fa-solid fa-plus"></i> Add warehouse</button></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Code</th><th>Name</th><th>PO code</th><th>Address (Deliver To)</th><th>Destination</th><th>Status</th><th></th></tr></thead><tbody id="whRows"></tbody></table></div></div>
    <div class="card"><div class="card-head"><h3>Document numbering · FY ${financialYear()}</h3></div><div class="card-body">
      <p class="small muted" style="margin-top:0">Set the next number to continue your existing series (e.g. your last PO was CCPL/PG/823/26-27 → set PO next number to 824). {SITE} is the warehouse PO code, {SEQ} the running number, {FY} the financial year.</p>
      <table class="table"><thead><tr><th>Document</th><th>Format</th><th class="num">Next number</th><th></th></tr></thead><tbody id="numRows"></tbody></table></div></div>` : `
    <div class="card"><div class="card-head"><h3>Company</h3></div><div class="card-body"><div class="detail-grid"><div><span>Name</span><b>${esc(c.name)}</b></div><div><span>GSTIN</span><b>${esc(c.gstin)}</b></div><div><span>PAN</span><b>${esc(c.pan)}</b></div></div></div></div>`}`;

  page.querySelector("#pwForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = formValues(e.target);
    if (v.next.length < 10) { toast("New password must be at least 10 characters.", "error"); return; }
    try {
      await reauthenticateWithCredential(auth.currentUser, EmailAuthProvider.credential(state.user.email, v.current));
      await updatePassword(auth.currentUser, v.next);
      e.target.reset();
      toast("Password changed.", "ok");
    } catch (error) { toast(error.code === "auth/invalid-credential" || error.code === "auth/wrong-password" ? "Current password is incorrect." : error.message, "error"); }
  });

  if (!admin) return;

  /* ---------- Users ---------- */
  let users = [];
  const loadUsers = async () => {
    users = (await listCollection("users")).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    page.querySelector("#users").innerHTML = users.map((u) => `<tr><td class="strong">${esc(u.name)}</td><td>${esc(u.email)}</td>
      <td><select class="input" data-role="${esc(u.id)}" ${u.id === state.user.uid ? "disabled" : ""}>${["admin", "manager", "operator", "viewer"].map((r) => `<option ${r === u.role ? "selected" : ""}>${r}</option>`).join("")}</select></td>
      <td>${badge(u.active ? "ACTIVE" : "INACTIVE")}</td><td class="small">${fmtDateTime(u.createdAt)}</td>
      <td><div class="actions">${u.id !== state.user.uid ? `<button class="btn sm" data-toggle="${esc(u.id)}">${u.active ? "Deactivate" : "Activate"}</button>` : ""}<button class="btn sm" data-reset="${esc(u.id)}">Send reset link</button></div></td></tr>`).join("");
  };
  const usersEl = page.querySelector("#users");
  usersEl.addEventListener("change", async (e) => {
    const id = e.target.dataset.role; if (!id) return;
    const u = users.find((x) => x.id === id);
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, "users", id), { role: e.target.value, updatedAt: serverTimestamp() });
      logActivity(batch, { module: "Users", action: "ROLE", refId: id, refNo: u.email, summary: `${u.email} role ${u.role} → ${e.target.value}` });
      await batch.commit();
      toast("Role updated.", "ok");
      await loadUsers();
    } catch (error) { reportError(error); }
  });
  usersEl.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-toggle]");
    const r = e.target.closest("[data-reset]");
    if (t) {
      const u = users.find((x) => x.id === t.dataset.toggle);
      if (!(await confirmDialog(`${u.active ? "Deactivate" : "Activate"} ${u.email}?`, { danger: u.active }))) return;
      const batch = writeBatch(db);
      batch.update(doc(db, "users", u.id), { active: !u.active, updatedAt: serverTimestamp() });
      logActivity(batch, { module: "Users", action: u.active ? "DEACTIVATE" : "ACTIVATE", refId: u.id, refNo: u.email, summary: `${u.active ? "Deactivated" : "Activated"} ${u.email}` });
      await batch.commit();
      await loadUsers();
    }
    if (r) {
      const u = users.find((x) => x.id === r.dataset.reset);
      try { await sendPasswordResetEmail(auth, u.email); toast(`Reset link sent to ${u.email}.`, "ok"); } catch (error) { reportError(error); }
    }
  });
  page.querySelector("#addUser").addEventListener("click", () => {
    const pw = generatePassword();
    const modal = openModal({
      title: "Add ERP user",
      body: `<form id="uForm" class="form-grid" style="grid-template-columns:1fr 1fr">
        <label class="field span-2"><span>Full name</span><input name="name" /></label>
        <label class="field span-2"><span>Email (login ID)</span><input name="email" type="email" /></label>
        <label class="field"><span>Role</span><select name="role"><option>operator</option><option>manager</option><option>viewer</option><option>admin</option></select></label>
        <label class="field"><span>Initial password</span><input name="password" value="${esc(pw)}" class="mono" /></label>
        <p class="small muted span-2" style="margin:0">Share the password privately. The user can change it from Settings → My account.</p></form>`,
      footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="createU">Create user</button>'
    });
    modal.el.querySelector("#createU").addEventListener("click", async (e) => {
      const v = formValues(modal.el.querySelector("#uForm"));
      if (!v.name || !v.email || v.password.length < 10) { toast("Name, email and a password of at least 10 characters are required.", "error"); return; }
      const done = busy(e.currentTarget, "Creating…");
      try {
        // A secondary Firebase app creates the login without signing the admin out.
        const primary = getApps()[0];
        const secondary = getApps().find((a) => a.name === "user-admin") || initializeApp(primary.options, "user-admin");
        const secondaryAuth = getAuth(secondary);
        if (USING_EMULATOR && !secondaryAuth.emulatorConfig) connectAuthEmulator(secondaryAuth, "http://127.0.0.1:9099", { disableWarnings: true });
        const cred = await createUserWithEmailAndPassword(secondaryAuth, v.email, v.password);
        await signOut(secondaryAuth);
        const batch = writeBatch(db);
        batch.set(doc(db, "users", cred.user.uid), { name: v.name, email: v.email.toLowerCase(), role: v.role, active: true, createdAt: serverTimestamp() });
        logActivity(batch, { module: "Users", action: "CREATE", refId: cred.user.uid, refNo: v.email, summary: `Created user ${v.name} <${v.email}> as ${v.role}` });
        await batch.commit();
        toast(`User ${v.email} created.`, "ok");
        modal.close();
        await loadUsers();
      } catch (error) {
        toast(error.code === "auth/email-already-in-use" ? "This email already has a login. If it is missing from the list, ask the developer to link it with the setup script." : error.message, "error");
      } finally { done(); }
    });
  });

  /* ---------- Company ---------- */
  page.querySelector("#coForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = formValues(e.target);
    const data = { ...v, addressLines: v.addressLines.split("\n").map((s) => s.trim()).filter(Boolean), poTolerancePct: Number(v.poTolerancePct) || 0, updatedAt: serverTimestamp() };
    const done = busy(e.submitter);
    try {
      const batch = writeBatch(db);
      batch.set(doc(db, "settings", "company"), data, { merge: true });
      logActivity(batch, { module: "Settings", action: "UPDATE", refNo: "Company", summary: "Updated company legal details / terms" });
      await batch.commit();
      Object.assign(state.company, data);
      toast("Company details saved.", "ok");
    } catch (error) { reportError(error); } finally { done(); }
  });

  /* ---------- Warehouses ---------- */
  const renderWh = () => {
    page.querySelector("#whRows").innerHTML = state.warehouses.map((w) => `<tr><td class="mono">${esc(w.code)}</td><td class="strong">${esc(w.name)}</td><td>${esc(w.docCode)}</td><td class="small">${esc((w.addressLines || []).join(" "))}</td><td>${esc(w.destination || "")}</td><td>${badge(w.active === false ? "INACTIVE" : "ACTIVE")}</td><td><button class="btn sm" data-wh="${esc(w.code)}">Edit</button></td></tr>`).join("");
  };
  const editWh = (w = null) => {
    const modal = openModal({
      title: w ? `Edit ${w.name}` : "Add warehouse",
      body: `<form id="whForm" class="form-grid" style="grid-template-columns:1fr 1fr">
        <label class="field"><span>Code (permanent)</span><input name="code" value="${esc(w?.code || "")}" ${w ? "readonly" : ""} /></label>
        <label class="field"><span>Name</span><input name="name" value="${esc(w?.name || "")}" /></label>
        <label class="field"><span>PO number code ({SITE})</span><input name="docCode" value="${esc(w?.docCode || "")}" /></label>
        <label class="field"><span>Destination (printed on PO)</span><input name="destination" value="${esc(w?.destination || "")}" /></label>
        <label class="field span-2"><span>Delivery address (one line per row)</span><textarea name="addressLines" rows="4">${esc((w?.addressLines || []).join("\n"))}</textarea></label>
        <label class="field"><span>Status</span><select name="active"><option value="true">Active</option><option value="false" ${w?.active === false ? "selected" : ""}>Inactive</option></select></label>
        <label class="field"><span>Sort order</span><input type="number" name="sort" value="${esc(w?.sort ?? state.warehouses.length + 1)}" /></label></form>`,
      footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="saveWh">Save</button>'
    });
    modal.el.querySelector("#saveWh").addEventListener("click", async () => {
      const v = formValues(modal.el.querySelector("#whForm"));
      const code = v.code.toUpperCase().replace(/[^A-Z0-9-]/g, "");
      if (!code || !v.name) { toast("Code and name are required.", "error"); return; }
      const data = { name: v.name, docCode: v.docCode.toUpperCase() || code, destination: v.destination, addressLines: v.addressLines.split("\n").map((s) => s.trim()).filter(Boolean), active: v.active === "true", sort: Number(v.sort) || 99, updatedAt: serverTimestamp() };
      const batch = writeBatch(db);
      batch.set(doc(db, "warehouses", code), data, { merge: true });
      logActivity(batch, { module: "Settings", action: "WAREHOUSE", refNo: code, summary: `${w ? "Updated" : "Added"} warehouse ${v.name}` });
      await batch.commit();
      const i = state.warehouses.findIndex((x) => x.code === code);
      if (i >= 0) state.warehouses[i] = { ...state.warehouses[i], ...data, code }; else state.warehouses.push({ ...data, code });
      renderWh();
      modal.close();
      toast("Warehouse saved.", "ok");
    });
  };
  page.querySelector("#whRows").addEventListener("click", (e) => { const b = e.target.closest("[data-wh]"); if (b) editWh(state.warehouses.find((w) => w.code === b.dataset.wh)); });
  page.querySelector("#addWh").addEventListener("click", () => editWh());
  renderWh();

  /* ---------- Numbering ---------- */
  const fy = financialYear();
  const renderNums = async () => {
    const counters = await listCollection("counters");
    const labels = { PO: "Purchase Order", QT: "Quotation", SO: "Sales Order", GE: "Gate Entry", GRN: "GRN", DC: "Delivery Challan", ST: "Stock Transfer", ADJ: "Stock Adjustment" };
    page.querySelector("#numRows").innerHTML = Object.keys(NUMBER_FORMATS).map((k) => {
      const next = counters.find((x) => x.id === `${k}_${fy}`)?.next || 1;
      return `<tr><td class="strong">${labels[k]}</td><td class="mono">${esc(NUMBER_FORMATS[k])}</td><td><input type="number" min="1" step="1" value="${next}" data-num="${k}" class="num" style="max-width:120px;margin-left:auto;display:block" /></td><td><button class="btn sm" data-setnum="${k}">Set</button></td></tr>`;
    }).join("");
  };
  page.querySelector("#numRows").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-setnum]"); if (!b) return;
    const k = b.dataset.setnum;
    const next = Number(page.querySelector(`[data-num="${k}"]`).value);
    if (!Number.isInteger(next) || next < 1) { toast("Enter a whole number.", "error"); return; }
    if (!(await confirmDialog(`Next ${k} number for FY ${fy} will be ${next}. Continue?`))) return;
    await runTransaction(db, async (tx) => {
      tx.set(doc(db, "counters", `${k}_${fy}`), { next, type: k, fy, updatedAt: serverTimestamp() }, { merge: true });
      logActivity(tx, { module: "Settings", action: "NUMBERING", refNo: k, summary: `Set next ${k} number for FY ${fy} to ${next}` });
    });
    toast("Numbering updated.", "ok");
  });
  await Promise.all([loadUsers(), renderNums()]);
}
