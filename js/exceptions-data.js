// "Needs attention" rules shared by the Exceptions page and the Dashboard.
import { OPEN_PO_STATUSES, normalizeReceipt, isoDate, toDate, qty, round, fmtDate, isOnHold, HOLD_TEXT, acceptedOf, isServicePo } from "./core.js";

const n = (v) => Number(v) || 0;
const daysSince = (value) => { const d = toDate(value) || (typeof value === "string" ? new Date(`${value}T00:00:00`) : null); return d ? Math.floor((Date.now() - d.getTime()) / 86400000) : 0; };
const recent = (value, days) => daysSince(value) <= days;

/**
 * @returns {Array<{key,title,icon,tone,help,rows:Array<{ref,href,text,meta,days}>}>}
 */
export function computeExceptions({ pos = [], receipts = [], adjustments = [], company = {} }) {
  const today = isoDate();
  const overdueDays = Number(company.poOverdueDays) || 15;
  const openPos = pos.filter((p) => OPEN_PO_STATUSES.includes(p.status));
  const recs = receipts.map(normalizeReceipt).filter((r) => r.stage !== "CANCELLED");
  const pendingOf = (p) => p.lines.filter((l) => n(l.qty) - n(l.receivedQty) > 0.0005).map((l) => `${l.name} ${qty(round(n(l.qty) - n(l.receivedQty)))} ${l.unit}`).join(", ");

  const groups = [
    {
      key: "payment-hold", title: HOLD_TEXT, icon: "fa-hand", tone: "red",
      help: "Full rejections (vehicle) and partly rejected quantities. Accounts must not pay the rejected quantity until a manager resolves the hold (Tally is not blocked automatically).",
      rows: recs.filter(isOnHold).map((r) => {
        const rej = r.rejection || r.partialRejection || {};
        const what = r.stage === "REJECTED" ? `full rejection: ${r.lines.map((l) => `${l.name} ${qty(l.invoiceQty)} ${l.unit}`).join(", ")}` : `partial rejection: ${r.lines.filter((l) => n(l.rejectedQty) > 0).map((l) => `${l.name} ${qty(l.rejectedQty)} of ${qty(l.kantaQty)} ${l.unit} rejected`).join(", ")}`;
        return { ref: r.geNo, href: "inward.html", text: `${r.vendor?.name} — invoice ${r.invoiceNo} · ${what} · ${rej.reason || ""}`, meta: `${r.poNo || "Without PO"} · by ${rej.by?.name || ""}`, days: daysSince(rej.at || r.createdAt) };
      })
    },
    {
      key: "po-overdue", title: "PO pending too long", icon: "fa-hourglass-half", tone: "red",
      help: `Open POs past their expected delivery date, or older than ${overdueDays} days.`,
      rows: openPos.filter((p) => (p.expectedDate && p.expectedDate < today) || daysSince(p.date) > overdueDays)
        .map((p) => ({ ref: p.poNo, href: `purchase-orders.html?open=${p.id}`, text: `${p.vendor?.name} — pending ${pendingOf(p) || "—"}`, meta: p.expectedDate && p.expectedDate < today ? `Expected ${fmtDate(p.expectedDate)}` : `Raised ${fmtDate(p.date)}`, days: daysSince(p.expectedDate && p.expectedDate < today ? p.expectedDate : p.date) }))
    },
    {
      key: "grn-waiting-kanta", title: "GRN waiting for Kanta", icon: "fa-scale-balanced", tone: "amber",
      help: "Material received (GRN done) but not yet confirmed on the Kanta — stock is not added yet.",
      rows: recs.filter((r) => r.stage === "KANTA PENDING").map((r) => ({ ref: r.grn?.grnNo || r.geNo, href: "inward.html#kanta", text: `${r.vendor?.name} — ${r.lines.map((l) => `${l.name} ${qty(l.grnQty)} ${l.unit}`).join(", ")}`, meta: `${r.poNo || "Without PO"} · GRN ${fmtDate(r.grn?.at)}`, days: daysSince(r.grn?.at) }))
    },
    {
      key: "invoice-waiting-grn", title: "Invoice waiting for GRN", icon: "fa-file-invoice", tone: "amber",
      help: "Invoice / gate entry made but GRN not recorded yet.",
      rows: recs.filter((r) => r.stage === "GRN PENDING").map((r) => ({ ref: r.geNo, href: "inward.html", text: `${r.vendor?.name} — invoice ${r.invoiceNo}: ${r.lines.map((l) => `${l.name} ${qty(l.invoiceQty)} ${l.unit}`).join(", ")}`, meta: r.poNo || "Without PO", days: daysSince(r.createdAt) }))
    },
    {
      key: "kanta-variance", title: "Kanta shortage / excess", icon: "fa-scale-unbalanced", tone: "red",
      help: "Kanta quantity different from the GRN quantity (last 60 days).",
      rows: recs.filter((r) => r.stage === "COMPLETED" && recent(r.kanta?.at, 60)).flatMap((r) => r.lines.filter((l) => Math.abs(n(l.kantaQty) - n(l.grnQty)) > 0.0005)
        .map((l) => { const v = round(n(l.kantaQty) - n(l.grnQty)); return { ref: r.grn?.grnNo || r.geNo, href: r.poId ? `purchase-orders.html?open=${r.poId}` : "inward.html", text: `${l.name}: GRN ${qty(l.grnQty)} → Kanta ${qty(l.kantaQty)} ${l.unit} (${v > 0 ? "EXCESS +" : "SHORT "}${qty(v)})`, meta: `${r.vendor?.name} · ${r.poNo || "no PO"}`, days: daysSince(r.kanta?.at) }; }))
    },
    {
      key: "invoice-vs-kanta", title: "Invoice qty not matching payable (accepted) qty", icon: "fa-file-circle-exclamation", tone: "red",
      help: "Invoice quantity differs from the accepted Kanta quantity that is payable — check the vendor bill before payment (last 60 days).",
      rows: recs.filter((r) => r.stage === "COMPLETED" && recent(r.kanta?.at, 60)).flatMap((r) => r.lines.filter((l) => Math.abs(acceptedOf(l) - n(l.invoiceQty)) > 0.0005)
        .map((l) => ({ ref: r.geNo, href: l.poId ? `purchase-orders.html?open=${l.poId}` : "inward.html", text: `${l.name}: invoice ${qty(n(l.invoiceQty))} vs payable ${qty(acceptedOf(l))} ${l.unit} (difference ${qty(round(acceptedOf(l) - n(l.invoiceQty)))})${n(l.rejectedQty) ? ` · ${qty(l.rejectedQty)} rejected` : ""}`, meta: `${r.vendor?.name} · invoice ${r.invoiceNo}`, days: daysSince(r.kanta?.at) })))
    },
    {
      key: "po-partial", title: "PO partially received", icon: "fa-circle-half-stroke", tone: "blue",
      help: "POs where some material has arrived but not all.",
      rows: openPos.filter((p) => p.status !== "OPEN" && !isServicePo(p)).map((p) => ({ ref: p.poNo, href: `purchase-orders.html?open=${p.id}`, text: `${p.vendor?.name} — pending ${pendingOf(p) || "—"}`, meta: p.status, days: daysSince(p.date) }))
    },
    {
      key: "stock-adjusted", title: "Stock manually adjusted", icon: "fa-pen-to-square", tone: "gold",
      help: "Write-offs, count corrections and opening / existing stock entries (last 30 days).",
      rows: adjustments.filter((a) => recent(a.createdAt, 30)).map((a) => ({ ref: a.adjNo, href: "adjustments.html", text: `${a.type}: ${a.qty > 0 ? "+" : ""}${qty(a.qty)} ${a.item?.unit} ${a.item?.name} — ${a.reason}`, meta: `${a.status} · ${a.createdBy?.name || ""}`, days: daysSince(a.createdAt) }))
    }
  ];
  groups.forEach((g) => g.rows.sort((a, b) => b.days - a.days));
  return groups;
}
