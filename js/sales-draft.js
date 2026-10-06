// Switching a new Sales Order ⇄ Proforma Invoice keeps what was already entered.
import { esc } from "./core.js";

const DRAFT_KEY = "ccpl-sales-draft";

export const DOC_TYPES = { SO: "Sales Order (SO)", PI: "Proforma Invoice (PI)" };

export function docTypeField(current) {
  return `<label class="field"><span>Document Type</span><select name="docType">${Object.entries(DOC_TYPES).map(([k, l]) => `<option value="${k}" ${k === current ? "selected" : ""}>${l}</option>`).join("")}</select><small class="help">Switching keeps the customer, items and references.</small></label>`;
}

/** Party option label: every party (customer, supplier or both) can be used for sales. */
export const partyOption = (p, selectedId) => `<option value="${esc(p.id)}" ${p.id === selectedId ? "selected" : ""}>${esc(p.name)}${p.partyType && p.partyType !== "Customer" ? ` · ${esc(p.partyType)}` : ""}</option>`;

export function openOtherType(target, draft) {
  try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ ...draft, target })); } catch { /* storage unavailable */ }
  window.location.href = target === "PI" ? "/proforma" : "/sales-orders";
}

export function takeDraft(target) {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw);
    if (draft.target !== target) return null;
    sessionStorage.removeItem(DRAFT_KEY);
    return draft;
  } catch { return null; }
}
