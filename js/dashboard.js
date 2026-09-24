import { db } from "./firebase-config.js";
import {
  collection,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const state = {
  inward: [],
  kanta: [],
  grn: [],
  stock: [],
  outward: [],
  filters: {
    search: "",
    status: "",
    location: "",
    date: ""
  }
};

const elements = {
  totalInward: document.getElementById("totalInward"),
  pendingKanta: document.getElementById("pendingKanta"),
  pendingGrn: document.getElementById("pendingGrn"),
  totalStock: document.getElementById("totalStock"),
  recentBody: document.getElementById("recentInwardBody"),
  recentCount: document.getElementById("recentInwardCount"),
  finalizedBody: document.getElementById("finalizedBody"),
  finalizedCount: document.getElementById("finalizedCount"),
  stockBody: document.getElementById("stockBody"),
  stockCount: document.getElementById("stockCount"),
  pendingKantaCount: document.getElementById("pendingKantaCount"),
  pendingGrnCount: document.getElementById("pendingGrnCount"),
  pendingDocumentsCount: document.getElementById("pendingDocumentsCount"),
  search: document.getElementById("dashboardSearch"),
  status: document.getElementById("statusFilter"),
  location: document.getElementById("locationFilter"),
  date: document.getElementById("dateFilter")
};

const dashboardStatus = document.getElementById("dashboardStatus");

function escapeHTML(value) {
  return String(value ?? "—")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function valueOf(record, ...keys) {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== "") {
      return record[key];
    }
  }
  return "";
}

function numberOf(record, ...keys) {
  const value = valueOf(record, ...keys);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateOf(record) {
  const value = valueOf(record, "created_at", "createdAt", "timestamp", "date", "updated_at", "updatedAt");
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateText(record) {
  const date = dateOf(record);
  return date ? date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—";
}

function dateKey(record) {
  const date = dateOf(record);
  return date ? date.getTime() : 0;
}

function statusOf(record, fallback = "Pending") {
  const status = valueOf(record, "status", "workflow_status", "state");
  return status || fallback;
}

function statusClass(status) {
  const normalized = status.toLowerCase();
  if (normalized.includes("final") || normalized.includes("complete") || normalized.includes("approved")) return "success";
  if (normalized.includes("reject") || normalized.includes("cancel")) return "danger";
  return "warning";
}

function isFinalized(record) {
  const status = statusOf(record, "").toLowerCase();
  return record.finalized === true || status === "grn finalized";
}

function isPending(record) {
  const status = statusOf(record, "pending").toLowerCase();
  return !isFinalized(record) && (status.includes("pending") || !valueOf(record, "status", "workflow_status", "state"));
}

function hasDocumentPending(record) {
  const status = valueOf(record, "document_status", "documentStatus", "documents_status").toLowerCase();
  if (status.includes("pending") || status.includes("missing")) return true;

  const invoice = valueOf(record, "invoiceFileUrl", "invoice_file_path", "invoiceFilePath", "invoice_url", "invoiceUrl");
  const coa = valueOf(record, "coaFileUrl", "supplier_coa_path", "supplierCoaPath", "coa_url", "coaUrl");
  return !invoice || !coa;
}

function recordText(record) {
  return [
    valueOf(record, "product", "product_name"),
    valueOf(record, "supplier", "supplier_name"),
    valueOf(record, "invoice_challan_no", "invoiceChallanNo", "invoice_no", "challan_no"),
    valueOf(record, "lot_no", "lotNo", "supplier_lot_no", "supplierLotNo")
  ].join(" ").toLowerCase();
}

function matchesFilters(record) {
  const { search, status, location, date } = state.filters;
  const recordStatus = statusOf(record).toLowerCase();
  const recordLocation = valueOf(record, "receiving_location", "receivingLocation", "location").toLowerCase();
  const recordDate = dateOf(record);
  const statusMatches = !status
    || recordStatus === status
    || recordStatus.includes(status)
    || (status === "finalized" && isFinalized(record))
    || (status === "pending" && isPending(record));

  return (!search || recordText(record).includes(search))
    && statusMatches
    && (!location || recordLocation === location)
    && (!date || (recordDate && recordDate.toISOString().slice(0, 10) === date));
}

function emptyRow(columnCount, message = "No records found") {
  return `<tr><td class="empty-cell" colspan="${columnCount}">${message}</td></tr>`;
}

function renderStats() {
  const totalStock = state.stock.reduce((total, record) => total + numberOf(record, "available_quantity", "availableQuantity", "quantity", "current_stock", "currentStock"), 0);
  const pendingKanta = state.inward.filter((record) => statusOf(record, "").toUpperCase() === "KANTA PENDING").length;
  const pendingGrn = state.inward.filter((record) => statusOf(record, "").toUpperCase() === "GRN PENDING").length;

  elements.totalInward.textContent = state.inward.length.toLocaleString();
  elements.pendingKanta.textContent = pendingKanta.toLocaleString();
  elements.pendingGrn.textContent = pendingGrn.toLocaleString();
  elements.totalStock.textContent = totalStock.toLocaleString();
  elements.pendingKantaCount.textContent = pendingKanta.toLocaleString();
  elements.pendingGrnCount.textContent = pendingGrn.toLocaleString();
  elements.pendingDocumentsCount.textContent = state.inward.filter(hasDocumentPending).length.toLocaleString();
}

function renderRecent() {
  const records = state.inward
    .filter(matchesFilters)
    .sort((a, b) => dateKey(b) - dateKey(a));

  elements.recentCount.textContent = `${records.length} records`;
  elements.recentBody.innerHTML = records.length ? records.slice(0, 10).map((record) => {
    const status = statusOf(record, "INWARD");
    return `<tr>
      <td>${escapeHTML(dateText(record))}</td>
      <td>${escapeHTML(valueOf(record, "invoice_challan_no", "invoiceChallanNo", "invoice_no", "challan_no"))}</td>
      <td>${escapeHTML(valueOf(record, "product", "product_name"))}</td>
      <td>${escapeHTML(valueOf(record, "supplier", "supplier_name"))}</td>
      <td>${escapeHTML(valueOf(record, "declared_quantity", "declaredQuantity", "quantity"))}</td>
      <td>${escapeHTML(valueOf(record, "receiving_location", "receivingLocation", "location"))}</td>
      <td><span class="status-tag ${statusClass(status)}">${escapeHTML(status)}</span></td>
      <td><a class="row-action" href="record_detail.html?id=${encodeURIComponent(record.id)}">View</a></td>
    </tr>`;
  }).join("") : emptyRow(8);
}

function renderFinalized() {
  const records = state.inward
    .filter((record) => statusOf(record, "").toUpperCase() === "GRN FINALIZED")
    .filter(matchesFilters)
    .sort((a, b) => dateKey(b) - dateKey(a));

  elements.finalizedCount.textContent = `${records.length} records`;
  elements.finalizedBody.innerHTML = records.length ? records.map((record) => {
    const status = "GRN FINALIZED";
    const coa = valueOf(record, "coaFileUrl", "coa_file_url", "supplier_coa_path", "coa_url", "coaUrl");
    const invoice = valueOf(record, "invoiceFileUrl", "invoice_file_url", "invoiceFilePath", "invoice_url", "invoiceUrl");
    return `<tr>
      <td>${escapeHTML(dateText(record))}</td>
      <td>${escapeHTML(valueOf(record, "invoice_challan_no", "invoiceChallanNo", "invoice_no", "challan_no"))}</td>
      <td>${escapeHTML(valueOf(record, "product", "product_name"))}</td>
      <td>${escapeHTML(valueOf(record, "supplier", "supplier_name"))}</td>
      <td>${escapeHTML(valueOf(record, "receiving_location", "receivingLocation", "location"))}</td>
      <td>${coa ? `<a class="row-action" href="${escapeHTML(coa)}" target="_blank" rel="noopener noreferrer">View</a>` : "—"}</td>
      <td>${invoice ? `<a class="row-action" href="${escapeHTML(invoice)}" target="_blank" rel="noopener noreferrer">View</a>` : "—"}</td>
      <td><span class="status-tag ${statusClass(status)}">${escapeHTML(status)}</span></td>
      <td><a class="row-action" href="record_detail.html?id=${encodeURIComponent(record.id)}">View</a></td>
    </tr>`;
  }).join("") : emptyRow(9);
}

function renderStock() {
  const records = state.stock
    .filter(matchesFilters)
    .sort((a, b) => dateKey(b) - dateKey(a));

  elements.stockCount.textContent = `${records.length} records`;
  elements.stockBody.innerHTML = records.length ? records.map((record) => `<tr>
    <td>${escapeHTML(valueOf(record, "product", "product_name"))}</td>
    <td>${escapeHTML(valueOf(record, "lot_no", "lotNo", "supplier_lot_no", "supplierLotNo"))}</td>
    <td>${escapeHTML(valueOf(record, "location", "receiving_location", "receivingLocation"))}</td>
    <td>${escapeHTML(valueOf(record, "available_quantity", "availableQuantity", "quantity", "current_stock", "currentStock"))}</td>
    <td>${escapeHTML(valueOf(record, "unit", "quantity_unit", "quantityUnit"))}</td>
    <td>${escapeHTML(dateText(record))}</td>
  </tr>`).join("") : emptyRow(6);
}

function updateLocationOptions() {
  const locations = new Set([...state.inward, ...state.grn, ...state.stock]
    .map((record) => valueOf(record, "receiving_location", "receivingLocation", "location"))
    .filter(Boolean));
  const selected = state.filters.location;
  elements.location.innerHTML = `<option value="">All locations</option>${[...locations].sort().map((location) => `<option value="${escapeHTML(location.toLowerCase())}">${escapeHTML(location)}</option>`).join("")}`;
  elements.location.value = selected;
}

function render() {
  renderStats();
  updateLocationOptions();
  renderRecent();
  renderFinalized();
  renderStock();
}

function listenToCollection(name) {
  return onSnapshot(collection(db, name), (snapshot) => {
    state[name] = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    render();
  }, (error) => {
    console.error(`Unable to load ${name} records.`, error);
    dashboardStatus.textContent = "Unable to load records.";
    dashboardStatus.style.color = "var(--danger)";
    state[name] = [];
    render();
  });
}

["inward", "kanta", "grn", "stock", "outward"].forEach(listenToCollection);

["search", "status", "location", "date"].forEach((filter) => {
  elements[filter].addEventListener("input", (event) => {
    state.filters[filter] = event.target.value.trim().toLowerCase();
    renderRecent();
    renderFinalized();
    renderStock();
  });
});

render();
