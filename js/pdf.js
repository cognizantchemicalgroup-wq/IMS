// Premium, vector (selectable-text) PDF documents rendered with pdfmake:
// Purchase Order, Quotation, Sales Order and Delivery Challan.
import { state, loadScript, money, qty, fmtDate, amountInWords, openModal, downloadBlob, esc, toast } from "./core.js";

const C = { brand: "#2a1f9d", ink: "#15123f", gold: "#b08d3c", soft: "#eeecfb", line: "#cfcde0", zebra: "#f7f7fb", muted: "#6b6a80" };

async function loadPdfMake() {
  await loadScript("https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.10/pdfmake.min.js");
  await loadScript("https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.10/vfs_fonts.js");
  return window.pdfMake;
}

let logoData = null;
async function logoDataUrl() {
  if (logoData) return logoData;
  const blob = await (await fetch("logo.png")).blob();
  logoData = await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(blob); });
  return logoData;
}

const hairline = { hLineWidth: () => 0.6, vLineWidth: () => 0.6, hLineColor: () => C.line, vLineColor: () => C.line };

function partyBlock(party, fallback = "—") {
  if (!party) return [{ text: fallback, color: C.muted }];
  const lines = [];
  if (party.name) lines.push({ text: party.name, bold: true, fontSize: 10.5, color: C.ink, margin: [0, 0, 0, 2] });
  (party.addressLines || [party.address1, party.address2, [party.city, party.pincode].filter(Boolean).join(" "), [party.state, party.country].filter(Boolean).join(" ")])
    .filter(Boolean).forEach((l) => lines.push({ text: l }));
  if (party.gstin) lines.push({ text: `GSTIN ${party.gstin}` });
  if (party.pan) lines.push({ text: `PAN No ${party.pan}` });
  if (party.phone) lines.push({ text: party.phone });
  if (party.email) lines.push({ text: party.email });
  if (party.contactPerson) lines.push({ text: `Attn: ${party.contactPerson}`, color: C.muted });
  return lines;
}

function metaTable(rows) {
  // rows: [[label, value], ...] split into two columns like the CCPL PO layout
  const half = Math.ceil(rows.length / 2);
  const col = (list) => ({
    table: { widths: [92, "*"], body: list.map(([l, v]) => [{ text: l, color: C.muted }, { text: `: ${v || "—"}`, bold: true, color: C.ink }]) },
    layout: "noBorders"
  });
  return {
    table: { widths: ["*", "*"], body: [[{ ...col(rows.slice(0, half)), margin: [4, 4, 4, 4] }, { ...col(rows.slice(half)), margin: [4, 4, 4, 4] }]] },
    layout: hairline
  };
}

function totalsTable(totals, balanceDue = null) {
  const body = [[{ text: "Sub Total", color: C.muted }, { text: money(totals.subTotal), alignment: "right" }]];
  totals.taxes.forEach((t) => body.push([{ text: t.label, color: C.muted }, { text: money(t.amount), alignment: "right" }]));
  if (totals.roundOff) body.push([{ text: "Round Off", color: C.muted }, { text: money(totals.roundOff), alignment: "right" }]);
  body.push([
    { text: "Total", bold: true, color: "#ffffff", fillColor: C.brand, fontSize: 11, margin: [4, 3, 0, 3] },
    { text: `Rs.${money(totals.total)}`, bold: true, color: "#ffffff", fillColor: C.brand, fontSize: 11, alignment: "right", margin: [0, 3, 4, 3] }
  ]);
  if (balanceDue !== null) body.push([{ text: "Balance Due", bold: true, color: C.ink, margin: [4, 3, 0, 3] }, { text: `Rs.${money(balanceDue)}`, bold: true, color: C.ink, alignment: "right", margin: [0, 3, 4, 3] }]);
  return { table: { widths: ["*", 110], body }, layout: { hLineWidth: () => 0, vLineWidth: () => 0, paddingTop: () => 3, paddingBottom: () => 3 } };
}

/**
 * Build a pdfmake doc definition.
 * spec: { title, number, meta:[[l,v]], leftTitle, left, rightTitle, right, lines, totals|null, showRates, notes, terms, signFor, footerNote, extraColumns }
 */
async function buildDoc(spec) {
  const company = state.company;
  const logo = await logoDataUrl();
  const showRates = spec.showRates !== false;
  const header = [
    { text: "S.no", alignment: "center" }, "Item & Description", "HSN/SAC", { text: "Qty", alignment: "right" },
    ...(showRates ? [{ text: "Rate", alignment: "right" }, { text: "GST", alignment: "right" }, { text: "Amount", alignment: "right" }] : []),
    ...(spec.extraColumns ? spec.extraColumns.map((c) => ({ text: c.label, alignment: "right" })) : [])
  ].map((h) => (typeof h === "string" ? { text: h } : h)).map((h) => ({ ...h, bold: true, color: "#ffffff", fillColor: C.ink, fontSize: 8.5, margin: [0, 3, 0, 3] }));
  const widths = [26, "*", 58, 58, ...(showRates ? [62, 32, 72] : []), ...(spec.extraColumns ? spec.extraColumns.map(() => 58) : [])];
  const body = [header, ...spec.lines.map((line, i) => {
    const fill = i % 2 ? C.zebra : null;
    return [
      { text: String(i + 1), alignment: "center" },
      { stack: [{ text: line.name, bold: true, color: C.ink }, ...(line.description ? [{ text: line.description, fontSize: 8, color: C.muted, margin: [0, 1, 0, 0] }] : [])] },
      { text: line.hsn || "" },
      { stack: [{ text: qty(line.qty), alignment: "right" }, { text: line.unit || "", fontSize: 7.5, color: C.muted, alignment: "right" }] },
      ...(showRates ? [
        { text: money(line.rate), alignment: "right" },
        { text: `${Number(line.gstRate) || 0}%`, alignment: "right", color: C.muted },
        { text: money(line.amount), alignment: "right", bold: true }
      ] : []),
      ...(spec.extraColumns ? spec.extraColumns.map((c) => ({ text: c.value(line), alignment: "right" })) : [])
    ].map((cell) => ({ ...cell, fillColor: fill, margin: [0, 3, 0, 3] }));
  })];

  const leftBottom = [];
  if (spec.itemsInTotal) leftBottom.push({ text: `Items in Total ${qty(spec.itemsInTotal, 3)}`, color: C.ink, margin: [0, 0, 0, 6] });
  if (spec.totals) leftBottom.push({ text: "Total In Words", color: C.muted, fontSize: 8 }, { text: amountInWords(spec.totals.total), bold: true, italics: true, color: C.ink, margin: [0, 1, 0, 8] });
  if (spec.notes) leftBottom.push({ text: "Notes", bold: true, color: C.ink, margin: [0, 0, 0, 2] }, { text: spec.notes, margin: [0, 0, 0, 8] });
  if (spec.terms) {
    leftBottom.push({ text: spec.termsTitle || "Terms & Conditions", bold: true, color: C.ink, margin: [0, 0, 0, 2] });
    leftBottom.push({ ol: spec.terms.split("\n").map((t) => t.trim()).filter(Boolean), fontSize: 7.8, color: "#3b3a52" });
  }
  if (spec.bank && company.bankAccount) {
    leftBottom.push({ text: "Bank Details", bold: true, color: C.ink, margin: [0, 8, 0, 2] }, {
      table: { widths: [92, "*"], body: [
        ["A/c Holder's Name", company.bankHolder || company.name], ["Bank Name", company.bankName || ""], ["A/c No.", company.bankAccount],
        ["Branch & IFSC", [company.bankBranch, company.bankIfsc].filter(Boolean).join(" & ")]
      ].map(([l, v]) => [{ text: l, color: C.muted, fontSize: 8 }, { text: `: ${v}`, bold: true, fontSize: 8, color: C.ink }]) },
      layout: "noBorders"
    });
  }

  const rightBottom = [];
  if (spec.totals) rightBottom.push(totalsTable(spec.totals, spec.balanceDue ?? null));
  rightBottom.push({
    table: { widths: ["*"], body: [[{
      stack: [
        { text: `For ${company.name}`, bold: true, color: C.ink, alignment: "center" },
        { text: "System Generated Document — No Signature Required.", alignment: "center", color: C.brand, bold: true, fontSize: 8.5, margin: [0, 4, 0, 0] }
      ],
      fillColor: C.soft, margin: [6, 8, 6, 8]
    }]] },
    layout: "noBorders",
    margin: [0, 14, 0, 0]
  });

  return {
    pageSize: "A4",
    pageMargins: [34, 34, 34, 46],
    info: { title: `${spec.title} ${spec.number}`, author: company.name, subject: spec.title },
    defaultStyle: { fontSize: 8.8, color: "#23223a", lineHeight: 1.15 },
    footer: (current, count) => ({
      margin: [34, 10, 34, 0],
      columns: [
        { text: `GSTIN ${company.gstin}`, fontSize: 7, color: C.muted, width: 150 },
        { text: "System Generated Document — No Signature Required.", fontSize: 7, color: C.muted, alignment: "center", width: "*" },
        { text: `${spec.number} · Page ${current} of ${count}`, fontSize: 7, color: C.muted, alignment: "right", width: 150 }
      ]
    }),
    content: [
      {
        columns: [
          { image: logo, width: 92, margin: [0, 2, 12, 0] },
          { stack: [
            { text: company.name, fontSize: 14, bold: true, color: C.ink },
            ...company.addressLines.map((l) => ({ text: l })),
            { text: `GSTIN ${company.gstin}   ·   PAN No ${company.pan}` },
            { text: [company.email, company.phone].filter(Boolean).join("   ·   ") }
          ], width: "*" },
          { stack: [
            { text: spec.title.toUpperCase(), fontSize: spec.title.length > 14 ? 16 : 19, color: C.brand, bold: true, alignment: "right", characterSpacing: 1.1 },
            { text: spec.number, alignment: "right", color: C.ink, bold: true, fontSize: 10, margin: [0, 4, 0, 0] },
            ...(spec.copyLabel ? [{ text: spec.copyLabel, alignment: "right", color: C.muted, fontSize: 7.5, characterSpacing: 1, margin: [0, 3, 0, 0] }] : []),
            ...(spec.status ? [{ text: spec.status, alignment: "right", color: C.gold, bold: true, fontSize: 8.5, margin: [0, 2, 0, 0] }] : [])
          ], width: 215 }
        ]
      },
      { canvas: [{ type: "rect", x: 0, y: 0, w: 527, h: 2.2, color: C.brand }, { type: "rect", x: 0, y: 2.2, w: 527, h: 0.8, color: C.gold }], margin: [0, 10, 0, 8] },
      metaTable(spec.meta),
      {
        table: {
          widths: ["*", "*"],
          body: [
            [{ text: spec.leftTitle, bold: true, color: C.ink, fillColor: C.soft }, { text: spec.rightTitle, bold: true, color: C.ink, fillColor: C.soft }],
            [{ stack: partyBlock(spec.left), margin: [2, 4, 2, 6] }, { stack: partyBlock(spec.right), margin: [2, 4, 2, 6] }]
          ]
        },
        layout: hairline,
        margin: [0, 8, 0, 8]
      },
      { table: { headerRows: 1, widths, body, dontBreakRows: true }, layout: { hLineWidth: (i, node) => (i === 0 || i === 1 || i === node.table.body.length ? 0.8 : 0.3), vLineWidth: () => 0, hLineColor: () => C.line, paddingLeft: () => 5, paddingRight: () => 5 } },
      { columns: [{ stack: leftBottom, width: "*", margin: [0, 12, 16, 0] }, { stack: rightBottom, width: 240, margin: [0, 8, 0, 0] }], unbreakable: false },
      ...(spec.hsnSummary ? [hsnSummaryTable(spec.totals, spec.intraState)] : [])
    ]
  };
}

/** HSN/SAC-wise tax summary (as on GST invoices). */
function hsnSummaryTable(totals, intraState) {
  const groups = new Map();
  totals.lines.forEach((l) => {
    const key = `${l.hsn || "—"}|${Number(l.gstRate) || 0}`;
    const g = groups.get(key) || { hsn: l.hsn || "—", rate: Number(l.gstRate) || 0, taxable: 0 };
    g.taxable += Number(l.amount) || 0;
    groups.set(key, g);
  });
  const rows = [...groups.values()].map((g) => ({ ...g, tax: Math.round(g.taxable * g.rate) / 100 }));
  const th = (text, extra = {}) => ({ text, bold: true, color: C.ink, fillColor: C.soft, fontSize: 8, ...extra });
  const head = intraState
    ? [[th("HSN/SAC", { rowSpan: 2 }), th("Taxable Amount", { rowSpan: 2, alignment: "right" }), th("CGST", { colSpan: 2, alignment: "center" }), {}, th("SGST", { colSpan: 2, alignment: "center" }), {}, th("Total Tax Amount", { rowSpan: 2, alignment: "right" })],
      [{}, {}, th("Rate", { alignment: "right" }), th("Amount", { alignment: "right" }), th("Rate", { alignment: "right" }), th("Amount", { alignment: "right" }), {}]]
    : [[th("HSN/SAC", { rowSpan: 2 }), th("Taxable Amount", { rowSpan: 2, alignment: "right" }), th("IGST", { colSpan: 2, alignment: "center" }), {}, th("Total Tax Amount", { rowSpan: 2, alignment: "right" })],
      [{}, {}, th("Rate", { alignment: "right" }), th("Amount", { alignment: "right" }), {}]];
  const r = (t, bold = false) => ({ text: t, alignment: "right", fontSize: 8, bold });
  const body = rows.map((g) => (intraState
    ? [{ text: g.hsn, fontSize: 8 }, r(money(g.taxable)), r(`${g.rate / 2}%`), r(money(g.tax / 2)), r(`${g.rate / 2}%`), r(money(g.tax / 2)), r(money(g.tax))]
    : [{ text: g.hsn, fontSize: 8 }, r(money(g.taxable)), r(`${g.rate}%`), r(money(g.tax)), r(money(g.tax))]));
  const sum = (k) => rows.reduce((s, g) => s + g[k], 0);
  body.push(intraState
    ? [{ text: "Total", bold: true, fontSize: 8 }, r(money(sum("taxable")), true), r(""), r(money(sum("tax") / 2), true), r(""), r(money(sum("tax") / 2), true), r(money(sum("tax")), true)]
    : [{ text: "Total", bold: true, fontSize: 8 }, r(money(sum("taxable")), true), r(""), r(money(sum("tax")), true), r(money(sum("tax")), true)]);
  return {
    stack: [
      { text: "HSN/SAC Summary", bold: true, color: C.ink, margin: [0, 16, 0, 4] },
      { table: { headerRows: 2, widths: intraState ? ["*", 80, 36, 62, 36, 62, 70] : ["*", 100, 50, 80, 90], body: [...head, ...body] }, layout: hairline }
    ],
    unbreakable: true
  };
}

/* ---------------- Document specs ---------------- */

function companyAsParty() {
  const c = state.company;
  return { name: c.name, addressLines: c.addressLines, gstin: c.gstin, pan: c.pan, phone: c.phone, email: c.email };
}

export function poSpec(po) {
  const wh = po.deliverTo || {};
  return {
    title: "Purchase Order",
    number: po.poNo,
    status: ["CANCELLED", "SHORT CLOSED"].includes(po.status) ? po.status : "",
    meta: [
      ["Purchase Order#", po.poNo], ["Date", fmtDate(po.date)], ["Terms", po.paymentTerms], ["Ref#", po.refNo || po.poNo],
      ["Place Of Supply", po.placeOfSupply], ["Dispatch Through", po.dispatchThrough], ["Destination", po.destination], ["Terms of Delivery", po.deliveryTerms]
    ],
    leftTitle: "Vendor Address",
    left: po.vendor,
    rightTitle: "Deliver To",
    right: { name: `${state.company.name}${wh.name ? ` (${wh.name})` : ""}`, addressLines: wh.addressLines || [], gstin: state.company.gstin, pan: state.company.pan, phone: state.company.phone, email: state.company.email },
    lines: po.totals.lines,
    totals: po.totals,
    notes: po.notes,
    terms: po.terms
  };
}

export function quotationSpec(q) {
  return {
    title: "Quotation",
    number: q.quoteNo,
    meta: [
      ["Quotation#", q.quoteNo], ["Date", fmtDate(q.date)], ["Valid Until", fmtDate(q.validUntil)], ["Your Enquiry Ref", q.enquiryRef],
      ["Place Of Supply", q.placeOfSupply], ["Payment Terms", q.paymentTerms], ["Delivery", q.deliveryTerms], ["Delivery Period", q.deliveryPeriod]
    ],
    leftTitle: "Quotation To",
    left: q.customer,
    rightTitle: "From",
    right: companyAsParty(),
    lines: q.totals.lines,
    totals: q.totals,
    notes: q.notes,
    terms: q.terms,
    bank: true
  };
}

export function soSpec(so) {
  return {
    title: "Sales Order",
    number: so.soNo,
    status: ["CANCELLED", "SHORT CLOSED"].includes(so.status) ? so.status : "",
    meta: [
      ["Sales Order#", so.soNo], ["Date", fmtDate(so.date)], ["Customer PO#", so.customerPoNo], ["Customer PO Date", fmtDate(so.customerPoDate)],
      ["Place Of Supply", so.placeOfSupply], ["Payment Terms", so.paymentTerms], ["Delivery", so.deliveryTerms], ["Dispatch From", so.warehouseName]
    ],
    leftTitle: "Bill To",
    left: so.customer,
    rightTitle: "Ship To",
    right: so.shipTo?.addressLines?.length ? so.shipTo : so.customer,
    lines: so.totals.lines,
    totals: so.totals,
    notes: so.notes,
    terms: so.terms,
    bank: true
  };
}

export function piSpec(pi) {
  return {
    title: "Proforma Invoice",
    number: pi.piNo,
    copyLabel: "ORIGINAL",
    status: pi.status === "CANCELLED" ? "CANCELLED" : "",
    meta: [
      ["Invoice number", pi.piNo], ["Invoice Date", fmtDate(pi.date)], ["Terms", pi.termsDays ? `${pi.termsDays} Days` : pi.paymentTerms], ["Due Date", fmtDate(pi.dueDate)],
      ["Reference no. & Date", [pi.refNo, pi.refDate ? fmtDate(pi.refDate) : ""].filter(Boolean).join("  ")],
      ["Place Of Supply", pi.placeOfSupply], ["Dispatched Through", pi.dispatchThrough], ["Dispatch Doc No", pi.dispatchDocNo || pi.piNo], ["Destination", pi.destination], ["Dispatch From", pi.dispatchFrom]
    ],
    leftTitle: "Bill To",
    left: pi.customer,
    rightTitle: "Ship To",
    right: pi.shipTo?.addressLines?.length ? pi.shipTo : { ...pi.customer, name: "" },
    lines: pi.totals.lines,
    totals: pi.totals,
    balanceDue: pi.totals.total,
    itemsInTotal: pi.totals.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0),
    hsnSummary: true,
    intraState: pi.intraState,
    notes: pi.notes,
    terms: pi.terms,
    bank: true
  };
}

export function challanSpec(out) {
  const lines = [
    ...out.lines.map((l) => ({ ...l, description: [l.packing ? `Packed in ${qty(l.packing.count)} × ${l.packing.itemName}${l.packing.size ? ` (${qty(l.packing.size)} ${l.unit} each)` : ""}` : "", l.batchNo ? `Batch ${l.batchNo}` : ""].filter(Boolean).join(" · ") }))
  ];
  return {
    title: "Delivery Challan",
    number: out.dcNo,
    meta: [
      ["Challan#", out.dcNo], ["Date", fmtDate(out.date)], ["Invoice#", out.invoiceNo], ["Sales Order#", out.soNo],
      ["Dispatch From", out.warehouseName], ["Vehicle No", out.vehicleNo], ["Transporter", out.transporter], ["LR No", out.lrNo]
    ],
    leftTitle: "Consignee",
    left: out.customer,
    rightTitle: "Dispatched From",
    right: { name: state.company.name, addressLines: out.warehouseAddress || [], gstin: state.company.gstin },
    lines,
    totals: null,
    showRates: false,
    notes: out.remarks,
    termsTitle: "Acknowledgement",
    terms: "Received the above goods in good order and condition."
  };
}

/* ---------------- Viewer ---------------- */

export async function showDocument(spec, filename) {
  const modal = openModal({
    title: `${spec.title} ${spec.number}`,
    size: "full",
    body: '<div class="boot" style="min-height:40vh"><div><i class="fa-solid fa-spinner fa-spin"></i> Preparing document…</div></div>',
    footer: `<button class="btn" data-close>Close</button><button class="btn" id="pdfPrint" disabled><i class="fa-solid fa-print"></i> Print</button><button class="btn primary" id="pdfDownload" disabled><i class="fa-solid fa-file-pdf"></i> Download PDF</button>`
  });
  try {
    const pdfMake = await loadPdfMake();
    const definition = await buildDoc(spec);
    const pdf = pdfMake.createPdf(definition);
    const blob = await new Promise((resolve) => pdf.getBlob(resolve));
    const url = URL.createObjectURL(blob);
    modal.body.innerHTML = `<iframe class="pdf-frame" title="${esc(spec.title)} preview" src="${url}"></iframe>`;
    const dl = modal.el.querySelector("#pdfDownload");
    const pr = modal.el.querySelector("#pdfPrint");
    dl.disabled = false; pr.disabled = false;
    dl.addEventListener("click", () => downloadBlob(blob, filename));
    pr.addEventListener("click", () => modal.body.querySelector("iframe").contentWindow?.print());
    return { blob, modal };
  } catch (error) {
    console.error(error);
    modal.body.innerHTML = `<div class="notice error">Could not create the PDF: ${esc(error.message)}</div>`;
    toast("PDF could not be generated.", "error");
    return null;
  }
}

export async function pdfBlob(spec) {
  const pdfMake = await loadPdfMake();
  const pdf = pdfMake.createPdf(await buildDoc(spec));
  return new Promise((resolve) => pdf.getBlob(resolve));
}

export const safeFileName = (text) => String(text).replace(/[^A-Za-z0-9-]+/g, "_");
