// Stock by warehouse, split into RM (purchased / raw) and Ready (processed, ready to sell) — the same product can be
// held in both. Inward lands in RM; "Process RM → Ready" moves it (with an optional BMR / batch reference).
// Material weighed on the Kanta but waiting for QC release is shown separately as "Under QC" and is NOT stock.
import {
  db, reportError, state, initPage, pageHeader, esc, toast, openModal, confirmDialog, badge, listCollection, qty, fmtDate, fmtDateTime, isoDate, round, busy, formValues, can, isAdmin,
  activeWarehouses, warehouseByCode, warehouseOptions, exportExcel, ITEM_CATEGORIES, reserveNumber, commitNumber, readStock, applyMovements, logActivity,
  stockId, stageOf, stageLabel, STOCK_STAGES, normalizeReceipt, acceptedOf
} from "./core.js";
import { collection, doc, getDocs, query, runTransaction, serverTimestamp, where } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { uploadFiles } from "./uploads.js";

const page = await initPage("inventory");
if (page) start();

const n = (v) => Number(v) || 0;
const isPackaging = (it) => it?.category === "Packaging";
const isService = (it) => it?.category === "Service";

async function start() {
  let stock = []; let items = []; let quarantine = []; let conversions = [];
  let view = "ALL";
  const whs = activeWarehouses();
  const canProcess = can("operations");
  page.innerHTML = `${pageHeader("Inventory", "Stock", "Live stock in every warehouse — RM (raw / purchased) and Ready (processed), packaging, and material held under QC.",
    `<button class="btn" id="exportBtn"><i class="fa-solid fa-download"></i> Export</button>
     ${canProcess ? '<button class="btn gold" id="processBtn"><i class="fa-solid fa-industry"></i> Process RM → Ready</button>' : ""}
     ${can("close") ? '<button class="btn primary" id="openingBtn"><i class="fa-solid fa-box-archive"></i> Add Existing / Opening Stock</button>' : ""}`)}
    <div class="grid cols-4" id="whCards" style="margin-bottom:16px"></div>
    <div class="tabs" id="tabs"></div>
    <div class="card" id="stockCard">
      <div class="card-head"><div class="toolbar"><input class="input search" id="search" placeholder="Search item…" />
        <select class="input" id="cat"><option value="">All categories</option>${ITEM_CATEGORIES.filter((c) => c !== "Service").map((c) => `<option>${c}</option>`).join("")}</select>
        <label class="small muted"><input type="checkbox" id="zero" /> Show zero stock</label></div><span class="small muted" id="count"></span></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Item</th><th>Stock</th><th>Category</th><th>Unit</th>${whs.map((w) => `<th class="num">${esc(w.name)}</th>`).join("")}<th class="num">Total</th><th></th></tr></thead><tbody id="rows"></tbody></table></div>
    </div>
    <div id="extra"></div>`;

  const TABS = [["ALL", "All stock"], ["RM", "RM (raw / purchased)"], ["READY", "Ready"], ["PKG", "Packaging"], ["QC", "Under QC (not in stock)"], ["PROCESS", "Process history"]];
  const kindOf = (r) => (isPackaging(r.item) ? "PKG" : r.stage);

  const matrix = () => {
    const rows = new Map();
    const keyOf = (itemId, stage) => `${itemId}|${stage}`;
    items.filter((i) => !isService(i)).forEach((i) => rows.set(keyOf(i.id, "RM"), { item: i, stage: "RM", per: {}, total: 0 }));
    stock.forEach((s) => {
      const stage = stageOf(s.stage);
      const k = keyOf(s.itemId, stage);
      if (!rows.has(k)) rows.set(k, { item: items.find((i) => i.id === s.itemId) || { id: s.itemId, name: s.itemName, unit: s.unit, category: s.category }, stage, per: {}, total: 0 });
      const row = rows.get(k);
      row.per[s.warehouse] = round((row.per[s.warehouse] || 0) + n(s.qty));
      row.total = round(row.total + n(s.qty));
    });
    return [...rows.values()].sort((a, b) => a.item.name.localeCompare(b.item.name) || a.stage.localeCompare(b.stage));
  };

  function render() {
    page.querySelector("#tabs").innerHTML = TABS.map(([k, l]) => `<button class="tab ${k === view ? "active" : ""}" data-tab="${k}">${l}${k === "QC" ? `<span class="count">${quarantine.length}</span>` : ""}</button>`).join("");
    const m = matrix();
    page.querySelector("#whCards").innerHTML = whs.map((w) => {
      const here = stock.filter((s) => s.warehouse === w.code && s.qty > 0);
      const pkg = here.filter((s) => s.category === "Packaging").length;
      const ready = here.filter((s) => s.category !== "Packaging" && stageOf(s.stage) === "READY").length;
      const held = quarantine.filter((r) => r.warehouse === w.code).length;
      return `<div class="card kpi"><div class="label"><i class="fa-solid fa-warehouse"></i>${esc(w.name)}</div><div class="value">${here.length - pkg - ready} RM · ${ready} Ready</div><div class="hint">${pkg} packaging types${held ? ` · ${held} under QC` : ""}</div></div>`;
    }).join("");
    const card = page.querySelector("#stockCard");
    const extra = page.querySelector("#extra");
    card.hidden = ["QC", "PROCESS"].includes(view);
    extra.innerHTML = view === "QC" ? quarantineHtml() : view === "PROCESS" ? processHtml() : "";
    if (card.hidden) return;
    const term = page.querySelector("#search").value.trim().toLowerCase();
    const cat = page.querySelector("#cat").value;
    const zero = page.querySelector("#zero").checked;
    const list = m.filter((r) => (zero || r.total > 0) && (view === "ALL" || kindOf(r) === view) && (!cat || r.item.category === cat) && (!term || r.item.name.toLowerCase().includes(term)));
    page.querySelector("#count").textContent = `${list.length} rows`;
    const rows = page.querySelector("#rows");
    if (!list.length) { rows.innerHTML = `<tr><td class="empty" colspan="${whs.length + 6}">No stock here. Stock is created by Kanta / QC release, transfers, processing and adjustments.</td></tr>`; return; }
    rows.innerHTML = list.map((r) => {
      const low = r.item.reorderLevel && r.stage === "RM" && r.total < r.item.reorderLevel;
      return `<tr data-row="${esc(r.item.name)}|${r.stage}"><td class="strong">${esc(r.item.name)}${low ? ' <span class="badge red">Below reorder</span>' : ""}</td>
        <td>${isPackaging(r.item) ? '<span class="badge gray">Packaging</span>' : badge(r.stage)}</td><td>${esc(r.item.category || "—")}</td><td>${esc(r.item.unit)}</td>
        ${whs.map((w) => `<td class="num">${r.per[w.code] ? qty(r.per[w.code]) : '<span class="muted">—</span>'}</td>`).join("")}
        <td class="num strong">${qty(r.total)}</td><td><button class="btn sm" data-ledger="${esc(r.item.id)}">Ledger</button></td></tr>`;
    }).join("");
  }

  function quarantineHtml() {
    return `<div class="card"><div class="card-head"><h3><i class="fa-solid fa-flask"></i> Under QC — weighed, not in stock</h3><span class="small muted">Released by a manager / admin from Inward → Awaiting QC</span></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Receipt / GRN</th><th>Warehouse</th><th>Supplier</th><th>Item</th><th class="num">Qty in quarantine</th><th>Kanta</th></tr></thead><tbody>
      ${quarantine.flatMap((r) => r.lines.map((l) => `<tr><td class="strong nowrap">${esc(r.geNo)}<div class="small muted">${esc(r.grn?.grnNo || "")} · invoice ${esc(r.invoiceNo || "—")}</div></td><td>${esc(warehouseByCode(r.warehouse).name)}</td><td>${esc(r.vendor?.name)}</td><td>${esc(l.name)}</td><td class="num strong">${qty(acceptedOf(l))} ${esc(l.unit)}</td><td class="small">${fmtDateTime(r.kanta?.at)}</td></tr>`)).join("") || '<tr><td class="empty" colspan="6">Nothing is waiting for QC.</td></tr>'}
      </tbody></table></div></div>`;
  }

  function processHtml() {
    return `<div class="card"><div class="card-head"><h3><i class="fa-solid fa-industry"></i> Process history (RM → Ready)</h3></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>No.</th><th>Date</th><th>Warehouse</th><th>From RM</th><th>To Ready</th><th class="num">Process loss</th><th>BMR / Batch</th><th>By</th><th>Status</th><th></th></tr></thead><tbody>
      ${conversions.map((c) => `<tr><td class="strong nowrap">${esc(c.cvNo)}</td><td class="nowrap">${fmtDate(c.date)}</td><td>${esc(warehouseByCode(c.warehouse).name)}</td>
        <td class="small">${c.inputs.map((l) => `${esc(l.name)} ${qty(l.qty)} ${esc(l.unit)}`).join("<br>")}</td><td class="small">${c.outputs.map((l) => `${esc(l.name)} ${qty(l.qty)} ${esc(l.unit)}`).join("<br>")}</td>
        <td class="num">${c.lossQty === null || c.lossQty === undefined ? "—" : qty(c.lossQty)}</td><td>${esc(c.bmrNo || c.batchNo || "—")}${c.bmrNo && c.batchNo ? `<div class="small muted">${esc(c.batchNo)}</div>` : ""}</td><td class="small">${esc(c.createdBy?.name)}</td><td>${badge(c.status)}</td>
        <td>${isAdmin() && c.status === "POSTED" ? `<button class="btn sm danger" data-revcv="${esc(c.id)}">Reverse</button>` : ""}</td></tr>`).join("") || '<tr><td class="empty" colspan="10">No processing recorded yet.</td></tr>'}
      </tbody></table></div></div>`;
  }

  async function load() {
    let receipts;
    [stock, items, receipts, conversions] = await Promise.all([
      listCollection("inventory"), listCollection("items"),
      getDocs(query(collection(db, "receipts"), where("stage", "==", "QC PENDING"))).then((s) => s.docs.map((d) => normalizeReceipt({ id: d.id, ...d.data() }))),
      listCollection("conversions", "createdAt", "desc")
    ]);
    quarantine = receipts;
    render();
  }

  async function openLedger(itemId) {
    const item = items.find((i) => i.id === itemId) || { name: stock.find((s) => s.itemId === itemId)?.itemName, unit: "" };
    const snap = await getDocs(query(collection(db, "stockLedger"), where("itemId", "==", itemId)));
    const rows = snap.docs.map((d) => d.data()).sort((a, b) => (b.at?.seconds || 0) - (a.at?.seconds || 0) || (b.at?.nanoseconds || 0) - (a.at?.nanoseconds || 0));
    const modal = openModal({
      title: `Stock ledger · ${item.name}`,
      size: "full",
      body: `<div class="toolbar" style="margin-bottom:12px"><select class="input" id="lw"><option value="">All warehouses</option>${whs.map((w) => `<option value="${esc(w.code)}">${esc(w.name)}</option>`).join("")}</select>
        <select class="input" id="ls"><option value="">RM &amp; Ready</option><option value="RM">RM only</option><option value="READY">Ready only</option></select></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Date & time</th><th>Warehouse</th><th>Stock</th><th>Type</th><th>Reference</th><th class="num">In</th><th class="num">Out</th><th class="num">Balance</th><th>Note</th><th>By</th></tr></thead><tbody id="lrows"></tbody></table></div>`,
      footer: '<button class="btn" data-close>Close</button><button class="btn" id="lexp"><i class="fa-solid fa-download"></i> Export</button>'
    });
    const draw = () => {
      const w = modal.el.querySelector("#lw").value;
      const st = modal.el.querySelector("#ls").value;
      const list = rows.filter((r) => (!w || r.warehouse === w) && (!st || stageOf(r.stage) === st));
      modal.el.querySelector("#lrows").innerHTML = list.map((r) => `<tr><td class="nowrap">${fmtDateTime(r.at)}</td><td>${esc(warehouseByCode(r.warehouse).name)}</td><td>${esc(stageLabel(r.stage))}</td><td>${esc(r.refType)}</td><td class="nowrap">${esc(r.refNo)}</td><td class="num" style="color:var(--success)">${r.qtyIn ? qty(r.qtyIn) : ""}</td><td class="num" style="color:var(--danger)">${r.qtyOut ? qty(r.qtyOut) : ""}</td><td class="num strong">${qty(r.balance)}</td><td class="small">${esc(r.note)}</td><td class="small">${esc(r.userName)}</td></tr>`).join("") || '<tr><td class="empty" colspan="10">No movements.</td></tr>';
      return list;
    };
    modal.el.querySelector("#lw").addEventListener("change", draw);
    modal.el.querySelector("#ls").addEventListener("change", draw);
    modal.el.querySelector("#lexp").addEventListener("click", () => {
      const list = draw();
      if (!list.length) return;
      exportExcel(list.map((r) => ({ "Date & Time": fmtDateTime(r.at), Warehouse: warehouseByCode(r.warehouse).name, Stock: stageLabel(r.stage), Item: r.itemName, Type: r.refType, Reference: r.refNo, In: r.qtyIn, Out: r.qtyOut, Balance: r.balance, Unit: r.unit, Note: r.note, By: r.userName })), `Ledger_${item.name}_${isoDate()}.xlsx`, "Ledger");
    });
    draw();
  }

  page.addEventListener("click", (e) => {
    const t = e.target.closest("[data-tab]"); if (t) { view = t.dataset.tab; render(); return; }
    const l = e.target.closest("[data-ledger]"); if (l) { openLedger(l.dataset.ledger); return; }
    const rv = e.target.closest("[data-revcv]"); if (rv) reverseProcess(conversions.find((c) => c.id === rv.dataset.revcv));
  });
  ["#search", "#cat", "#zero"].forEach((s) => page.querySelector(s).addEventListener(s === "#search" ? "input" : "change", render));
  page.querySelector("#exportBtn").addEventListener("click", () => {
    const m = matrix().filter((r) => r.total > 0);
    if (!m.length) { toast("Nothing to export."); return; }
    exportExcel(m.map((r) => ({ Item: r.item.name, Stock: isPackaging(r.item) ? "Packaging" : stageLabel(r.stage), Category: r.item.category, Unit: r.item.unit, ...Object.fromEntries(whs.map((w) => [w.name, r.per[w.code] || 0])), Total: r.total })), `CCPL_Stock_${isoDate()}.xlsx`, "Stock");
  });
  page.querySelector("#openingBtn")?.addEventListener("click", openOpeningStock);
  page.querySelector("#processBtn")?.addEventListener("click", openProcess);

  const available = (wh, itemId, stage) => n(stock.find((s) => s.id === stockId(wh, itemId, stage))?.qty);

  /* ---------------- Process RM → Ready (BMR optional) ---------------- */
  function openProcess() {
    let inputs = [{ itemId: "", qty: "" }];
    let outputs = [{ itemId: "", qty: "", auto: true }];
    const modal = openModal({
      title: "Process RM → Ready",
      size: "full",
      body: `<p class="muted" style="margin-top:0">Takes material out of <b>RM</b> stock and puts the result into <b>Ready</b> stock in the same warehouse. The output can be the same product (e.g. Methanol RM → Methanol Ready) or a different one. A BMR is optional — leave it blank if there is none.</p>
        <form id="pForm" novalidate><div class="form-grid">
          <label class="field"><span>Warehouse <b class="req">*</b></span><select name="warehouse">${warehouseOptions()}</select></label>
          <label class="field"><span>Date <b class="req">*</b></span><input type="date" name="date" value="${isoDate()}" /></label>
          <label class="field"><span>BMR No. (optional)</span><input name="bmrNo" placeholder="Leave blank if no BMR" /></label>
          <label class="field"><span>Batch No. (optional)</span><input name="batchNo" placeholder="e.g. F2610001" /></label>
          <label class="field span-all"><span>Remarks</span><input name="remarks" placeholder="e.g. distilled / filtered / repacked as Ready stock" /></label></div>
        <div class="section-title">Taken from RM</div><div id="inRows"></div><button type="button" class="btn sm" id="addIn" style="margin-top:8px"><i class="fa-solid fa-plus"></i> Add input</button>
        <div class="section-title">Into Ready</div><div id="outRows"></div><button type="button" class="btn sm" id="addOut" style="margin-top:8px"><i class="fa-solid fa-plus"></i> Add output</button>
        <div id="lossBox" style="margin-top:14px"></div></form>`,
      footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="savePr"><i class="fa-solid fa-industry"></i> Post process</button>'
    });
    const f = modal.el.querySelector("#pForm");
    const goods = () => items.filter((i) => i.active !== false && !isPackaging(i) && !isService(i));
    const drawTable = (host, list, kind) => {
      const wh = f.warehouse.value;
      const options = kind === "in" ? goods().filter((i) => !wh || available(wh, i.id, "RM") > 0) : goods();
      host.innerHTML = `<table class="table"><thead><tr><th style="min-width:220px">Item</th>${kind === "in" ? '<th class="num">RM available</th>' : '<th class="num">Ready now</th>'}<th class="num" style="width:160px">Qty</th><th>Unit</th><th></th></tr></thead><tbody>
        ${list.map((l, i) => { const it = items.find((x) => x.id === l.itemId); return `<tr data-k="${kind}" data-i="${i}"><td><select data-f="itemId"><option value="">${kind === "in" && wh ? "Select RM in stock…" : kind === "in" ? "Select warehouse first" : "Select…"}</option>${options.map((x) => `<option value="${esc(x.id)}" ${x.id === l.itemId ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></td>
          <td class="num">${it && wh ? qty(available(wh, it.id, kind === "in" ? "RM" : "READY")) : "—"}</td><td><input data-f="qty" type="number" step="any" min="0" class="num" value="${esc(l.qty)}" /></td><td>${esc(it?.unit || "—")}</td>
          <td>${list.length > 1 ? '<button type="button" class="icon-btn" data-rm><i class="fa-solid fa-trash"></i></button>' : ""}</td></tr>`; }).join("")}</tbody></table>`;
    };
    const drawLoss = () => {
      const ins = inputs.filter((l) => l.itemId && n(l.qty) > 0); const outs = outputs.filter((l) => l.itemId && n(l.qty) > 0);
      const units = new Set([...ins, ...outs].map((l) => items.find((x) => x.id === l.itemId)?.unit));
      const box = modal.el.querySelector("#lossBox");
      if (!ins.length || !outs.length) { box.innerHTML = ""; return; }
      if (units.size !== 1) { box.innerHTML = '<p class="small muted">Inputs and outputs have different units — process loss is not calculated.</p>'; return; }
      const loss = round(ins.reduce((s, l) => s + n(l.qty), 0) - outs.reduce((s, l) => s + n(l.qty), 0));
      box.innerHTML = `<div class="notice ${loss < 0 ? "error" : loss > 0 ? "warn" : "ok"}"><div>Process loss: <b>${qty(loss)} ${esc([...units][0])}</b>${loss < 0 ? " — output is more than input; check the quantities." : ""}</div></div>`;
    };
    const draw = () => { drawTable(modal.el.querySelector("#inRows"), inputs, "in"); drawTable(modal.el.querySelector("#outRows"), outputs, "out"); drawLoss(); };
    const listOf = (kind) => (kind === "in" ? inputs : outputs);
    f.addEventListener("change", (e) => {
      if (e.target.name === "warehouse") { draw(); return; }
      const tr = e.target.closest("tr[data-k]"); if (!tr || e.target.dataset.f !== "itemId") return;
      const list = listOf(tr.dataset.k); const i = Number(tr.dataset.i);
      list[i].itemId = e.target.value;
      // same product by default: the first input fills the first (untouched) output
      if (tr.dataset.k === "in" && i === 0 && outputs[0]?.auto) { outputs[0].itemId = e.target.value; outputs[0].qty = inputs[0].qty; }
      if (tr.dataset.k === "out") list[i].auto = false;
      draw();
    });
    f.addEventListener("input", (e) => {
      const tr = e.target.closest("tr[data-k]"); if (!tr || e.target.dataset.f !== "qty") return;
      const list = listOf(tr.dataset.k); const i = Number(tr.dataset.i);
      list[i].qty = e.target.value;
      if (tr.dataset.k === "in" && i === 0 && outputs[0]?.auto) { outputs[0].qty = e.target.value; const o = modal.el.querySelector('tr[data-k="out"][data-i="0"] [data-f="qty"]'); if (o) o.value = e.target.value; }
      if (tr.dataset.k === "out") list[i].auto = false;
      drawLoss();
    });
    f.addEventListener("click", (e) => { const rm = e.target.closest("[data-rm]"); if (!rm) return; const tr = rm.closest("tr[data-k]"); listOf(tr.dataset.k).splice(Number(tr.dataset.i), 1); draw(); });
    modal.el.querySelector("#addIn").addEventListener("click", () => { inputs.push({ itemId: "", qty: "" }); draw(); });
    modal.el.querySelector("#addOut").addEventListener("click", () => { outputs.push({ itemId: "", qty: "", auto: false }); draw(); });
    draw();

    modal.el.querySelector("#savePr").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const v = formValues(f);
      const clean = (list) => list.filter((l) => l.itemId && n(l.qty) > 0).map((l) => { const it = items.find((x) => x.id === l.itemId); return { itemId: it.id, name: it.name, unit: it.unit, category: it.category || "", qty: round(n(l.qty)) }; });
      const ins = clean(inputs); const outs = clean(outputs);
      try {
        if (!v.warehouse) throw new Error("Select the warehouse.");
        if (!ins.length) throw new Error("Add the RM taken (item and quantity).");
        if (!outs.length) throw new Error("Add the Ready output (item and quantity).");
        if (new Set(ins.map((l) => l.itemId)).size !== ins.length || new Set(outs.map((l) => l.itemId)).size !== outs.length) throw new Error("Each item can appear only once on each side.");
      } catch (error) { toast(error.message, "error"); return; }
      const sameUnit = new Set([...ins, ...outs].map((l) => l.unit)).size === 1;
      const lossQty = sameUnit ? round(ins.reduce((s, l) => s + l.qty, 0) - outs.reduce((s, l) => s + l.qty, 0)) : null;
      if (lossQty !== null && lossQty < 0 && !(await confirmDialog(`Output is ${qty(-lossQty)} more than the input. Post anyway?`))) return;
      const done = busy(button);
      try {
        const ref = doc(collection(db, "conversions"));
        const no = await runTransaction(db, async (tx) => {
          const tag = `${v.bmrNo ? ` · BMR ${v.bmrNo}` : ""}${v.batchNo ? ` · batch ${v.batchNo}` : ""}`;
          const movements = [
            ...ins.map((l) => ({ warehouse: v.warehouse, stage: "RM", item: { id: l.itemId, name: l.name, unit: l.unit, category: l.category }, qty: -l.qty, note: `Processed to Ready${tag}` })),
            ...outs.map((l) => ({ warehouse: v.warehouse, stage: "READY", item: { id: l.itemId, name: l.name, unit: l.unit, category: l.category }, qty: l.qty, note: `Ready from RM${tag}` }))
          ];
          const stockMap = await readStock(tx, movements.map((m) => ({ warehouse: m.warehouse, itemId: m.item.id, stage: m.stage })));
          const number = await reserveNumber(tx, "PR", { date: v.date });
          commitNumber(tx, number, ref.id);
          applyMovements(tx, stockMap, movements, { type: "PROCESS RM → READY", id: ref.id, no: number.number });
          tx.set(ref, { cvNo: number.number, date: v.date, warehouse: v.warehouse, inputs: ins, outputs: outs, lossQty, bmrNo: v.bmrNo, batchNo: v.batchNo, remarks: v.remarks, status: "POSTED", createdAt: serverTimestamp(), createdBy: { uid: state.user.uid, name: state.profile.name || state.user.email } });
          logActivity(tx, { module: "Stock", action: "PROCESS RM → READY", refId: ref.id, refNo: number.number, summary: `${number.number} at ${warehouseByCode(v.warehouse).name}: RM ${ins.map((l) => `${l.name} ${qty(l.qty)} ${l.unit}`).join(", ")} → Ready ${outs.map((l) => `${l.name} ${qty(l.qty)} ${l.unit}`).join(", ")}${lossQty !== null ? ` · process loss ${qty(lossQty)}` : ""}${v.bmrNo ? ` · BMR ${v.bmrNo}` : " · no BMR"}${v.batchNo ? ` · batch ${v.batchNo}` : ""}` });
          return number.number;
        });
        toast(`${no} posted — Ready stock updated.`, "ok");
        modal.close();
        await load();
      } catch (error) { reportError(error); } finally { done(); }
    });
  }

  async function reverseProcess(c) {
    const reason = await confirmDialog(`Reverse ${c.cvNo}? The Ready output goes back out and the RM input is restored.`, { title: "Reverse process", danger: true, okText: "Reverse", input: { label: "Reason", required: true } });
    if (!reason) return;
    try {
      await runTransaction(db, async (tx) => {
        const ref = doc(db, "conversions", c.id);
        const cur = (await tx.get(ref)).data();
        if (cur.status !== "POSTED") throw new Error("Already reversed.");
        const movements = [
          ...cur.outputs.map((l) => ({ warehouse: cur.warehouse, stage: "READY", item: { id: l.itemId, name: l.name, unit: l.unit, category: l.category }, qty: -l.qty, note: `Reversal of ${cur.cvNo}: ${reason}` })),
          ...cur.inputs.map((l) => ({ warehouse: cur.warehouse, stage: "RM", item: { id: l.itemId, name: l.name, unit: l.unit, category: l.category }, qty: l.qty, note: `Reversal of ${cur.cvNo}: ${reason}` }))
        ];
        const stockMap = await readStock(tx, movements.map((m) => ({ warehouse: m.warehouse, itemId: m.item.id, stage: m.stage })));
        applyMovements(tx, stockMap, movements, { type: "PROCESS REVERSAL", id: c.id, no: cur.cvNo });
        tx.update(ref, { status: "REVERSED", reverseReason: reason, reversedAt: serverTimestamp(), reversedBy: { uid: state.user.uid, name: state.profile.name || state.user.email } });
        logActivity(tx, { module: "Stock", action: "PROCESS REVERSED", refId: c.id, refNo: cur.cvNo, summary: `Reversed ${cur.cvNo}. Reason: ${reason}` });
      });
      toast(`${c.cvNo} reversed.`, "ok");
      await load();
    } catch (error) { reportError(error); }
  }

  // Direct stock that did not come through a PO / GRN (old stock, bulk stock found, migration).
  // Saved as its own entry type with reason, date and user; corrections are reversals, never silent edits.
  function openOpeningStock() {
    const modal = openModal({
      title: "Add Existing / Opening Stock",
      size: "wide",
      body: `<div class="notice info" style="margin-bottom:14px"><i class="fa-solid fa-circle-info"></i><div>Use this only for stock that did <b>not</b> come through a PO / GRN — e.g. stock already lying in the warehouse when the ERP started. It is recorded separately and appears under Exceptions → Stock manually adjusted. To correct it later, an admin reverses it from Write-off / Adjust (history is kept).</div></div>
        <form id="osForm" class="form-grid" novalidate>
          <label class="field"><span>Warehouse <b class="req">*</b></span><select name="warehouse">${warehouseOptions()}</select></label>
          <label class="field span-2"><span>Item <b class="req">*</b></span><select name="itemId"><option value="">Select…</option>${items.filter((i) => i.active !== false && !isService(i)).map((i) => `<option value="${esc(i.id)}">${esc(i.name)} (${esc(i.unit)})</option>`).join("")}</select></label>
          <label class="field"><span>Stock <b class="req">*</b></span><select name="stage">${Object.entries(STOCK_STAGES).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select><small class="help">Packaging is always kept as one stock.</small></label>
          <label class="field"><span>Quantity <b class="req">*</b></span><input type="number" step="any" min="0" name="qty" /></label>
          <label class="field"><span>Stock as on date</span><input type="date" name="date" value="${isoDate()}" /></label>
          <label class="field span-2"><span>Reason / source <b class="req">*</b></span><input name="reason" placeholder="e.g. Opening stock physically counted on 01-10-2026" /></label>
          <label class="field span-2"><span>Reference (count sheet no. etc.)</span><input name="reference" /></label>
          <label class="field span-2"><span>Supporting document</span><input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png,.xls,.xlsx" /></label>
        </form>`,
      footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="saveOs"><i class="fa-solid fa-check"></i> Add to stock</button>'
    });
    const f = modal.el.querySelector("#osForm");
    modal.el.querySelector("#saveOs").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const v = formValues(f);
      const item = items.find((i) => i.id === v.itemId);
      const q = Number(v.qty);
      if (!v.warehouse || !item) { toast("Select the warehouse and item.", "error"); return; }
      if (!Number.isFinite(q) || q <= 0) { toast("Enter a quantity greater than 0.", "error"); return; }
      if (!v.reason) { toast("Enter the reason / source of this stock.", "error"); return; }
      const stage = isPackaging(item) ? "RM" : stageOf(v.stage);
      const done = busy(button);
      try {
        const ref = doc(collection(db, "adjustments"));
        const docs = await uploadFiles(`adjustments/${ref.id}`, { attachment: f.file.files[0] });
        const no = await runTransaction(db, async (tx) => {
          const stockMap = await readStock(tx, [{ warehouse: v.warehouse, itemId: item.id, stage }]);
          const number = await reserveNumber(tx, "OS", { date: v.date || isoDate() });
          commitNumber(tx, number, ref.id);
          const it = { id: item.id, name: item.name, unit: item.unit, category: item.category };
          applyMovements(tx, stockMap, [{ warehouse: v.warehouse, stage, item: it, qty: q, note: `Opening / existing stock: ${v.reason}` }], { type: "OPENING STOCK", id: ref.id, no: number.number });
          tx.set(ref, { adjNo: number.number, kind: "OPENING", date: v.date, warehouse: v.warehouse, stage, type: "Opening / existing stock", item: it, qty: round(q), reason: v.reason, reference: v.reference, docs, status: "POSTED", createdAt: serverTimestamp(), createdBy: { uid: state.user.uid, name: state.profile.name || state.user.email } });
          logActivity(tx, { module: "Stock Adjustment", action: "OPENING STOCK", refId: ref.id, refNo: number.number, summary: `${number.number} opening / existing stock +${qty(q)} ${item.unit} ${item.name} (${isPackaging(item) ? "packaging" : stageLabel(stage)}) at ${warehouseByCode(v.warehouse).name} (as on ${v.date}). ${v.reason}` });
          return number.number;
        });
        toast(`${no} added to stock.`, "ok");
        modal.close();
        await load();
      } catch (error) { reportError(error); } finally { done(); }
    });
  }

  await load();
  document.body.dataset.loaded = "1";
}
