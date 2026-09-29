// Internal stock transfer between warehouses (e.g. PG factory → Taloja).
// Dispatch deducts from the source immediately (IN TRANSIT); receiving adds to the destination.
// Any difference on receipt is recorded as a transit loss.
import {
  db, reportError, state, initPage, pageHeader, esc, toast, openModal, confirmDialog, badge, busy, formValues, can,
  listCollection, logActivity, qty, fmtDate, fmtDateTime, isoDate, round, reserveNumber, commitNumber,
  warehouseByCode, warehouseOptions, readStock, applyMovements, exportExcel, stockId
} from "./core.js";
import { collection, doc, runTransaction, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const page = await initPage("transfers");
if (page) start();

async function start() {
  let transfers = []; let items = []; let stock = [];
  let tab = "IN TRANSIT";
  const canOperate = can("operations");

  page.innerHTML = `${pageHeader("Inventory", "Stock Transfer", "Move material between PG-106, PG-153, Breeze and Taloja with full traceability.",
    `<button class="btn" id="exportBtn"><i class="fa-solid fa-download"></i> Export</button>${canOperate ? '<button class="btn primary" id="newTr"><i class="fa-solid fa-right-left"></i> New Transfer</button>' : ""}`)}
    <div class="tabs" id="tabs"></div>
    <div class="card"><div class="table-wrap"><table class="table"><thead><tr><th>Transfer No.</th><th>Date</th><th>From</th><th>To</th><th>Items</th><th>Vehicle</th><th>Status</th><th></th></tr></thead><tbody id="rows"></tbody></table></div></div>`;

  const TABS = [["IN TRANSIT", "In transit"], ["RECEIVED", "Received"], ["CANCELLED", "Cancelled"], ["ALL", "All"]];
  function render() {
    page.querySelector("#tabs").innerHTML = TABS.map(([k, l]) => `<button class="tab ${k === tab ? "active" : ""}" data-tab="${k}">${l}<span class="count">${transfers.filter((t) => k === "ALL" || t.status === k).length}</span></button>`).join("");
    const list = transfers.filter((t) => tab === "ALL" || t.status === tab);
    const rows = page.querySelector("#rows");
    if (!list.length) { rows.innerHTML = '<tr><td class="empty" colspan="8">No transfers here.</td></tr>'; return; }
    rows.innerHTML = list.map((t) => `<tr>
      <td class="strong nowrap"><a href="#" data-view="${esc(t.id)}">${esc(t.trNo)}</a></td><td class="nowrap">${fmtDate(t.date)}</td>
      <td>${esc(warehouseByCode(t.from).name)}</td><td>${esc(warehouseByCode(t.to).name)}</td>
      <td>${t.lines.map((l) => `${esc(l.name)} <b>${qty(l.qtySent)} ${esc(l.unit)}</b>${l.qtyReceived !== undefined && l.qtyReceived !== null ? ` → ${qty(l.qtyReceived)}${l.lossQty > 0 ? ` <span class="badge red">loss ${qty(l.lossQty)}</span>` : ""}` : ""}`).join("<br>")}</td>
      <td>${esc(t.vehicleNo || "—")}</td><td>${badge(t.status)}</td>
      <td><div class="actions">${canOperate && t.status === "IN TRANSIT" ? `<button class="btn sm primary" data-receive="${esc(t.id)}">Receive</button>` : ""}${can("close") && t.status === "IN TRANSIT" ? `<button class="btn sm danger" data-cancel="${esc(t.id)}">Cancel</button>` : ""}</div></td>
    </tr>`).join("");
  }
  async function load() {
    [transfers, items, stock] = await Promise.all([listCollection("transfers", "createdAt", "desc"), listCollection("items"), listCollection("inventory")]);
    render();
  }
  const available = (wh, itemId) => Number(stock.find((s) => s.id === stockId(wh, itemId))?.qty || 0);

  page.addEventListener("click", (e) => {
    const t = e.target.closest("[data-tab]"); if (t) { tab = t.dataset.tab; render(); return; }
    const find = (id) => transfers.find((x) => x.id === id);
    const r = e.target.closest("[data-receive]"); if (r) { openReceive(find(r.dataset.receive)); return; }
    const c = e.target.closest("[data-cancel]"); if (c) { cancelTransfer(find(c.dataset.cancel)); return; }
    const v = e.target.closest("[data-view]"); if (v) { e.preventDefault(); openView(find(v.dataset.view)); }
  });
  page.querySelector("#newTr")?.addEventListener("click", openNew);
  page.querySelector("#exportBtn").addEventListener("click", () => {
    const rows = transfers.flatMap((t) => t.lines.map((l) => ({ "Transfer No": t.trNo, Date: fmtDate(t.date), From: warehouseByCode(t.from).name, To: warehouseByCode(t.to).name, Item: l.name, Unit: l.unit, Sent: l.qtySent, Received: l.qtyReceived ?? "", "Transit Loss": l.lossQty ?? "", "Loss Reason": l.lossReason || "", Status: t.status, Vehicle: t.vehicleNo, "Sent By": t.createdBy?.name, "Received By": t.receivedBy?.name || "", "Received At": t.receivedAt ? fmtDateTime(t.receivedAt) : "" })));
    if (!rows.length) { toast("Nothing to export."); return; }
    exportExcel(rows, `CCPL_Stock_Transfers_${isoDate()}.xlsx`, "Transfers");
  });

  function openNew() {
    let lines = [{ itemId: "", qty: "" }];
    const modal = openModal({
      title: "New Stock Transfer",
      size: "wide",
      body: `<form id="tForm" novalidate><div class="form-grid">
        <label class="field"><span>From <b class="req">*</b></span><select name="from">${warehouseOptions()}</select></label>
        <label class="field"><span>To <b class="req">*</b></span><select name="to">${warehouseOptions()}</select></label>
        <label class="field"><span>Date</span><input type="date" name="date" value="${isoDate()}" /></label>
        <label class="field"><span>Vehicle No.</span><input name="vehicleNo" /></label>
        <label class="field span-all"><span>Remarks</span><input name="remarks" /></label></div>
        <div class="section-title">Items</div>
        <table class="table"><thead><tr><th>Item</th><th class="num">Available at source</th><th class="num">Qty to send</th><th>Unit</th><th></th></tr></thead><tbody id="tl"></tbody></table>
        <button type="button" class="btn sm" id="addL" style="margin-top:8px"><i class="fa-solid fa-plus"></i> Add item</button></form>`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="saveT"><i class="fa-solid fa-truck-arrow-right"></i> Dispatch Transfer</button>`
    });
    const form = modal.el.querySelector("#tForm");
    const renderL = () => {
      const from = form.from.value;
      const stocked = items.filter((i) => i.active !== false && (!from || available(from, i.id) > 0));
      modal.el.querySelector("#tl").innerHTML = lines.map((l, i) => {
        const it = items.find((x) => x.id === l.itemId);
        return `<tr data-i="${i}"><td><select data-f="itemId"><option value="">${from ? "Select item in stock…" : "Select source first"}</option>${stocked.map((x) => `<option value="${esc(x.id)}" ${x.id === l.itemId ? "selected" : ""}>${esc(x.name)} (${esc(x.category)})</option>`).join("")}</select></td>
        <td class="num">${it && from ? qty(available(from, it.id)) : "—"}</td><td><input data-f="qty" type="number" step="any" min="0" class="num" value="${esc(l.qty)}" /></td><td>${esc(it?.unit || "—")}</td>
        <td>${lines.length > 1 ? '<button type="button" class="icon-btn" data-rm><i class="fa-solid fa-trash"></i></button>' : ""}</td></tr>`;
      }).join("");
    };
    const tl = modal.el.querySelector("#tl");
    tl.addEventListener("input", (e) => { const tr = e.target.closest("tr"); if (tr && e.target.dataset.f === "qty") lines[Number(tr.dataset.i)].qty = e.target.value; });
    tl.addEventListener("change", (e) => { const tr = e.target.closest("tr"); if (tr && e.target.dataset.f === "itemId") { lines[Number(tr.dataset.i)].itemId = e.target.value; renderL(); } });
    tl.addEventListener("click", (e) => { if (e.target.closest("[data-rm]")) { lines.splice(Number(e.target.closest("tr").dataset.i), 1); renderL(); } });
    modal.el.querySelector("#addL").addEventListener("click", () => { lines.push({ itemId: "", qty: "" }); renderL(); });
    form.from.addEventListener("change", renderL);
    renderL();

    modal.el.querySelector("#saveT").addEventListener("click", async (event) => {
      const v = formValues(form);
      let clean;
      try {
        if (!v.from || !v.to) throw new Error("Select both warehouses.");
        if (v.from === v.to) throw new Error("Source and destination must be different.");
        clean = lines.filter((l) => l.itemId && Number(l.qty) > 0).map((l) => { const it = items.find((x) => x.id === l.itemId); return { itemId: it.id, name: it.name, unit: it.unit, category: it.category, qtySent: round(Number(l.qty)) }; });
        if (!clean.length) throw new Error("Add at least one item with quantity.");
        if (new Set(clean.map((l) => l.itemId)).size !== clean.length) throw new Error("Each item can only appear once.");
      } catch (error) { toast(error.message, "error"); return; }
      const done = busy(event.currentTarget);
      try {
        const ref = doc(collection(db, "transfers"));
        const trNo = await runTransaction(db, async (tx) => {
          const movements = clean.map((l) => ({ warehouse: v.from, item: { id: l.itemId, name: l.name, unit: l.unit, category: l.category }, qty: -l.qtySent, note: `Transfer to ${warehouseByCode(v.to).name}` }));
          const stockMap = await readStock(tx, movements.map((m) => ({ warehouse: m.warehouse, itemId: m.item.id })));
          const number = await reserveNumber(tx, "ST", { date: v.date });
          commitNumber(tx, number);
          applyMovements(tx, stockMap, movements, { type: "TRANSFER OUT", id: ref.id, no: number.number });
          tx.set(ref, { trNo: number.number, date: v.date, from: v.from, to: v.to, vehicleNo: v.vehicleNo.toUpperCase(), remarks: v.remarks, lines: clean, status: "IN TRANSIT", createdAt: serverTimestamp(), createdBy: { uid: state.user.uid, name: state.profile.name || state.user.email } });
          logActivity(tx, { module: "Stock Transfer", action: "DISPATCH", refId: ref.id, refNo: number.number, summary: `${number.number}: ${warehouseByCode(v.from).name} → ${warehouseByCode(v.to).name}: ${clean.map((l) => `${qty(l.qtySent)} ${l.unit} ${l.name}`).join(", ")}` });
          return number.number;
        });
        toast(`${trNo} dispatched — now in transit.`, "ok");
        modal.close();
        tab = "IN TRANSIT";
        await load();
      } catch (error) { reportError(error); } finally { done(); }
    });
  }

  function openReceive(t) {
    const modal = openModal({
      title: `Receive ${t.trNo} at ${warehouseByCode(t.to).name}`,
      size: "wide",
      body: `<p class="muted">Enter what actually arrived. Any shortfall is recorded as transit loss (damaged / destroyed / leaked on the way). Material damaged after arrival should be written off from <a href="adjustments.html">Write-off / Adjust</a>.</p>
        <form id="rForm"><table class="table"><thead><tr><th>Item</th><th class="num">Sent</th><th class="num">Received</th><th class="num">Loss</th><th>Loss reason</th></tr></thead><tbody>
        ${t.lines.map((l, i) => `<tr data-i="${i}"><td class="strong">${esc(l.name)}</td><td class="num">${qty(l.qtySent)} ${esc(l.unit)}</td><td><input type="number" step="any" min="0" class="num" name="rec${i}" value="${esc(l.qtySent)}" /></td><td class="num" data-loss>0</td><td><input name="why${i}" placeholder="Required if loss" /></td></tr>`).join("")}
        </tbody></table>
        <label class="field" style="margin-top:12px"><span>Remarks</span><input name="remarks" /></label></form>`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="saveR"><i class="fa-solid fa-check"></i> Confirm receipt</button>`
    });
    const form = modal.el.querySelector("#rForm");
    form.addEventListener("input", () => t.lines.forEach((l, i) => {
      const loss = round(l.qtySent - (Number(form[`rec${i}`].value) || 0));
      const cell = form.querySelector(`tr[data-i="${i}"] [data-loss]`);
      cell.textContent = qty(loss); cell.style.color = loss > 0 ? "var(--danger)" : "";
    }));
    modal.el.querySelector("#saveR").addEventListener("click", async (event) => {
      let received;
      try {
        received = t.lines.map((l, i) => {
          const r = Number(form[`rec${i}`].value);
          if (!Number.isFinite(r) || r < 0) throw new Error(`${l.name}: enter received quantity.`);
          if (r > l.qtySent + 0.0005) throw new Error(`${l.name}: received cannot exceed sent quantity.`);
          const loss = round(l.qtySent - r);
          const why = form[`why${i}`].value.trim();
          if (loss > 0 && !why) throw new Error(`${l.name}: enter the reason for the ${qty(loss)} ${l.unit} loss.`);
          return { ...l, qtyReceived: round(r), lossQty: loss, lossReason: loss > 0 ? why : "" };
        });
      } catch (error) { toast(error.message, "error"); return; }
      const done = busy(event.currentTarget);
      try {
        await runTransaction(db, async (tx) => {
          const ref = doc(db, "transfers", t.id);
          const cur = (await tx.get(ref)).data();
          if (cur.status !== "IN TRANSIT") throw new Error(`Transfer is already ${cur.status}.`);
          const movements = received.filter((l) => l.qtyReceived > 0).map((l) => ({ warehouse: cur.to, item: { id: l.itemId, name: l.name, unit: l.unit, category: l.category }, qty: l.qtyReceived, note: `Transfer from ${warehouseByCode(cur.from).name}${l.lossQty > 0 ? ` (transit loss ${qty(l.lossQty)}: ${l.lossReason})` : ""}` }));
          const stockMap = await readStock(tx, movements.map((m) => ({ warehouse: m.warehouse, itemId: m.item.id })));
          applyMovements(tx, stockMap, movements, { type: "TRANSFER IN", id: t.id, no: cur.trNo });
          tx.update(ref, { lines: received, status: "RECEIVED", receiveRemarks: form.remarks.value.trim(), receivedAt: serverTimestamp(), receivedBy: { uid: state.user.uid, name: state.profile.name || state.user.email } });
          const losses = received.filter((l) => l.lossQty > 0);
          logActivity(tx, { module: "Stock Transfer", action: "RECEIVE", refId: t.id, refNo: cur.trNo, summary: `${cur.trNo} received at ${warehouseByCode(cur.to).name}: ${received.map((l) => `${qty(l.qtyReceived)}/${qty(l.qtySent)} ${l.unit} ${l.name}`).join(", ")}${losses.length ? ` · TRANSIT LOSS ${losses.map((l) => `${qty(l.lossQty)} ${l.unit} ${l.name} (${l.lossReason})`).join(", ")}` : ""}` });
        });
        toast(`${t.trNo} received.`, "ok");
        modal.close();
        tab = "RECEIVED";
        await load();
      } catch (error) { reportError(error); } finally { done(); }
    });
  }

  async function cancelTransfer(t) {
    const reason = await confirmDialog(`Cancel ${t.trNo}? The material will be added back to ${warehouseByCode(t.from).name}.`, { title: "Cancel transfer", danger: true, okText: "Cancel transfer", input: { label: "Reason", required: true } });
    if (!reason) return;
    try {
      await runTransaction(db, async (tx) => {
        const ref = doc(db, "transfers", t.id);
        const cur = (await tx.get(ref)).data();
        if (cur.status !== "IN TRANSIT") throw new Error(`Transfer is already ${cur.status}.`);
        const movements = cur.lines.map((l) => ({ warehouse: cur.from, item: { id: l.itemId, name: l.name, unit: l.unit, category: l.category }, qty: l.qtySent, note: `Cancelled transfer ${cur.trNo}` }));
        const stockMap = await readStock(tx, movements.map((m) => ({ warehouse: m.warehouse, itemId: m.item.id })));
        applyMovements(tx, stockMap, movements, { type: "TRANSFER CANCEL", id: t.id, no: cur.trNo });
        tx.update(ref, { status: "CANCELLED", cancelReason: reason, cancelledAt: serverTimestamp(), cancelledBy: { uid: state.user.uid, name: state.profile.name || state.user.email } });
        logActivity(tx, { module: "Stock Transfer", action: "CANCEL", refId: t.id, refNo: cur.trNo, summary: `Cancelled ${cur.trNo}; stock returned to ${warehouseByCode(cur.from).name}. Reason: ${reason}` });
      });
      toast(`${t.trNo} cancelled.`, "ok");
      await load();
    } catch (error) { reportError(error); }
  }

  function openView(t) {
    openModal({
      title: t.trNo,
      size: "wide",
      body: `${badge(t.status)}<div class="detail-grid" style="margin:14px 0"><div><span>From</span><b>${esc(warehouseByCode(t.from).name)}</b></div><div><span>To</span><b>${esc(warehouseByCode(t.to).name)}</b></div><div><span>Date</span><b>${fmtDate(t.date)}</b></div><div><span>Vehicle</span><b>${esc(t.vehicleNo || "—")}</b></div><div><span>Sent by</span><b>${esc(t.createdBy?.name)} · ${fmtDateTime(t.createdAt)}</b></div><div><span>Received by</span><b>${t.receivedBy ? `${esc(t.receivedBy.name)} · ${fmtDateTime(t.receivedAt)}` : "—"}</b></div></div>
        <table class="table"><thead><tr><th>Item</th><th class="num">Sent</th><th class="num">Received</th><th class="num">Loss</th><th>Reason</th></tr></thead><tbody>${t.lines.map((l) => `<tr><td>${esc(l.name)}</td><td class="num">${qty(l.qtySent)} ${esc(l.unit)}</td><td class="num">${l.qtyReceived !== undefined ? qty(l.qtyReceived) : "—"}</td><td class="num">${l.lossQty ? qty(l.lossQty) : "—"}</td><td>${esc(l.lossReason || "")}</td></tr>`).join("")}</tbody></table>
        ${t.remarks ? `<p class="muted">Remarks: ${esc(t.remarks)}</p>` : ""}${t.cancelReason ? `<div class="notice error">Cancelled: ${esc(t.cancelReason)}</div>` : ""}`,
      footer: '<button class="btn" data-close>Close</button>'
    });
  }

  await load();
  document.body.dataset.loaded = "1";
}
