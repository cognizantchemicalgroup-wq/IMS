// Proforma Invoices — issued to a customer before dispatch / against advance payment.
// ISSUED → PAID | CANCELLED. Can be created on its own or from a Sales Order (pending quantities are copied).
// The PDF is system generated: no signature box.
import {
  db, reportError, state, initPage, pageHeader, esc, toast, openModal, confirmDialog, badge, busy, formValues, can, isAdmin,
  listCollection, logActivity, money, qty, fmtDate, fmtDateTime, isoDate, addDays, round, computeTotals,
  reserveNumber, commitNumber, exportExcel, STATE_CODES
} from "./core.js";
import { createLineEditor } from "./line-editor.js";
import { piSpec, showDocument, safeFileName } from "./pdf.js";
import { collection, doc, runTransaction, serverTimestamp, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const FROM_SO_KEY = "ccpl-pi-from-so";
const TABS = [["UNPAID", "Unpaid"], ["OVERDUE", "Overdue"], ["PAID", "Paid"], ["CANCELLED", "Cancelled"], ["ALL", "All"]];

const page = await initPage("pi");
if (page) start();

async function start() {
  let docs = []; let customers = []; let items = []; let orders = [];
  let tab = "UNPAID";
  const canEdit = can("commercial");

  page.innerHTML = `${pageHeader("Sales", "Proforma Invoices", "Proforma invoices for advance payment or before dispatch — system generated, no signature needed.",
    `<button class="btn" id="exportBtn"><i class="fa-solid fa-download"></i> Export</button>${canEdit ? '<button class="btn primary" id="newDoc"><i class="fa-solid fa-plus"></i> New Proforma Invoice</button>' : ""}`)}
    <div class="tabs" id="tabs"></div>
    <div class="card"><div class="card-head"><div class="toolbar"><input class="input search" id="search" placeholder="Search number, customer, reference, item…" /></div><span class="small muted" id="count"></span></div>
    <div class="table-wrap"><table class="table"><thead><tr><th>PI No.</th><th>Date</th><th>Customer</th><th>Reference</th><th>Items</th><th class="num">Amount (₹)</th><th>Due Date</th><th>Status</th><th></th></tr></thead><tbody id="rows"></tbody></table></div></div>`;

  const statusOf = (d) => (d.status === "ISSUED" && d.dueDate && d.dueDate < isoDate() ? "OVERDUE" : d.status);
  const inTab = (d, t) => t === "ALL" || (t === "UNPAID" ? d.status === "ISSUED" : statusOf(d) === t);

  function render() {
    page.querySelector("#tabs").innerHTML = TABS.map(([k, l]) => `<button class="tab ${k === tab ? "active" : ""}" data-tab="${k}">${l}<span class="count">${docs.filter((d) => inTab(d, k)).length}</span></button>`).join("");
    const term = page.querySelector("#search").value.trim().toLowerCase();
    const list = docs.filter((d) => inTab(d, tab) && (!term || [d.piNo, d.customer?.name, d.refNo, d.soNo, ...d.lines.map((l) => l.name)].some((v) => String(v || "").toLowerCase().includes(term))));
    page.querySelector("#count").textContent = `${list.length} proforma invoices`;
    const rows = page.querySelector("#rows");
    if (!list.length) { rows.innerHTML = '<tr><td class="empty" colspan="9">No proforma invoices here.</td></tr>'; return; }
    rows.innerHTML = list.map((d) => `<tr><td class="strong nowrap"><a href="#" data-view="${esc(d.id)}">${esc(d.piNo)}</a></td><td class="nowrap">${fmtDate(d.date)}</td><td>${esc(d.customer?.name)}</td>
      <td>${esc(d.refNo || "—")}${d.soNo ? `<div class="small muted">${esc(d.soNo)}</div>` : ""}</td>
      <td>${d.lines.length === 1 ? `${esc(d.lines[0].name)}<div class="small muted">${qty(d.lines[0].qty)} ${esc(d.lines[0].unit)}</div>` : `${d.lines.length} items`}</td>
      <td class="num">${money(d.totals?.total)}</td><td class="nowrap">${fmtDate(d.dueDate)}</td><td>${badge(statusOf(d))}</td>
      <td><div class="actions"><button class="btn sm" data-pdf="${esc(d.id)}"><i class="fa-solid fa-file-pdf"></i></button><button class="btn sm" data-view="${esc(d.id)}">Open</button></div></td></tr>`).join("");
  }

  async function load() {
    [docs, customers, items, orders] = await Promise.all([listCollection("proformaInvoices", "createdAt", "desc"), listCollection("parties"), listCollection("items"), listCollection("salesOrders", "createdAt", "desc")]);
    render();
  }

  const pdf = (d) => showDocument(piSpec(d), `${safeFileName(d.piNo)}.pdf`);
  page.addEventListener("click", (e) => {
    const t = e.target.closest("[data-tab]"); if (t) { tab = t.dataset.tab; render(); return; }
    const v = e.target.closest("[data-view]"); if (v) { e.preventDefault(); openDetail(docs.find((d) => d.id === v.dataset.view)); return; }
    const p = e.target.closest("[data-pdf]"); if (p) pdf(docs.find((x) => x.id === p.dataset.pdf));
  });
  page.querySelector("#search").addEventListener("input", render);
  page.querySelector("#newDoc")?.addEventListener("click", () => openEditor());
  page.querySelector("#exportBtn").addEventListener("click", () => {
    const rows = docs.flatMap((d) => d.lines.map((l) => ({ "PI No": d.piNo, Date: fmtDate(d.date), Customer: d.customer?.name, "Customer GSTIN": d.customer?.gstin || "", Reference: d.refNo || "", "Sales Order": d.soNo || "", Item: l.name, HSN: l.hsn || "", Qty: l.qty, Unit: l.unit, Rate: l.rate, "GST %": l.gstRate, Amount: round(l.qty * l.rate, 2), Total: d.totals?.total, "Due Date": fmtDate(d.dueDate), Status: statusOf(d) })));
    if (!rows.length) { toast("Nothing to export."); return; }
    exportExcel(rows, `CCPL_Proforma_Invoices_${isoDate()}.xlsx`, "Proforma Invoices");
  });

  const dispatchFromOf = (code) => {
    const w = state.warehouses.find((x) => x.code === code);
    return w ? `${w.name}${w.destination ? ` (${w.destination})` : ""}` : "";
  };

  /* ---------------- Editor ---------------- */
  function openEditor(existing = null, { fromSo = null } = {}) {
    if (!customers.filter((c) => c.active !== false).length) { toast("Add the customer first (Purchase → Vendors & Customers).", "error"); return; }
    const editing = Boolean(existing);
    const so = fromSo;
    const d = existing || (so ? {
      customer: so.customer, refNo: so.customerPoNo || "", refDate: so.customerPoDate || "", placeOfSupply: so.placeOfSupply || "",
      dispatchFrom: dispatchFromOf(so.warehouse), shipTo: so.shipTo, notes: so.notes || "",
      termsDays: Number.parseInt(so.paymentTerms, 10) || "",
      lines: so.lines.map((l) => ({ ...l, qty: Math.max(0, round(l.qty - (l.dispatchedQty || 0))) })).filter((l) => l.qty > 0)
    } : {});
    const openSos = orders.filter((o) => ["OPEN", "PARTIALLY DISPATCHED"].includes(o.status));
    const modal = openModal({
      title: editing ? `Edit ${d.piNo}` : so ? `Proforma Invoice for ${so.soNo}` : "New Proforma Invoice",
      size: "full",
      body: `<form id="piForm" novalidate>
        ${editing || so ? "" : `<div class="notice" style="margin-bottom:14px"><label class="field" style="margin:0"><span>Copy from Sales Order (optional)</span><select name="fromSo"><option value="">— Standalone proforma invoice —</option>${openSos.map((o) => `<option value="${esc(o.id)}">${esc(o.soNo)} · ${esc(o.customer?.name)} · ₹${money(o.totals?.total)}</option>`).join("")}</select></label></div>`}
        <div class="form-grid">
        <label class="field span-2"><span>Customer (Bill To) <b class="req">*</b></span><select name="customerId"><option value="">Select customer…</option>${customers.filter((c) => c.active !== false || c.id === d.customer?.id).sort((a, b) => a.name.localeCompare(b.name)).map((c) => `<option value="${esc(c.id)}" ${c.id === d.customer?.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>
        <label class="field"><span>Invoice Date <b class="req">*</b></span><input type="date" name="date" value="${esc(d.date || isoDate())}" /></label>
        <label class="field"><span>Terms (days)</span><input type="number" min="0" step="1" name="termsDays" value="${esc(d.termsDays ?? "")}" /></label>
        <label class="field"><span>Due Date</span><input type="date" name="dueDate" value="${esc(d.dueDate || "")}" /></label>
        <label class="field"><span>Reference No. (customer PO)</span><input name="refNo" value="${esc(d.refNo || "")}" /></label>
        <label class="field"><span>Reference Date</span><input type="date" name="refDate" value="${esc(d.refDate || "")}" /></label>
        <label class="field"><span>Place Of Supply</span><input name="placeOfSupply" value="${esc(d.placeOfSupply || "")}" /></label>
        <label class="field"><span>Dispatched Through</span><input name="dispatchThrough" value="${esc(d.dispatchThrough || "")}" placeholder="e.g. Tanker / Transporter" /></label>
        <label class="field"><span>Dispatch Doc No.</span><input name="dispatchDocNo" value="${esc(d.dispatchDocNo || "")}" placeholder="Defaults to PI number" /></label>
        <label class="field"><span>Destination</span><input name="destination" value="${esc(d.destination || "")}" /></label>
        <label class="field"><span>Dispatch From</span><input name="dispatchFrom" list="piWarehouses" value="${esc(d.dispatchFrom || "")}" /><datalist id="piWarehouses">${state.warehouses.filter((w) => w.active !== false).map((w) => `<option value="${esc(dispatchFromOf(w.code))}"></option>`).join("")}</datalist></label>
        <label class="field"><span>Tax Type</span><input name="taxType" readonly /></label>
        <label class="field span-all"><span>Ship-to address (if different from billing)</span><textarea name="shipTo" rows="2">${esc((d.shipTo?.addressLines || []).join("\n"))}</textarea></label>
      </div>
      <div class="section-title">Items</div><div id="lines"></div>
      <div class="section-title">Notes & Terms</div>
      <div class="form-grid"><label class="field span-2"><span>Notes</span><textarea name="notes" rows="4">${esc(d.notes || "")}</textarea></label>
      <label class="field span-2"><span>Terms & Conditions (one per line)</span><textarea name="terms" rows="6">${esc(editing ? d.terms ?? "" : state.company.piTerms || "")}</textarea></label></div></form>`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="savePi"><i class="fa-solid fa-floppy-disk"></i> ${editing ? "Save changes" : "Create Proforma Invoice"}</button>`
    });
    const form = modal.el.querySelector("#piForm");
    const customerOf = () => customers.find((c) => c.id === form.customerId.value);
    const intra = () => { const c = customerOf(); return !c || !c.stateCode || String(c.stateCode) === String(state.company.stateCode); };
    const editor = createLineEditor(modal.el.querySelector("#lines"), { items, lines: d.lines || [], isIntraState: intra, itemFilter: (i) => i.category !== "Packaging" });
    const syncDue = () => { if (form.termsDays.value !== "") form.dueDate.value = addDays(form.date.value || isoDate(), Number(form.termsDays.value)); };
    const syncCustomer = () => {
      const c = customerOf();
      if (c && !form.placeOfSupply.value) form.placeOfSupply.value = c.stateCode ? `${STATE_CODES[c.stateCode] || c.state || ""} (${c.stateCode})` : c.state || "";
      if (c && !form.destination.value) form.destination.value = (c.city || "").toUpperCase();
      if (c?.paymentTermsDays && form.termsDays.value === "") { form.termsDays.value = c.paymentTermsDays; syncDue(); }
      form.taxType.value = intra() ? "CGST + SGST (intra-state)" : "IGST (inter-state)";
      editor.refresh();
    };
    form.customerId.addEventListener("change", () => { form.placeOfSupply.value = ""; form.destination.value = ""; syncCustomer(); });
    form.termsDays.addEventListener("input", syncDue);
    form.date.addEventListener("change", syncDue);
    form.fromSo?.addEventListener("change", () => {
      const o = orders.find((x) => x.id === form.fromSo.value);
      if (!o) return;
      modal.close();
      openEditor(null, { fromSo: o });
    });
    syncCustomer();
    if (!form.dueDate.value) syncDue();

    modal.el.querySelector("#savePi").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const v = formValues(form);
      const c = customerOf();
      let lines;
      try {
        if (!c) throw new Error("Select a customer.");
        if (!v.date) throw new Error("Enter the invoice date.");
        lines = editor.value();
      } catch (error) { toast(error.message, "error"); return; }
      const totals = computeTotals(lines, intra());
      const data = {
        date: v.date, termsDays: v.termsDays === "" ? "" : Number(v.termsDays), dueDate: v.dueDate || "",
        refNo: v.refNo, refDate: v.refDate, placeOfSupply: v.placeOfSupply, dispatchThrough: v.dispatchThrough, dispatchDocNo: v.dispatchDocNo,
        destination: v.destination, dispatchFrom: v.dispatchFrom, customerId: c.id,
        customer: { id: c.id, name: c.name, gstin: c.gstin || "", pan: c.pan || "", stateCode: c.stateCode || "", address1: c.address1 || "", address2: c.address2 || "", city: c.city || "", pincode: c.pincode || "", state: c.state || "", country: c.country || "India", phone: c.phone || "", email: c.email || "", contactPerson: c.contactPerson || "" },
        shipTo: v.shipTo ? { name: c.name, addressLines: v.shipTo.split("\n").map((s) => s.trim()).filter(Boolean) } : null,
        lines, totals, intraState: intra(), notes: v.notes, terms: v.terms, updatedAt: serverTimestamp()
      };
      const done = busy(button);
      try {
        const saved = await runTransaction(db, async (tx) => {
          if (editing) {
            const ref = doc(db, "proformaInvoices", d.id);
            const cur = (await tx.get(ref)).data();
            if (cur.status !== "ISSUED") throw new Error(`A ${cur.status.toLowerCase()} proforma invoice cannot be edited.`);
            tx.update(ref, data);
            logActivity(tx, { module: "Proforma Invoices", action: "UPDATE", refId: ref.id, refNo: cur.piNo, summary: `Edited ${cur.piNo} · ${c.name} · ₹${money(totals.total)}` });
            return cur.piNo;
          }
          const ref = doc(collection(db, "proformaInvoices"));
          const number = await reserveNumber(tx, "PI", { date: v.date });
          commitNumber(tx, number, ref.id);
          tx.set(ref, { ...data, piNo: number.number, status: "ISSUED", soId: so?.id || "", soNo: so?.soNo || "", createdAt: serverTimestamp(), createdBy: { uid: state.user.uid, name: state.profile.name || state.user.email } });
          logActivity(tx, { module: "Proforma Invoices", action: "CREATE", refId: ref.id, refNo: number.number, summary: `Created ${number.number}${so ? ` from ${so.soNo}` : ""} · ${c.name} · ${lines.map((l) => `${l.name} ${qty(l.qty)} ${l.unit}`).join(", ")} · ₹${money(totals.total)}` });
          return number.number;
        });
        toast(`${saved} saved.`, "ok");
        modal.close();
        await load();
      } catch (error) { reportError(error); } finally { done(); }
    });
  }

  /* ---------------- Detail ---------------- */
  async function openDetail(d) {
    if (!d) return;
    const logSnap = await getDocs(query(collection(db, "activity"), where("refId", "==", d.id)));
    const log = logSnap.docs.map((x) => x.data()).sort((a, b) => (b.at?.seconds || 0) - (a.at?.seconds || 0));
    const buttons = [];
    if (canEdit && d.status === "ISSUED") buttons.push('<button class="btn" data-act="edit"><i class="fa-solid fa-pen"></i> Edit</button>', '<button class="btn danger" data-act="CANCELLED">Cancel</button>', '<button class="btn gold" data-act="PAID"><i class="fa-solid fa-indian-rupee-sign"></i> Mark paid</button>');
    if (isAdmin() && d.status !== "ISSUED") buttons.push('<button class="btn" data-act="reopen">Reopen</button>');
    const modal = openModal({
      title: d.piNo,
      size: "full",
      body: `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px">${badge(statusOf(d))}<span class="muted">${esc(d.customer?.name)} · ₹${money(d.totals?.total)} · due ${fmtDate(d.dueDate)}</span>${d.soNo ? `<a href="sales-orders.html">from ${esc(d.soNo)}</a>` : ""}</div>
        ${d.statusNote ? `<div class="notice ${d.status === "PAID" ? "" : "warn"}" style="margin-bottom:14px">${esc(d.status)} by ${esc(d.statusBy?.name)} on ${fmtDateTime(d.statusAt)} — ${esc(d.statusNote)}</div>` : ""}
        <div class="table-wrap"><table class="table"><thead><tr><th>Item</th><th>HSN/SAC</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">GST</th><th class="num">Amount</th></tr></thead><tbody>
        ${d.lines.map((l) => `<tr><td class="strong">${esc(l.name)}<div class="small muted">${esc(l.description || "")}</div></td><td>${esc(l.hsn || "")}</td><td class="num">${qty(l.qty)} ${esc(l.unit)}</td><td class="num">${money(l.rate)}</td><td class="num">${l.gstRate}%</td><td class="num">${money(l.qty * l.rate)}</td></tr>`).join("")}
        </tbody></table></div>
        <div class="section-title">History</div>
        <ul class="timeline">${log.map((a) => `<li><time>${fmtDateTime(a.at)}</time><div><b>${esc(a.userName)}</b> · ${esc(a.summary)}</div></li>`).join("") || '<li class="muted">No history.</li>'}</ul>`,
      footer: `<button class="btn" data-close>Close</button>${buttons.join("")}<button class="btn primary" data-act="pdf"><i class="fa-solid fa-file-pdf"></i> View / Download PDF</button>`
    });
    modal.el.querySelector(".modal-foot").addEventListener("click", async (e) => {
      const b = e.target.closest("[data-act]"); if (!b) return;
      const act = b.dataset.act;
      if (act === "pdf") { pdf(d); return; }
      if (act === "edit") { modal.close(); openEditor(d); return; }
      let note = "";
      if (act === "reopen") { if (!(await confirmDialog(`Reopen ${d.piNo} as unpaid?`))) return; }
      else {
        note = await confirmDialog(act === "PAID" ? `Mark ${d.piNo} (₹${money(d.totals?.total)}) as paid?` : `Cancel ${d.piNo}?`,
          { title: "Proforma Invoice", danger: act === "CANCELLED", okText: "Confirm", input: { label: act === "PAID" ? "Payment reference (UTR / cheque no. / date)" : "Reason", required: true } });
        if (!note) return;
      }
      const done = busy(b);
      try {
        await runTransaction(db, async (tx) => {
          const ref = doc(db, "proformaInvoices", d.id);
          const cur = (await tx.get(ref)).data();
          const allowed = act === "reopen" ? ["PAID", "CANCELLED"] : ["ISSUED"];
          if (!allowed.includes(cur.status)) throw new Error(`Cannot change status from ${cur.status}.`);
          const status = act === "reopen" ? "ISSUED" : act;
          tx.update(ref, { status, statusNote: note, statusAt: serverTimestamp(), statusBy: { uid: state.user.uid, name: state.profile.name || state.user.email }, updatedAt: serverTimestamp() });
          logActivity(tx, { module: "Proforma Invoices", action: act === "reopen" ? "REOPEN" : act, refId: d.id, refNo: cur.piNo, summary: `${cur.piNo} → ${status}${note ? `. ${act === "PAID" ? "Payment ref" : "Reason"}: ${note}` : ""}` });
        });
        toast("Updated.", "ok");
        modal.close();
        await load();
      } catch (error) { reportError(error); } finally { done(); }
    });
  }

  await load();
  document.body.dataset.loaded = "1";
  // Arriving from a Sales Order's "Create Proforma Invoice" button
  const soId = sessionStorage.getItem(FROM_SO_KEY);
  if (soId && canEdit) {
    sessionStorage.removeItem(FROM_SO_KEY);
    const so = orders.find((o) => o.id === soId);
    if (so) openEditor(null, { fromSo: so });
  }
}
