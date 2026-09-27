import { db } from "./firebase-config.js";
import { initDocumentPreview } from "./document-preview.js";
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  where,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const sidebar = document.getElementById("sidebar");
const overlay = document.getElementById("mobileOverlay");
const mobileToggle = document.getElementById("mobileMenuToggle");
const grnTableBody = document.getElementById("grnTableBody");
const grnCount = document.getElementById("grnCount");
const grnSearchBy = document.getElementById("grnSearchBy");
const grnSearchInput = document.getElementById("grnSearchInput");
const grnSearchFieldLabel = document.getElementById("grnSearchFieldLabel");
const grnSearchFieldWrap = document.getElementById("grnSearchFieldWrap");
const grnFromDate = document.getElementById("grnFromDate");
const grnToDate = document.getElementById("grnToDate");
const grnFromDateWrap = document.getElementById("grnFromDateWrap");
const grnToDateWrap = document.getElementById("grnToDateWrap");
const grnSearchButton = document.getElementById("grnSearchButton");
const grnDrawer = document.getElementById("grnDrawer");
const grnDrawerBody = document.getElementById("grnDrawerBody");
const drawerBackdrop = document.getElementById("drawerBackdrop");
const closeGrnDrawer = document.getElementById("closeGrnDrawer");
let pendingEntries = [];
let kantaRecords = [];
let inwardRecords = [];
let acceptedGrns = [];
initDocumentPreview();

function escapeHTML(value) {
  return String(value ?? "—").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function valueOf(record, ...keys) {
  for (const key of keys) if (record[key] !== undefined && record[key] !== null && record[key] !== "") return record[key];
  return "";
}

function dateOf(record) {
  const value = valueOf(record, "finalizedAt", "finalized_at", "createdAt", "created_at", "timestamp", "date");
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateText(record) {
  const date = dateOf(record);
  return date ? date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—";
}

function filterValue(record, keyOptions) {
  return String(valueOf(record, ...keyOptions) || "").trim();
}

function matchesDateRange(record, fromDate, toDate) {
  const date = dateOf(record);
  if (!date) return false;
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  if (fromDate && localDate < fromDate) return false;
  if (toDate && localDate > toDate) return false;
  return true;
}

function getSearchSuggestions(entries, keyOptions) {
  return [...new Set(entries.map((entry) => filterValue(entry, keyOptions)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function updateGrnSearchUI() {
  const searchBy = grnSearchBy.value;
  const isDateSearch = searchBy === "date";
  grnSearchFieldWrap.classList.toggle("hidden", isDateSearch);
  grnFromDateWrap.classList.toggle("hidden", !isDateSearch);
  grnToDateWrap.classList.toggle("hidden", !isDateSearch);
  grnSearchInput.disabled = isDateSearch;

  const fieldMap = {
    product: ["product", "product_name"],
    supplier: ["supplier", "supplier_name"],
    receivingLocation: ["receivingLocation", "receiving_location", "location"]
  };

  if (fieldMap[searchBy]) {
    const suggestions = getSearchSuggestions(pendingEntries, fieldMap[searchBy]);
    const suggestionsList = document.getElementById("grnSearchSuggestions");
    suggestionsList.innerHTML = suggestions.map((value) => `<option value="${escapeHTML(value)}"></option>`).join("");
    grnSearchFieldLabel.textContent = searchBy === "product" ? "Product" : searchBy === "supplier" ? "Supplier" : "Receiving Location";
    grnSearchInput.placeholder = `Enter ${grnSearchFieldLabel.textContent.toLowerCase()}`;
  } else {
    document.getElementById("grnSearchSuggestions").innerHTML = "";
    grnSearchFieldLabel.textContent = "Search Entry";
    grnSearchInput.placeholder = "Enter search value";
  }

  if (isDateSearch) {
    grnSearchInput.value = "";
  }
}

function matchesSearch(entry, searchBy, searchValue, fromDate, toDate) {
  if (!searchBy) return true;

  if (searchBy === "date") {
    return matchesDateRange(entry, fromDate, toDate);
  }

  const fieldMap = {
    product: ["product", "product_name"],
    supplier: ["supplier", "supplier_name"],
    receivingLocation: ["receivingLocation", "receiving_location", "location"]
  };

  const targetValue = String(filterValue(entry, fieldMap[searchBy] || []) || "").trim().toLowerCase();
  return !searchValue || targetValue.includes(searchValue.toLowerCase());
}

function documentLink(url, title = "Document") {
  return url
    ? `<button class="row-action" type="button" data-preview-url="${escapeHTML(url)}" data-preview-title="${escapeHTML(title)}">Open</button>`
    : `<span>Document not available</span>`;
}

function openGrnDrawer() {
  grnDrawer.classList.add("open");
  drawerBackdrop.classList.add("show");
}

function closeGrnDrawerPanel() {
  grnDrawer.classList.remove("open");
  drawerBackdrop.classList.remove("show");
  grnDrawerBody.innerHTML = "";
}

function kantaFor(entry) {
  return kantaRecords.find((record) => valueOf(record, "inwardId", "inward_id") === entry.id && ["KANTA COMPLETED", "GRN FINALIZED"].includes(String(record.status || "").toUpperCase()));
}

function inwardForGrn(grn) {
  const inwardId = valueOf(grn, "inwardId", "inward_id");
  return inwardRecords.find((record) => record.id === inwardId) || null;
}

function kantaForGrn(grn) {
  const kantaId = valueOf(grn, "kantaId", "kanta_id");
  const inwardId = valueOf(grn, "inwardId", "inward_id");
  return kantaRecords.find((record) => record.id === kantaId)
    || kantaRecords.find((record) => valueOf(record, "inwardId", "inward_id") === inwardId)
    || null;
}

function acceptedValue(grn, inward, kanta, ...keys) {
  return valueOf(grn, ...keys) || valueOf(inward || {}, ...keys) || valueOf(kanta || {}, ...keys);
}

function quantityText(quantity, unit) {
  if (quantity === "") return "—";
  const value = String(quantity);
  return unit && !value.toLowerCase().includes(String(unit).toLowerCase()) ? `${value} ${unit}` : value;
}

function renderAcceptedRows() {
  const body = document.getElementById("acceptedGrnTableBody");
  const count = document.getElementById("acceptedGrnCount");
  if (!body || !count) return;
  count.textContent = `${acceptedGrns.length} ${acceptedGrns.length === 1 ? "record" : "records"}`;
  if (!acceptedGrns.length) {
    body.innerHTML = `<tr><td class="empty-row" colspan="11">No accepted GRNs found</td></tr>`;
    return;
  }

  body.innerHTML = acceptedGrns.map((grn) => {
    const inward = inwardForGrn(grn);
    const kanta = kantaForGrn(grn);
    const product = acceptedValue(grn, inward, kanta, "product", "product_name");
    const location = acceptedValue(grn, inward, kanta, "receivingLocation", "receiving_location", "location");
    const unit = acceptedValue(grn, inward, kanta, "unit", "quantityUnit", "quantity_unit");
    const quantity = valueOf(kanta || {}, "receivedQty", "received_quantity", "receivedQuantity", "netWeight", "net_weight");
    const note = valueOf(grn, "note", "notes");
    const grnNumber = valueOf(grn, "grnNumber", "grn_number", "grnNo", "grn_no") || grn.id;
    return `<tr>
      <td>${escapeHTML(grnNumber)}</td>
      <td>${escapeHTML(dateText(grn))}</td>
      <td>${escapeHTML(valueOf(inward || {}, "invoiceChallanNo", "invoice_challan_no", "invoice_no", "challan_no") || "—")}</td>
      <td>${escapeHTML(valueOf(inward || {}, "purchaseOrder", "purchase_order", "poNumber", "po_number") || "—")}</td>
      <td>${escapeHTML(product || "—")}</td>
      <td>${escapeHTML(valueOf(inward || {}, "supplier", "supplier_name") || "—")}</td>
      <td>${escapeHTML(location || "—")}</td>
      <td>${escapeHTML(quantity === "" ? "—" : `${quantity}${unit ? ` ${unit}` : ""}`)}</td>
      <td><span class="status-tag success">${escapeHTML(valueOf(grn, "status") || "GRN FINALIZED")}</span></td>
      <td><span class="accepted-note" title="${escapeHTML(note || "N/A")}">${escapeHTML(note || "N/A")}</span></td>
      <td><button class="row-action" type="button" data-view-accepted="${escapeHTML(grn.id)}">View</button></td>
    </tr>`;
  }).join("");

  body.querySelectorAll("[data-view-accepted]").forEach((button) => {
    button.addEventListener("click", () => {
      const grn = acceptedGrns.find((record) => record.id === button.dataset.viewAccepted);
      if (grn) openAcceptedGrnDetails(grn);
    });
  });
}

function openAcceptedGrnDetails(grn) {
  const inward = inwardForGrn(grn);
  const kanta = kantaForGrn(grn);
  const product = acceptedValue(grn, inward, kanta, "product", "product_name");
  const location = acceptedValue(grn, inward, kanta, "receivingLocation", "receiving_location", "location");
  const unit = acceptedValue(grn, inward, kanta, "unit", "quantityUnit", "quantity_unit");
  const declaredQty = valueOf(kanta || {}, "declaredQuantity", "declared_quantity") || valueOf(inward || {}, "declaredQuantity", "declared_quantity", "quantity");
  const receivedQty = valueOf(kanta || {}, "receivedQty", "received_quantity", "receivedQuantity", "netWeight", "net_weight");
  const note = valueOf(grn, "note", "notes");
  const grnNumber = valueOf(grn, "grnNumber", "grn_number", "grnNo", "grn_no") || grn.id;
  const documentLinkFor = (title, record, ...keys) => documentLink(valueOf(record || {}, ...keys), title);
  grnDrawer.querySelector(".drawer-label").textContent = "Accepted GRN";
  grnDrawer.querySelector(".drawer-header h3").textContent = String(grnNumber);
  grnDrawerBody.innerHTML = `
    <section class="drawer-section"><h4>GRN Details</h4><div class="detail-grid">
      <div><span>GRN Number</span><strong>${escapeHTML(grnNumber)}</strong></div>
      <div><span>GRN Date</span><strong>${escapeHTML(dateText({ createdAt: valueOf(grn, "createdAt", "created_at") || valueOf(inward || {}, "createdAt", "created_at") || valueOf(grn, "finalizedAt", "finalized_at") }))}</strong></div>
      <div><span>Finalized Date/Time</span><strong>${escapeHTML(dateText(grn))}</strong></div>
      <div><span>Invoice Number</span><strong>${escapeHTML(valueOf(inward || {}, "invoiceChallanNo", "invoice_challan_no", "invoice_no", "challan_no") || "—")}</strong></div>
      <div><span>PO Number</span><strong>${escapeHTML(valueOf(inward || {}, "purchaseOrder", "purchase_order", "poNumber", "po_number") || "—")}</strong></div>
      <div><span>Product</span><strong>${escapeHTML(product || "—")}</strong></div>
      <div><span>Supplier</span><strong>${escapeHTML(valueOf(inward || {}, "supplier", "supplier_name") || "—")}</strong></div>
      <div><span>Receiving Location</span><strong>${escapeHTML(location || "—")}</strong></div>
      <div><span>Kanta Declared Qty</span><strong>${escapeHTML(quantityText(declaredQty, unit))}</strong></div>
      <div><span>Kanta Received Qty</span><strong>${escapeHTML(quantityText(receivedQty, unit))}</strong></div>
      <div><span>Unit</span><strong>${escapeHTML(unit || "—")}</strong></div>
      <div><span>Status</span><strong>${escapeHTML(valueOf(grn, "status") || "—")}</strong></div>
      <div><span>Inward ID</span><strong>${escapeHTML(valueOf(grn, "inwardId", "inward_id") || "—")}</strong></div>
      <div><span>Kanta ID</span><strong>${escapeHTML(valueOf(grn, "kantaId", "kanta_id") || "—")}</strong></div>
      <div><span>Notes</span><strong>${escapeHTML(note || "N/A")}</strong></div>
    </div></section>
    <section class="drawer-section"><h4>Documents</h4><div class="detail-grid">
      <div><span>COA</span><strong>${documentLinkFor("COA", inward, "coaFileUrl", "coa_file_url", "supplier_coa_path")}</strong></div>
      <div><span>Invoice</span><strong>${documentLinkFor("Invoice", inward, "invoiceFileUrl", "invoice_file_url", "invoiceFilePath", "invoice_file_path")}</strong></div>
      <div><span>Purchase Order</span><strong>${documentLinkFor("Purchase Order", inward, "poFileUrl", "po_file_url", "purchase_order_file_url")}</strong></div>
      <div><span>Kanta Slip</span><strong>${documentLinkFor("Kanta Slip", kanta, "kantaSlipUrl", "kanta_slip_url")}</strong></div>
    </div></section>`;
  openGrnDrawer();
}

function stockIdPart(value) {
  const encoded = encodeURIComponent(String(value).trim().normalize("NFKC").toLowerCase());
  return `${encoded.length}_${encoded}`;
}

function stockDocumentId(productKey, locationKey) {
  return [productKey, locationKey].map(stockIdPart).join("__");
}

function validReceivingLocation(value) {
  return ["Warehouse A", "Warehouse B", "Plant Store"].includes(value);
}

function validStockQuantity(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const quantity = Number(value);
  return Number.isFinite(quantity) && quantity > 0 ? quantity : null;
}

function renderRows() {
  const searchBy = grnSearchBy.value;
  const searchValue = grnSearchInput.value.trim();
  const fromDate = grnFromDate.value;
  const toDate = grnToDate.value;

  const filteredEntries = pendingEntries.filter((entry) => matchesSearch(entry, searchBy, searchValue, fromDate, toDate));
  grnCount.textContent = `${filteredEntries.length} record${filteredEntries.length === 1 ? "" : "s"}`;
  if (!filteredEntries.length) {
    grnTableBody.innerHTML = `<tr><td class="empty-row" colspan="11">No records found</td></tr>`;
    return;
  }

  grnTableBody.innerHTML = filteredEntries.map((entry) => {
    const kanta = kantaFor(entry);
    const kantaQuantity = Number(valueOf(kanta || {}, "receivedQty", "received_quantity", "receivedQuantity", "netWeight", "net_weight"));
    const purchaseOrderNo = valueOf(entry, "purchaseOrder", "purchase_order", "poNumber", "po_number");
    return `<tr>
      <td>${escapeHTML(dateText(entry))}</td>
      <td>${escapeHTML(valueOf(entry, "invoiceChallanNo", "invoice_challan_no", "invoice_no", "challan_no"))}</td>
      <td>${escapeHTML(purchaseOrderNo || "—")}</td>
      <td>${escapeHTML(valueOf(entry, "product", "product_name"))}</td>
      <td>${escapeHTML(valueOf(entry, "supplier", "supplier_name"))}</td>
      <td>${escapeHTML(valueOf(entry, "receivingLocation", "receiving_location", "location"))}</td>
      <td>${Number.isFinite(kantaQuantity) && kantaQuantity > 0 ? escapeHTML(kantaQuantity) : "—"}</td>
      <td>${documentLink(valueOf(entry, "coaFileUrl", "coa_file_url", "supplier_coa_path"), "COA")}</td>
      <td>${documentLink(valueOf(entry, "invoiceFileUrl", "invoice_file_url", "invoiceFilePath"), "Invoice")}</td>
      <td>${documentLink(valueOf(entry, "poFileUrl", "po_file_url", "purchase_order_file_url"), "Purchase Order")}</td>
      <td>${documentLink(valueOf(kanta || {}, "kantaSlipUrl", "kanta_slip_url"), "Kanta Slip")}</td>
      <td><span class="status-tag warning">GRN PENDING</span></td>
      <td class="action-col">
        <div class="inline-actions">
          <button class="row-action" data-edit-id="${escapeHTML(entry.id)}" type="button">Edit</button>
          <button class="row-action danger" data-delete-id="${escapeHTML(entry.id)}" type="button">Delete</button>
        </div>
      </td>
    </tr>`;
  }).join("");

  grnTableBody.querySelectorAll("[data-edit-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const entry = pendingEntries.find((item) => item.id === button.dataset.editId);
      if (entry) renderEditor(entry);
    });
  });

  grnTableBody.querySelectorAll("[data-delete-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      const entry = pendingEntries.find((item) => item.id === button.dataset.deleteId);
      const kanta = entry ? kantaFor(entry) : null;
      if (!entry || !window.confirm("Delete this pending GRN record?")) return;

      button.disabled = true;
      button.textContent = "Deleting...";
      try {
        const batch = writeBatch(db);
        batch.delete(doc(db, "inward", entry.id));
        if (kanta) batch.delete(doc(db, "kanta", kanta.id));
        await batch.commit();
      } catch (error) {
        console.error("Unable to delete GRN record.", error);
        button.disabled = false;
        button.textContent = "Delete";
        window.alert("GRN record could not be deleted. Please check your connection and try again.");
      }
    });
  });
}

function renderEditor(entry) {
  const kanta = kantaFor(entry);
  const declaredQuantity = Number(valueOf(entry, "declaredQuantity", "declared_quantity", "quantity"));
  const unit = valueOf(entry, "unit", "quantityUnit", "quantity_unit");
  const receivedQty = valueOf(kanta || {}, "receivedQty", "received_quantity", "receivedQuantity", "netWeight", "net_weight");

  grnDrawerBody.innerHTML = `
    <div class="drawer-section"><h4>Inward Details</h4><div class="detail-grid">
      <div><span>Industry Type</span><strong>${escapeHTML(valueOf(entry, "industryType", "industry_type"))}</strong></div>
      <div><span>Purchase Order (PO)</span><strong>${escapeHTML(valueOf(entry, "purchaseOrder", "purchase_order", "poNumber", "po_number"))}</strong></div>
      <div><span>Invoice / Challan</span><strong>${escapeHTML(valueOf(entry, "invoiceChallanNo", "invoice_challan_no"))}</strong></div>
      <div><span>PO No.</span><strong>${escapeHTML(valueOf(entry, "purchaseOrder", "purchase_order", "poNumber", "po_number"))}</strong></div>
      <div><span>Supplier</span><strong>${escapeHTML(valueOf(entry, "supplier", "supplier_name"))}</strong></div>
      <div><span>Product</span><strong>${escapeHTML(valueOf(entry, "product", "product_name"))}</strong></div>
      <div><span>Receiving Location</span><strong>${escapeHTML(valueOf(entry, "receivingLocation", "receiving_location", "location"))}</strong></div>
      <div><span>Declared Quantity</span><strong>${escapeHTML(declaredQuantity)} ${escapeHTML(unit)}</strong></div>
      <div><span>Received Qty</span><strong>${escapeHTML(receivedQty === "" ? "Unavailable" : `${receivedQty} ${unit}`)}</strong></div>
      <div><span>Purchase Order</span><strong>${documentLink(valueOf(entry, "poFileUrl", "po_file_url", "purchase_order_file_url"))}</strong></div>
      <div><span>Kanta Slip</span><strong>${documentLink(valueOf(kanta || {}, "kantaSlipUrl", "kanta_slip_url"))}</strong></div>
    </div></div>
    <div class="drawer-section"><h4>GRN Finalize</h4><form id="grnForm" class="drawer-form" novalidate>
      <div class="field-grid">
        <label style="grid-column: 1 / -1"><span>Remark</span><input type="text" name="remark" placeholder="Optional remarks" /></label>
        <label style="grid-column: 1 / -1"><span>Note</span><textarea name="note" rows="6" placeholder="Add any note for this GRN record"></textarea></label>
      </div>
      <p id="grnMessage" aria-live="polite"></p>
      <div class="drawer-actions"><button type="submit" class="primary-btn">Finalize GRN</button></div>
    </form></div>`;

  const form = document.getElementById("grnForm");
  const message = document.getElementById("grnMessage");
  const submitButton = form.querySelector("button[type=submit]");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitButton.disabled) return;
    submitButton.disabled = true;
    submitButton.textContent = "Finalizing...";

    try {
      if (!kanta) throw new Error("This record has no valid Kanta entry.");
      const remark = form.elements.remark.value.trim();
      const note = form.elements.note.value.trim();

      await runTransaction(db, async (transaction) => {
        const inwardRef = doc(db, "inward", entry.id);
        const kantaRef = doc(db, "kanta", kanta.id);
        const grnRef = doc(db, "grn", entry.id);
        const [inwardSnapshot, kantaSnapshot, grnSnapshot] = await Promise.all([
          transaction.get(inwardRef),
          transaction.get(kantaRef),
          transaction.get(grnRef)
        ]);
        if (!inwardSnapshot.exists() || !kantaSnapshot.exists()) throw new Error("The Inward or Kanta source record is no longer available.");
        if (grnSnapshot.exists()) throw new Error("GRN already finalized.");

        const inwardData = inwardSnapshot.data();
        const kantaData = kantaSnapshot.data();
        const inwardStatus = String(valueOf(inwardData, "status", "workflow_status")).toUpperCase();
        const kantaStatus = String(valueOf(kantaData, "status", "workflow_status")).toUpperCase();
        if (inwardStatus !== "GRN PENDING") throw new Error("This Inward record is not ready for GRN finalization.");
        if (!(["KANTA COMPLETED", "GRN FINALIZED"].includes(kantaStatus))) throw new Error("This Kanta entry is not complete.");
        if (String(valueOf(kantaData, "inwardId", "inward_id")) !== entry.id) throw new Error("The Kanta entry does not match this Inward record.");

        const productName = String(valueOf(inwardData, "product", "product_name")).trim();
        const productId = valueOf(inwardData, "product_id", "productId") || null;
        const receivingLocation = valueOf(inwardData, "receivingLocation", "receiving_location", "location");
        const sourceLocationId = valueOf(inwardData, "receivingLocationId", "receiving_location_id", "locationId", "location_id");
        const receivingLocationId = sourceLocationId || receivingLocation;
        const unit = String(valueOf(inwardData, "unit", "quantityUnit", "quantity_unit")).trim();
        const receivedValue = valueOf(kantaData, "receivedQty", "received_quantity", "receivedQuantity", "netWeight", "net_weight");
        const receivedQty = validStockQuantity(receivedValue);
        if (!productName) throw new Error("Product is missing from the Inward record.");
        if (!validReceivingLocation(receivingLocation)) {
          const invalidLocation = receivingLocation === "" ? "missing" : `\"${String(receivingLocation)}\"`;
          throw new Error(`Invalid receiving location ${invalidLocation}. Choose Warehouse A, Warehouse B, or Plant Store.`);
        }
        if (!unit) throw new Error("Unit is missing from the Inward record.");
        if (receivedQty === null) throw new Error("Kanta Received Qty must be a valid quantity greater than zero.");
        const kantaProduct = valueOf(kantaData, "product", "product_name");
        const kantaLocation = valueOf(kantaData, "receivingLocation", "receiving_location", "location");
        const kantaUnit = valueOf(kantaData, "unit", "quantityUnit", "quantity_unit");
        if (kantaProduct && kantaProduct !== productName) throw new Error("Kanta product does not match the Inward product.");
        if (kantaLocation && kantaLocation !== receivingLocation) throw new Error("Kanta receiving location does not match Inward.");
        if (kantaUnit && kantaUnit !== unit) throw new Error("Kanta unit does not match the Inward unit.");

        const productKey = productId || productName;
        const stockRef = doc(db, "stock", stockDocumentId(productKey, receivingLocationId));
        const stockIdentity = [productKey, receivingLocationId, unit].map(stockIdPart).join("__");
        const transactionId = `${entry.id}_IN`;
        const ledgerRef = doc(db, "stockLedger", transactionId);
        const [stockSnapshot, ledgerSnapshot] = await Promise.all([
          transaction.get(stockRef),
          transaction.get(ledgerRef)
        ]);
        if (ledgerSnapshot.exists()) throw new Error("This GRN already has a stock ledger entry.");

        const stockData = stockSnapshot.exists() ? stockSnapshot.data() : {};
        const existingUnit = String(valueOf(stockData, "unit")).trim();
        if (stockSnapshot.exists() && existingUnit.toLowerCase() !== unit.toLowerCase()) {
          throw new Error(`Existing stock uses ${existingUnit || "an unknown unit"}; ${unit} cannot be added to it.`);
        }
        const currentStockValue = stockSnapshot.exists()
          ? valueOf(stockData, "current_stock", "currentStock", "available_quantity", "availableQuantity", "quantity")
          : 0;
        if (stockSnapshot.exists() && currentStockValue === "") throw new Error("Existing stock quantity is missing. Inventory was not updated.");
        const currentStock = Number(currentStockValue);
        if (!Number.isFinite(currentStock) || currentStock < 0) throw new Error("Existing stock quantity is invalid. Inventory was not updated.");
        const totalReceivedValue = valueOf(stockData, "total_received", "totalReceived");
        const totalIssuedValue = valueOf(stockData, "total_issued", "totalIssued");
        const totalReceived = totalReceivedValue === "" ? 0 : Number(totalReceivedValue);
        const totalIssued = totalIssuedValue === "" ? 0 : Number(totalIssuedValue);
        if (!Number.isFinite(totalReceived) || totalReceived < 0 || !Number.isFinite(totalIssued) || totalIssued < 0) {
          throw new Error("Existing stock totals are invalid. Inventory was not updated.");
        }

        const timestamp = serverTimestamp();
        transaction.set(stockRef, {
          id: stockRef.id,
          product_id: productId,
          product_name: productName,
          identity_key: stockIdentity,
          receiving_location: receivingLocation,
          receiving_location_id: sourceLocationId || valueOf(stockData, "receiving_location_id", "location_id", "locationId") || null,
          current_stock: currentStock + receivedQty,
          unit,
          total_received: totalReceived + receivedQty,
          total_issued: totalIssued,
          last_grn_id: grnRef.id,
          last_transaction_id: transactionId,
          created_at: valueOf(stockData, "created_at", "createdAt") || timestamp,
          updated_at: timestamp
        }, { merge: true });
        transaction.set(ledgerRef, {
          transaction_id: transactionId,
          grn_id: grnRef.id,
          inward_id: inwardRef.id,
          kanta_id: kantaRef.id,
          stock_id: stockRef.id,
          product_id: productId,
          product_name: productName,
          location: receivingLocation,
          location_id: sourceLocationId || valueOf(stockData, "receiving_location_id", "location_id", "locationId") || null,
          transaction_type: "IN",
          quantity: receivedQty,
          unit,
          reference_type: "GRN",
          reference_id: grnRef.id,
          created_at: timestamp
        });

        transaction.set(grnRef, {
          inwardId: entry.id,
          kantaId: kanta.id,
          product: productName,
          product_id: productId,
          receivingLocation,
          receiving_location: receivingLocation,
          receiving_location_id: sourceLocationId || null,
          unit,
          remark,
          note,
          status: "GRN FINALIZED",
          inventoryUpdated: true,
          inventoryUpdatedAt: timestamp,
          stockTransactionId: transactionId,
          createdAt: serverTimestamp(),
          finalizedAt: serverTimestamp()
        });
        transaction.update(inwardRef, { status: "GRN FINALIZED" });
        transaction.update(kantaRef, { status: "GRN FINALIZED" });
      });
      closeGrnDrawerPanel();
    } catch (error) {
      console.error("Unable to finalize GRN.", error);
      message.textContent = error.message === "GRN already finalized."
        ? error.message
        : error.code
          ? "Unable to finalize GRN. Inventory was not updated."
          : error.message || "Unable to finalize GRN. Inventory was not updated.";
      message.style.color = "var(--danger)";
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = "Finalize GRN";
    }
  });
  openGrnDrawer();
}

function listen() {
  grnSearchBy.addEventListener("change", () => {
    updateGrnSearchUI();
    renderRows();
  });
  grnSearchInput.addEventListener("input", renderRows);
  grnFromDate.addEventListener("change", renderRows);
  grnToDate.addEventListener("change", renderRows);
  grnSearchButton.addEventListener("click", renderRows);
  onSnapshot(query(collection(db, "inward"), where("status", "==", "GRN PENDING")), (snapshot) => {
    pendingEntries = snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort((a, b) => (dateOf(b)?.getTime() || 0) - (dateOf(a)?.getTime() || 0));
    updateGrnSearchUI();
    renderRows();
  }, (error) => {
    console.error("Unable to load GRN pending records.", error);
    grnTableBody.innerHTML = `<tr><td class="empty-row" colspan="11">Unable to load records. Please refresh and try again.</td></tr>`;
  });
  onSnapshot(collection(db, "kanta"), (snapshot) => {
    kantaRecords = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    renderRows();
    renderAcceptedRows();
  }, (error) => console.error("Unable to load Kanta records for GRN.", error));
  onSnapshot(collection(db, "inward"), (snapshot) => {
    inwardRecords = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    renderAcceptedRows();
  }, (error) => console.error("Unable to load Inward details for accepted GRNs.", error));
  const acceptedQuery = query(
    collection(db, "grn"),
    orderBy("finalizedAt", "desc"),
    limit(5)
  );
  onSnapshot(acceptedQuery, (snapshot) => {
    acceptedGrns = snapshot.docs
      .map((item) => ({ id: item.id, ...item.data() }))
      .filter((item) => String(valueOf(item, "status")).toUpperCase() === "GRN FINALIZED")
      .slice(0, 5);
    renderAcceptedRows();
  }, (error) => {
    console.error("Unable to load accepted GRNs.", error);
    document.getElementById("acceptedGrnTableBody").innerHTML = `<tr><td class="empty-row" colspan="11">Accepted GRNs could not be loaded.</td></tr>`;
  });
}

closeGrnDrawer.addEventListener("click", closeGrnDrawerPanel);
drawerBackdrop.addEventListener("click", closeGrnDrawerPanel);
if (mobileToggle) mobileToggle.addEventListener("click", () => { sidebar.classList.toggle("open"); overlay.classList.toggle("active"); });
if (overlay) overlay.addEventListener("click", () => { sidebar.classList.remove("open"); overlay.classList.remove("active"); });
window.addEventListener("resize", () => { if (window.innerWidth > 820) { sidebar.classList.remove("open"); overlay.classList.remove("active"); } });
listen();
