// Warehouses / units. The code is the permanent key used by stock, transfers, POs and history,
// so a warehouse can be renamed freely without touching any linked record.
import {
  db, reportError, state, initPage, pageHeader, esc, toast, openModal, badge, busy, formValues, can,
  listCollection, logActivity, loadSettings, qty
} from "./core.js?v=20261010b";
import { doc, runTransaction, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const page = await initPage("warehouses");
if (page) start();

const lines = (text) => String(text || "").split("\n").map((s) => s.trim()).filter(Boolean);

async function start() {
  const canEdit = can("warehouses");
  let stock = [];

  page.innerHTML = `${pageHeader("Inventory", "Warehouses", "Units and godowns. Renaming keeps all stock, transfers and history linked.",
    canEdit ? '<button class="btn primary" id="addWh"><i class="fa-solid fa-plus"></i> New warehouse</button>' : "")}
    <div class="card"><div class="table-wrap"><table class="table"><thead><tr><th>Warehouse</th><th>Code</th><th>Contact</th><th class="num">Items in stock</th><th>Status</th><th></th></tr></thead><tbody id="rows"></tbody></table></div></div>`;

  const render = () => {
    page.querySelector("#rows").innerHTML = state.warehouses.map((w) => {
      const items = stock.filter((s) => s.warehouse === w.code && s.qty > 0).length;
      return `<tr><td class="strong">${esc(w.name)}${w.addressLines?.length ? `<div class="small muted">${esc(w.addressLines.slice(-1)[0])}</div>` : ""}</td><td class="mono">${esc(w.code)}</td>
        <td>${esc(w.contactPerson || "—")}${w.phone ? `<div class="small muted">${esc(w.phone)}</div>` : ""}</td><td class="num">${items}</td><td>${badge(w.active === false ? "INACTIVE" : "ACTIVE")}</td>
        <td><div class="actions"><button class="btn sm" data-view="${esc(w.code)}">View details</button>${canEdit ? `<button class="btn sm" data-edit="${esc(w.code)}">Edit</button>` : ""}</div></td></tr>`;
    }).join("") || '<tr><td class="empty" colspan="6">No warehouses yet.</td></tr>';
  };

  function view(w) {
    const items = stock.filter((s) => s.warehouse === w.code && s.qty > 0);
    const modal = openModal({
      title: w.name,
      body: `<div class="detail-grid" style="grid-template-columns:1fr 1fr">
          <div style="grid-column:1/-1"><span>Full address</span><b style="white-space:pre-line">${esc((w.addressLines || []).join("\n") || "—")}</b></div>
          <div><span>Contact person</span><b>${esc(w.contactPerson || "—")}</b></div>
          <div><span>Phone</span><b>${w.phone ? `<a href="tel:${esc(w.phone.replace(/[^0-9+]/g, ""))}">${esc(w.phone)}</a>` : "—"}</b></div>
          ${w.note ? `<div style="grid-column:1/-1"><span>Note</span><b>${esc(w.note)}</b></div>` : ""}
          <div><span>Code</span><b class="mono">${esc(w.code)}</b></div><div><span>Status</span><b>${w.active === false ? "Inactive" : "Active"}</b></div>
        </div>
        <p class="small muted" style="margin:12px 0 0">${items.length} item${items.length === 1 ? "" : "s"} in stock${items.length ? `: ${items.slice(0, 6).map((s) => `${esc(s.itemName)} ${qty(s.qty)} ${esc(s.unit)}`).join(", ")}${items.length > 6 ? "…" : ""}` : ""}. <a href="inventory.html">Open stock →</a></p>`,
      footer: `<button class="btn" data-close>Close</button>${canEdit ? '<button class="btn primary" id="editFromView"><i class="fa-solid fa-pen"></i> Edit details</button>' : ""}`
    });
    modal.el.querySelector("#editFromView")?.addEventListener("click", () => { modal.close(); edit(w); });
  }

  function edit(w = null) {
    const modal = openModal({
      title: w ? `Edit ${w.name}` : "New warehouse",
      body: `<form id="whForm" class="form-grid" style="grid-template-columns:1fr 1fr" novalidate>
        <label class="field"><span>Name <b class="req">*</b></span><input name="name" maxlength="60" value="${esc(w?.name || "")}" /></label>
        <label class="field"><span>Code ${w ? "(permanent)" : '<b class="req">*</b>'}</span><input name="code" maxlength="20" value="${esc(w?.code || "")}" ${w ? "readonly" : 'placeholder="e.g. PG-106"'} /></label>
        <label class="field span-2"><span>Full address</span><textarea name="addressLines" rows="3">${esc((w?.addressLines || []).join("\n"))}</textarea></label>
        <label class="field"><span>Contact person</span><input name="contactPerson" maxlength="60" value="${esc(w?.contactPerson || "")}" /></label>
        <label class="field"><span>Phone</span><input name="phone" maxlength="30" value="${esc(w?.phone || "")}" /></label>
        <label class="field span-2"><span>Note (optional)</span><input name="note" maxlength="160" value="${esc(w?.note || "")}" placeholder="e.g. Gate closes at 8 pm" /></label>
        <label class="field"><span>Status</span><select name="active"><option value="true">Active</option><option value="false" ${w?.active === false ? "selected" : ""}>Inactive</option></select></label>
        <details class="span-2"><summary class="small muted" style="cursor:pointer">More (printed on PO)</summary><div class="form-grid" style="grid-template-columns:1fr 1fr;margin-top:10px">
          <label class="field"><span>Destination</span><input name="destination" value="${esc(w?.destination || "")}" /></label>
          <label class="field"><span>PO number code ({SITE})</span><input name="docCode" value="${esc(w?.docCode || "")}" /></label>
          <label class="field"><span>Sort order</span><input type="number" name="sort" value="${esc(w?.sort ?? state.warehouses.length + 1)}" /></label>
        </div></details></form>`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="saveWh">${w ? "Save" : "Create warehouse"}</button>`
    });
    modal.el.querySelector("#saveWh").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const v = formValues(modal.el.querySelector("#whForm"));
      const code = (w ? w.code : v.code).toUpperCase().replace(/[^A-Z0-9-]/g, "");
      if (!v.name) { toast("Enter the warehouse name.", "error"); return; }
      if (!code) { toast("Enter a code (letters, numbers and - only).", "error"); return; }
      const clash = state.warehouses.find((x) => x.code !== code && x.name.trim().toLowerCase() === v.name.trim().toLowerCase());
      if (clash) { toast(`Another warehouse is already called ${clash.name}.`, "error"); return; }
      const data = {
        name: v.name, addressLines: lines(v.addressLines), contactPerson: v.contactPerson, phone: v.phone, note: v.note,
        active: v.active === "true", destination: v.destination, docCode: (v.docCode || code).toUpperCase(), sort: Number(v.sort) || 99, updatedAt: serverTimestamp()
      };
      const done = busy(button);
      try {
        await runTransaction(db, async (tx) => {
          const ref = doc(db, "warehouses", code);
          const snap = await tx.get(ref);
          if (!w && snap.exists()) throw new Error(`Code ${code} is already used by ${snap.data().name}.`);
          const old = snap.exists() ? snap.data() : null;
          tx.set(ref, { ...data, ...(snap.exists() ? {} : { createdAt: serverTimestamp() }) }, { merge: true });
          const renamed = old && old.name !== data.name;
          logActivity(tx, {
            module: "Warehouses", action: !old ? "CREATE" : renamed ? "RENAME" : "UPDATE", refId: code, refNo: code,
            summary: !old ? `Created warehouse ${data.name} (${code})` : renamed ? `Renamed warehouse ${old.name} → ${data.name} (${code}); stock and history stay linked` : `Updated details of ${data.name} (${code})`
          });
        });
        await loadSettings();
        render();
        modal.close();
        toast("Warehouse saved.", "ok");
      } catch (error) { reportError(error); } finally { done(); }
    });
  }

  page.addEventListener("click", (e) => {
    const v = e.target.closest("[data-view]"); if (v) { view(state.warehouses.find((w) => w.code === v.dataset.view)); return; }
    const ed = e.target.closest("[data-edit]"); if (ed) edit(state.warehouses.find((w) => w.code === ed.dataset.edit));
  });
  page.querySelector("#addWh")?.addEventListener("click", () => edit());
  stock = await listCollection("inventory");
  render();
  document.body.dataset.loaded = "1";
}
