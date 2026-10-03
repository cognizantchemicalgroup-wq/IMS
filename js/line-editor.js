// Editable item lines with live GST totals, shared by PO, Quotation and Sales Order.
import { esc, money, computeTotals, round } from "./core.js";

const newLineId = () => Math.random().toString(36).slice(2, 10);

/**
 * @param {HTMLElement} host
 * @param {{items:Array, lines?:Array, isIntraState:()=>boolean, itemFilter?:(item)=>boolean}} options
 */
export function createLineEditor(host, { items, lines = [], isIntraState, itemFilter = () => true }) {
  const usable = items.filter((i) => i.active !== false && itemFilter(i)).sort((a, b) => a.name.localeCompare(b.name));
  let rows = lines.length ? lines.map((l) => ({ ...l })) : [blank()];

  function blank() { return { lineId: newLineId(), itemId: "", name: "", description: "", hsn: "", unit: "", qty: "", rate: "", gstRate: 18 }; }

  host.innerHTML = `
    <div class="table-wrap"><table class="table line-table"><thead><tr>
      <th style="width:34px">#</th><th style="min-width:220px">Item</th><th style="min-width:180px">Description</th><th style="width:100px">HSN/SAC</th>
      <th style="width:110px" class="num">Qty</th><th style="width:70px">Unit</th><th style="width:120px" class="num">Rate (₹)</th><th style="width:80px" class="num">GST %</th><th style="width:130px" class="num">Amount (₹)</th><th style="width:40px"></th>
    </tr></thead><tbody></tbody></table></div>
    <button class="btn sm" type="button" data-add style="margin-top:10px"><i class="fa-solid fa-plus"></i> Add line</button>
    <div class="totals" data-totals style="margin-top:14px"></div>`;
  const tbody = host.querySelector("tbody");
  const totalsEl = host.querySelector("[data-totals]");

  function render() {
    tbody.innerHTML = rows.map((r, i) => `<tr data-i="${i}">
      <td class="muted">${i + 1}</td>
      <td><select data-f="itemId"><option value="">Select item…</option>${usable.map((it) => `<option value="${esc(it.id)}" ${it.id === r.itemId ? "selected" : ""}>${esc(it.name)}${it.code ? ` (${esc(it.code)})` : ""}</option>`).join("")}</select></td>
      <td><input data-f="description" value="${esc(r.description)}" placeholder="Optional" /></td>
      <td><input data-f="hsn" value="${esc(r.hsn)}" /></td>
      <td><input data-f="qty" type="number" min="0" step="any" class="num" value="${esc(r.qty)}" /></td>
      <td class="muted">${esc(r.unit || "—")}</td>
      <td><input data-f="rate" type="number" min="0" step="any" class="num" value="${esc(r.rate)}" /></td>
      <td><select data-f="gstRate">${[0, 5, 12, 18, 28].map((g) => `<option ${Number(r.gstRate) === g ? "selected" : ""}>${g}</option>`).join("")}</select></td>
      <td class="num strong" data-amount>${money((Number(r.qty) || 0) * (Number(r.rate) || 0))}</td>
      <td>${rows.length > 1 ? '<button class="icon-btn" type="button" data-remove title="Remove line"><i class="fa-solid fa-trash"></i></button>' : ""}</td>
    </tr>`).join("");
    renderTotals();
  }

  function renderTotals() {
    const t = totals();
    totalsEl.innerHTML = `<div class="row"><span class="muted">Sub Total</span><span>${money(t.subTotal)}</span></div>
      ${t.taxes.map((x) => `<div class="row"><span class="muted">${esc(x.label)}</span><span>${money(x.amount)}</span></div>`).join("")}
      ${t.roundOff ? `<div class="row"><span class="muted">Round Off</span><span>${money(t.roundOff)}</span></div>` : ""}
      <div class="row grand"><span>Total</span><span>₹${money(t.total)}</span></div>`;
  }

  tbody.addEventListener("change", (event) => {
    const tr = event.target.closest("tr");
    const f = event.target.dataset.f;
    if (!tr || !f) return;
    const r = rows[Number(tr.dataset.i)];
    r[f] = event.target.value;
    if (f === "itemId") {
      const it = usable.find((x) => x.id === r.itemId);
      Object.assign(r, it ? { name: it.name, hsn: it.hsn || "", unit: it.unit || "", gstRate: it.gstRate ?? 18, description: r.description || it.description || "" } : { name: "", hsn: "", unit: "" });
      render();
    } else {
      tr.querySelector("[data-amount]").textContent = money((Number(r.qty) || 0) * (Number(r.rate) || 0));
      renderTotals();
    }
  });
  tbody.addEventListener("input", (event) => {
    const tr = event.target.closest("tr");
    const f = event.target.dataset.f;
    if (!tr || !["qty", "rate"].includes(f)) return;
    const r = rows[Number(tr.dataset.i)];
    r[f] = event.target.value;
    tr.querySelector("[data-amount]").textContent = money((Number(r.qty) || 0) * (Number(r.rate) || 0));
    renderTotals();
  });
  tbody.addEventListener("click", (event) => {
    if (!event.target.closest("[data-remove]")) return;
    rows.splice(Number(event.target.closest("tr").dataset.i), 1);
    render();
  });
  host.querySelector("[data-add]").addEventListener("click", () => { rows.push(blank()); render(); });

  function totals() { return computeTotals(rows.filter((r) => r.itemId), isIntraState()); }

  /** Validated lines ready to save, or throws. */
  function value() {
    const filled = rows.filter((r) => r.itemId || r.qty || r.rate);
    if (!filled.length) throw new Error("Add at least one item line.");
    const ids = new Set();
    return filled.map((r, i) => {
      const it = usable.find((x) => x.id === r.itemId) || items.find((x) => x.id === r.itemId);
      if (!it) throw new Error(`Line ${i + 1}: select an item.`);
      const q = Number(r.qty);
      const rate = Number(r.rate);
      if (!Number.isFinite(q) || q <= 0) throw new Error(`Line ${i + 1}: quantity must be greater than 0.`);
      if (!Number.isFinite(rate) || rate < 0) throw new Error(`Line ${i + 1}: enter a valid rate.`);
      if (ids.has(r.lineId)) r.lineId = newLineId();
      ids.add(r.lineId);
      return {
        lineId: r.lineId || newLineId(), itemId: it.id, name: it.name, category: it.category || "", description: String(r.description || "").trim(),
        hsn: String(r.hsn || "").trim(), unit: it.unit || r.unit, qty: round(q), rate: round(rate, 4), gstRate: Number(r.gstRate) || 0
      };
    });
  }

  render();
  /** Unvalidated copy of the lines entered so far (used to carry a draft to another document type). */
  const draft = () => rows.filter((r) => r.itemId).map((r) => ({ ...r }));
  return { value, totals, refresh: renderTotals, draft };
}
