import { db } from "./firebase-config.js";
import { initDocumentPreview } from "./document-preview.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const PAGE_SIZE = 25;
const VALID_LOCATIONS = ["Warehouse A", "Warehouse B", "Plant Store"];
const records = [];
const body = document.getElementById("acceptedBody");
const searchInput = document.getElementById("acceptedSearch");
const fromDate = document.getElementById("fromDate");
const toDate = document.getElementById("toDate");
const productFilter = document.getElementById("productFilter");
const supplierFilter = document.getElementById("supplierFilter");
const locationFilter = document.getElementById("locationFilter");
const statusFilter = document.getElementById("statusFilter");
const emptyState = document.getElementById("emptyState");
const pageStatus = document.getElementById("pageStatus");
const loadMoreButton = document.getElementById("loadMore");
const detailsDrawer = document.getElementById("detailsDrawer");
initDocumentPreview();
const drawerBackdrop = document.getElementById("drawerBackdrop");
let lastDocument = null;
let hasMore = true;
let loading = false;
let filterExpansionTimer = null;

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
    if (record?.[key] !== undefined && record[key] !== null && record[key] !== "") return record[key];
  }
  return "";
}

function dateValue(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (typeof value === "object" && Number.isFinite(value.seconds)) return new Date(value.seconds * 1000);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function finalizedDate(record) {
  return dateValue(valueOf(record, "finalizedAt", "finalized_at", "createdAt", "created_at"));
}

function dateText(value, withTime = false) {
  const date = dateValue(value);
  return date ? date.toLocaleString([], withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" }) : "—";
}

function normalized(value) {
  return String(value ?? "").trim().toLowerCase();
}

function grnNumber(record) {
  return valueOf(record, "grnNumber", "grn_number", "grnNo", "grn_no") || record.id;
}

function rowProduct(record) {
  return valueOf(record, "product", "product_name") || valueOf(record.inward || {}, "product", "product_name");
}

function rowSupplier(record) {
  return valueOf(record, "supplier", "supplier_name") || valueOf(record.inward || {}, "supplier", "supplier_name");
}

function rowLocation(record) {
  return valueOf(record, "receivingLocation", "receiving_location", "location")
    || valueOf(record.inward || {}, "receivingLocation", "receiving_location", "location");
}

function rowUnit(record) {
  return valueOf(record, "unit", "quantityUnit", "quantity_unit")
    || valueOf(record.inward || {}, "unit", "quantityUnit", "quantity_unit");
}

function rowReceived(record) {
  return valueOf(record.kanta || {}, "receivedQty", "received_quantity", "receivedQuantity", "netWeight", "net_weight");
}

function quantityText(quantity, unit) {
  if (quantity === "") return "—";
  const value = String(quantity);
  return unit && !value.toLowerCase().includes(String(unit).toLowerCase()) ? `${value} ${unit}` : value;
}

function matchesFilters(record) {
  const inward = record.inward || {};
  const search = normalized(searchInput.value);
  const searchText = [
    grnNumber(record),
    valueOf(inward, "invoiceChallanNo", "invoice_challan_no", "invoice_no", "challan_no"),
    valueOf(inward, "purchaseOrder", "purchase_order", "poNumber", "po_number"),
    rowProduct(record),
    rowSupplier(record),
    rowLocation(record)
  ].join(" ").toLowerCase();
  const date = finalizedDate(record);
  const dateKey = date ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10) : "";
  return (!search || searchText.includes(search))
    && (!fromDate.value || (dateKey && dateKey >= fromDate.value))
    && (!toDate.value || (dateKey && dateKey <= toDate.value))
    && (!productFilter.value || rowProduct(record) === productFilter.value)
    && (!supplierFilter.value || rowSupplier(record) === supplierFilter.value)
    && (!locationFilter.value || rowLocation(record) === locationFilter.value)
    && (!statusFilter.value || valueOf(record, "status") === statusFilter.value);
}

function renderFilterOptions() {
  const selectedProduct = productFilter.value;
  const selectedSupplier = supplierFilter.value;
  const products = [...new Set(records.map(rowProduct).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const suppliers = [...new Set(records.map(rowSupplier).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  productFilter.innerHTML = `<option value="">All Products</option>${products.map((item) => `<option value="${escapeHTML(item)}">${escapeHTML(item)}</option>`).join("")}`;
  supplierFilter.innerHTML = `<option value="">All Suppliers</option>${suppliers.map((item) => `<option value="${escapeHTML(item)}">${escapeHTML(item)}</option>`).join("")}`;
  productFilter.value = products.includes(selectedProduct) ? selectedProduct : "";
  supplierFilter.value = suppliers.includes(selectedSupplier) ? selectedSupplier : "";
  locationFilter.innerHTML = `<option value="">All Locations</option>${VALID_LOCATIONS.map((item) => `<option value="${item}">${item}</option>`).join("")}`;
}

function renderTable() {
  const filtered = records.filter(matchesFilters);
  document.getElementById("acceptedCount").textContent = `${filtered.length} ${filtered.length === 1 ? "record" : "records"}`;
  body.innerHTML = filtered.map((record) => {
    const inward = record.inward || {};
    const quantity = rowReceived(record);
    const unit = rowUnit(record);
    const note = valueOf(record, "note", "notes") || "N/A";
    return `<tr>
      <td>${escapeHTML(grnNumber(record))}</td>
      <td>${escapeHTML(dateText(finalizedDate(record), true))}</td>
      <td>${escapeHTML(valueOf(inward, "invoiceChallanNo", "invoice_challan_no", "invoice_no", "challan_no") || "—")}</td>
      <td>${escapeHTML(valueOf(inward, "purchaseOrder", "purchase_order", "poNumber", "po_number") || "—")}</td>
      <td>${escapeHTML(rowProduct(record) || "—")}</td>
      <td>${escapeHTML(rowSupplier(record) || "—")}</td>
      <td>${escapeHTML(rowLocation(record) || "—")}</td>
      <td>${escapeHTML(quantity === "" ? "—" : quantity)}</td>
      <td>${escapeHTML(unit || "—")}</td>
      <td><span class="status-tag">${escapeHTML(valueOf(record, "status") || "—")}</span></td>
      <td><span class="note-cell" title="${escapeHTML(note)}">${escapeHTML(note)}</span></td>
      <td><button class="row-action" type="button" data-view-id="${escapeHTML(record.id)}">View</button></td>
    </tr>`;
  }).join("");
  emptyState.hidden = filtered.length > 0;
  if (!filtered.length) body.innerHTML = "";
  loadMoreButton.hidden = !hasMore;
  pageStatus.textContent = `Loaded ${records.length} finalized GRN${records.length === 1 ? "" : "s"}`;
}

async function enrichSourceRecords(grns) {
  return Promise.all(grns.map(async (grn) => {
    const inwardId = valueOf(grn, "inwardId", "inward_id");
    const kantaId = valueOf(grn, "kantaId", "kanta_id");
    try {
      const [inwardSnapshot, kantaSnapshot] = await Promise.all([
        inwardId ? getDoc(doc(db, "inward", inwardId)) : Promise.resolve(null),
        kantaId ? getDoc(doc(db, "kanta", kantaId)) : Promise.resolve(null)
      ]);
      return {
        ...grn,
        inward: inwardSnapshot?.exists() ? inwardSnapshot.data() : {},
        kanta: kantaSnapshot?.exists() ? kantaSnapshot.data() : {}
      };
    } catch (error) {
      console.error(`Unable to load source records for GRN ${grn.id}.`, error);
      return { ...grn, inward: {}, kanta: {} };
    }
  }));
}

async function loadNextPage() {
  if (loading || !hasMore) return;
  loading = true;
  loadMoreButton.disabled = true;
  loadMoreButton.textContent = "Loading...";
  try {
    const constraints = [
      collection(db, "grn"),
      orderBy("finalizedAt", "desc"),
      limit(PAGE_SIZE)
    ];
    if (lastDocument) constraints.push(startAfter(lastDocument));
    const snapshot = await getDocs(query(...constraints));
    const finalizedPage = snapshot.docs
      .map((item) => ({ id: item.id, ...item.data() }))
      .filter((item) => String(valueOf(item, "status")).toUpperCase() === "GRN FINALIZED");
    const pageRecords = await enrichSourceRecords(finalizedPage);
    records.push(...pageRecords);
    lastDocument = snapshot.docs.at(-1) || lastDocument;
    hasMore = snapshot.size === PAGE_SIZE;
    renderFilterOptions();
    renderTable();
  } catch (error) {
    console.error("Unable to load accepted GRN history.", error);
    pageStatus.textContent = "Accepted GRN history could not be loaded. Please refresh and try again.";
    body.innerHTML = `<tr><td colspan="12" class="empty-state">Unable to load accepted GRNs.</td></tr>`;
    loadMoreButton.hidden = true;
    hasMore = false;
  } finally {
    loading = false;
    loadMoreButton.disabled = false;
    loadMoreButton.textContent = "Load More";
  }
}

async function expandHistoryForActiveFilters() {
  if (loading) {
    filterExpansionTimer = setTimeout(expandHistoryForActiveFilters, 100);
    return;
  }
  const hasActiveFilters = searchInput.value.trim() || fromDate.value || toDate.value
    || productFilter.value || supplierFilter.value || locationFilter.value || statusFilter.value;
  if (!hasActiveFilters || !hasMore) return;
  await loadNextPage();
  if (hasMore) await expandHistoryForActiveFilters();
}

function documentLink(url, title = "Document") {
  return url
    ? `<button class="row-action" type="button" data-preview-url="${escapeHTML(url)}" data-preview-title="${escapeHTML(title)}">Open</button>`
    : "Not available";
}

async function showDetails(record) {
  document.getElementById("detailsTitle").textContent = grnNumber(record);
  const body = document.getElementById("detailsBody");
  body.innerHTML = `<section class="drawer-section"><h3>Loading GRN details...</h3></section>`;
  detailsDrawer.classList.add("open");
  detailsDrawer.setAttribute("aria-hidden", "false");
  drawerBackdrop.classList.add("show");
  try {
    const enriched = (record.inward && record.kanta) ? record : (await enrichSourceRecords([record]))[0];
    const inward = enriched.inward || {};
    const kanta = enriched.kanta || {};
    const unit = rowUnit(enriched);
    const declaredQty = valueOf(kanta, "declaredQuantity", "declared_quantity") || valueOf(inward, "declaredQuantity", "declared_quantity", "quantity");
    const receivedQty = rowReceived(enriched);
    const note = valueOf(enriched, "note", "notes") || "N/A";
    const detail = (label, value) => `<div><span>${label}</span><strong>${escapeHTML(value || "—")}</strong></div>`;
    const linkedDoc = (label, source, ...keys) => `<div><span>${label}</span><strong>${documentLink(valueOf(source, ...keys), label)}</strong></div>`;
    body.innerHTML = `
      <section class="drawer-section"><h3>GRN Details</h3><div class="detail-grid">
        ${detail("GRN Number", grnNumber(enriched))}
        ${detail("GRN Date", dateText(valueOf(enriched, "createdAt", "created_at") || valueOf(inward, "createdAt", "created_at") || valueOf(enriched, "finalizedAt", "finalized_at"), true))}
        ${detail("Finalized Date/Time", dateText(finalizedDate(enriched), true))}
        ${detail("Invoice Number", valueOf(inward, "invoiceChallanNo", "invoice_challan_no", "invoice_no", "challan_no"))}
        ${detail("PO Number", valueOf(inward, "purchaseOrder", "purchase_order", "poNumber", "po_number"))}
        ${detail("Product", rowProduct(enriched))}
        ${detail("Supplier", rowSupplier(enriched))}
        ${detail("Receiving Location", rowLocation(enriched))}
        ${detail("Kanta Declared Qty", quantityText(declaredQty, unit))}
        ${detail("Kanta Received Qty", quantityText(receivedQty, unit))}
        ${detail("Unit", unit)}
        ${detail("Status", valueOf(enriched, "status"))}
        ${detail("Notes", note)}
        ${detail("Inward ID", valueOf(enriched, "inwardId", "inward_id"))}
        ${detail("Kanta ID", valueOf(enriched, "kantaId", "kanta_id"))}
      </div></section>
      <section class="drawer-section"><h3>Documents</h3><div class="detail-grid">
        ${linkedDoc("COA", inward, "coaFileUrl", "coa_file_url", "supplier_coa_path")}
        ${linkedDoc("Invoice", inward, "invoiceFileUrl", "invoice_file_url", "invoiceFilePath", "invoice_file_path")}
        ${linkedDoc("Purchase Order", inward, "poFileUrl", "po_file_url", "purchase_order_file_url")}
        ${linkedDoc("Kanta Slip", kanta, "kantaSlipUrl", "kanta_slip_url")}
      </div></section>`;
  } catch (error) {
    console.error("Unable to show accepted GRN details.", error);
    body.innerHTML = `<section class="drawer-section"><h3>GRN details could not be loaded.</h3></section>`;
  }
}

body.addEventListener("click", (event) => {
  const button = event.target.closest("[data-view-id]");
  const record = records.find((item) => item.id === button?.dataset.viewId);
  if (record) showDetails(record);
});

[searchInput, fromDate, toDate, productFilter, supplierFilter, locationFilter, statusFilter].forEach((control) => {
  const eventName = control === searchInput ? "input" : "change";
  control.addEventListener(eventName, () => {
    renderTable();
    clearTimeout(filterExpansionTimer);
    filterExpansionTimer = setTimeout(async () => {
      await expandHistoryForActiveFilters();
    }, control === searchInput ? 250 : 0);
  });
});

document.getElementById("resetFilters").addEventListener("click", () => {
  searchInput.value = "";
  fromDate.value = "";
  toDate.value = "";
  productFilter.value = "";
  supplierFilter.value = "";
  locationFilter.value = "";
  statusFilter.value = "";
  renderTable();
});

loadMoreButton.addEventListener("click", loadNextPage);
document.getElementById("closeDrawer").addEventListener("click", () => {
  detailsDrawer.classList.remove("open");
  detailsDrawer.setAttribute("aria-hidden", "true");
  drawerBackdrop.classList.remove("show");
});
drawerBackdrop.addEventListener("click", () => {
  detailsDrawer.classList.remove("open");
  detailsDrawer.setAttribute("aria-hidden", "true");
  drawerBackdrop.classList.remove("show");
});

const sidebar = document.getElementById("sidebar");
const mobileOverlay = document.getElementById("mobileOverlay");
const mobileMenuToggle = document.getElementById("mobileMenuToggle");
mobileMenuToggle.addEventListener("click", () => {
  const isOpen = sidebar.classList.toggle("open");
  mobileOverlay.classList.toggle("active", isOpen);
  mobileMenuToggle.setAttribute("aria-expanded", String(isOpen));
  mobileMenuToggle.setAttribute("aria-label", isOpen ? "Close navigation menu" : "Open navigation menu");
});
mobileOverlay.addEventListener("click", () => {
  sidebar.classList.remove("open");
  mobileOverlay.classList.remove("active");
  mobileMenuToggle.setAttribute("aria-expanded", "false");
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  detailsDrawer.classList.remove("open");
  detailsDrawer.setAttribute("aria-hidden", "true");
  drawerBackdrop.classList.remove("show");
  sidebar.classList.remove("open");
  mobileOverlay.classList.remove("active");
  mobileMenuToggle.setAttribute("aria-expanded", "false");
});

loadNextPage();
