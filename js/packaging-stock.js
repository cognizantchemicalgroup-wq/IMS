import { db } from "./firebase-config.js";
import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let stockRecords = [];

const stockRows = document.querySelector("#stockRows");
const tableWrap = document.querySelector("#tableWrap");
const loadingState = document.querySelector("#loadingState");
const emptyState = document.querySelector("#emptyState");
const customerFilter = document.querySelector("#customerFilter");
const materialSearch = document.querySelector("#materialSearch");
const statusFilter = document.querySelector("#statusFilter");
const unitFilter = document.querySelector("#unitFilter");
const customerHeading = document.querySelector("#customerHeading");
const resultCount = document.querySelector("#resultCount");
const stockDrawer = document.querySelector("#stockDrawer");
const drawerOverlay = document.querySelector("#drawerOverlay");

function valueOf(record, ...keys) {
  for (const key of keys) if (record?.[key] !== undefined && record[key] !== null && record[key] !== "") return record[key];
  return "";
}

function stockNumber(value, fallback = 0) {
  if (value === "" || value === null || value === undefined) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function updatedText(value) {
  if (!value) return "—";
  const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function normalizeStockDocument(document) {
  const received = stockNumber(valueOf(document, "received_quantity", "receivedQuantity"));
  const consumed = stockNumber(valueOf(document, "consumed_quantity", "consumedQuantity"));
  const availableValue = valueOf(document, "available_quantity", "availableQuantity", "current_stock", "currentStock");
  const available = availableValue === "" ? received - consumed : stockNumber(availableValue, Number.NaN);
  const record = {
    id: document.id,
    customer: String(valueOf(document, "customer_name", "customerName", "customer")).trim(),
    material: String(valueOf(document, "material_name", "materialName", "material")).trim(),
    received,
    consumed,
    available,
    unit: String(valueOf(document, "unit", "quantity_unit", "quantityUnit")).trim(),
    updated: updatedText(valueOf(document, "updated_at", "updatedAt"))
  };
  return record.customer && record.material && record.unit && Number.isFinite(record.available) && record.available >= 0
    ? record
    : null;
}

function getStatus(record) {
  if (record.available <= 0) return "Out of Stock";
  if (record.available <= 10) return "Low Stock";
  return "In Stock";
}

function statusClass(status) {
  return status.toLowerCase().replaceAll(" ", "-");
}

function escapeHTML(value) {
  return String(value ?? "—").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function renderCustomerOptions() {
  const selected = customerFilter.value;
  const customers = [...new Set(stockRecords.map((record) => record.customer))].sort((first, second) => first.localeCompare(second));
  customerFilter.replaceChildren(new Option("All Customers", ""), ...customers.map((customer) => new Option(customer, customer)));
  customerFilter.value = customers.includes(selected) ? selected : "";
}

function updateSummary(records) {
  document.querySelector("#totalMaterials").textContent = String(records.length);
  [["received", "#totalReceived"], ["consumed", "#totalConsumed"], ["available", "#totalAvailable"]].forEach(([field, selector]) => {
    const totals = new Map();
    records.forEach((record) => totals.set(record.unit, (totals.get(record.unit) || 0) + record[field]));
    const element = document.querySelector(selector);
    const children = [];
    [...totals].forEach(([unit, quantity], index) => {
      if (index) {
        const separator = document.createElement("span");
        separator.className = "stat-unit-separator";
        separator.textContent = "·";
        children.push(separator);
      }
      const total = document.createElement("span");
      total.className = "stat-unit-total";
      total.textContent = `${quantity} ${unit}`;
      children.push(total);
    });
    element.replaceChildren(...children);
    if (!totals.size) element.textContent = "—";
  });
}

function renderStock() {
  const customer = customerFilter.value;
  const search = materialSearch.value.trim().toLowerCase();
  const status = statusFilter.value;
  const unit = unitFilter.value;
  const customerRecords = stockRecords.filter((record) => !customer || record.customer === customer);
  const filtered = stockRecords.filter((record) => {
    return (!customer || record.customer === customer)
      && record.material.toLowerCase().includes(search)
      && (!status || getStatus(record) === status)
      && (!unit || record.unit === unit);
  });

  customerHeading.textContent = customer || "All customers";
  updateSummary(customerRecords);
  document.querySelector("#tableDescription").textContent = customer
    ? `Packaging materials recorded for ${customer}`
    : "Customer-level packaging stock from saved receipts";
  stockRows.replaceChildren(...filtered.map((record) => {
    const row = document.createElement("tr");
    const currentStatus = getStatus(record);
    [record.customer, record.material, String(record.received), String(record.consumed), String(record.available), record.unit].forEach((value, index) => {
      const cell = document.createElement("td");
      cell.textContent = value;
      if (index === 1) cell.className = "product-name";
      if (index === 2 || index === 4) cell.classList.add("stock-number");
      row.append(cell);
    });
    const statusCell = document.createElement("td");
    const statusBadge = document.createElement("span");
    statusBadge.className = `status-badge status-${statusClass(currentStatus)}`;
    statusBadge.textContent = currentStatus;
    statusCell.append(statusBadge);
    row.append(statusCell);
    const actionCell = document.createElement("td");
    const viewButton = document.createElement("button");
    viewButton.className = "view-button";
    viewButton.type = "button";
    viewButton.textContent = "View";
    viewButton.addEventListener("click", () => openDetails(record));
    actionCell.append(viewButton);
    row.append(actionCell);
    return row;
  }));

  loadingState.hidden = true;
  tableWrap.hidden = filtered.length === 0;
  emptyState.hidden = filtered.length !== 0;
  resultCount.textContent = `${filtered.length} ${filtered.length === 1 ? "record" : "records"}`;

  const emptyTitle = document.querySelector("#emptyTitle");
  const emptyMessage = document.querySelector("#emptyMessage");
  if (search || status || unit) {
    emptyTitle.textContent = "No search results found.";
    emptyMessage.textContent = "Try changing your search or filters.";
  } else if (customer) {
    emptyTitle.textContent = "No packaging stock available.";
    emptyMessage.textContent = `There are no packaging materials recorded for ${customer}.`;
  } else {
    emptyTitle.textContent = "No customer packaging stock found.";
    emptyMessage.textContent = "Saved packaging receipts will appear here.";
  }
}

function openDetails(record) {
  const status = getStatus(record);
  document.querySelector("#drawerTitle").textContent = record.material;
  document.querySelector("#drawerContent").innerHTML = `
    <section class="detail-card"><div class="detail-grid">
      <div><span class="detail-label">Customer</span><span class="detail-value">${escapeHTML(record.customer)}</span></div>
      <div><span class="detail-label">Packaging Material</span><span class="detail-value">${escapeHTML(record.material)}</span></div>
      <div><span class="detail-label">Total Received</span><span class="detail-value">${escapeHTML(`${record.received} ${record.unit}`)}</span></div>
      <div><span class="detail-label">Total Consumed</span><span class="detail-value">${escapeHTML(`${record.consumed} ${record.unit}`)}</span></div>
      <div><span class="detail-label">Available Stock</span><span class="detail-value">${escapeHTML(`${record.available} ${record.unit}`)}</span></div>
      <div><span class="detail-label">Unit</span><span class="detail-value">${escapeHTML(record.unit)}</span></div>
      <div><span class="detail-label">Current Status</span><span class="status-badge status-${statusClass(status)}">${status}</span></div>
      <div><span class="detail-label">Last Updated</span><span class="detail-value">${escapeHTML(record.updated)}</span></div>
    </div></section>
    <section class="detail-card movement-detail-card"><h3>Recent Movements</h3><div class="movement-detail-grid">
      <div><span class="detail-label">Received</span><span class="detail-value">${escapeHTML(`+${record.received} ${record.unit}`)}</span></div>
      <div><span class="detail-label">Consumed</span><span class="detail-value">${escapeHTML(`-${record.consumed} ${record.unit}`)}</span></div>
      <div><span class="detail-label">Balance</span><span class="detail-value">${escapeHTML(`${record.available} ${record.unit}`)}</span></div>
    </div></section>`;
  stockDrawer.classList.add("open");
  stockDrawer.setAttribute("aria-hidden", "false");
  drawerOverlay.classList.add("active");
  document.querySelector("#closeDrawerIcon").focus();
}

function closeDetails() {
  stockDrawer.classList.remove("open");
  stockDrawer.setAttribute("aria-hidden", "true");
  drawerOverlay.classList.remove("active");
}

[customerFilter, statusFilter, unitFilter].forEach((control) => control.addEventListener("change", renderStock));
materialSearch.addEventListener("input", renderStock);
document.querySelector("#resetFilters").addEventListener("click", () => {
  customerFilter.value = "";
  materialSearch.value = "";
  statusFilter.value = "";
  unitFilter.value = "";
  renderStock();
});
document.querySelector("#closeDrawer").addEventListener("click", closeDetails);
document.querySelector("#closeDrawerIcon").addEventListener("click", closeDetails);
drawerOverlay.addEventListener("click", closeDetails);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDetails();
});

function showStockLoadError(error) {
  console.error("Unable to load packaging stock.", error);
  loadingState.hidden = true;
  tableWrap.hidden = true;
  emptyState.hidden = false;
  document.querySelector("#emptyTitle").textContent = "Packaging stock could not be loaded.";
  document.querySelector("#emptyMessage").textContent = "Check your connection and access, then refresh.";
  resultCount.textContent = "Unable to load records";
}

async function connectPackagingStock() {
  try {
    onSnapshot(collection(db, "packaging_stock"), (snapshot) => {
      stockRecords = snapshot.docs.map((item) => normalizeStockDocument({ id: item.id, ...item.data() })).filter(Boolean);
      renderCustomerOptions();
      renderStock();
    }, showStockLoadError);
  } catch (error) {
    showStockLoadError(error);
  }
}

const sidebar = document.querySelector("#sidebar");
const mobileMenuToggle = document.querySelector("#mobileMenuToggle");
mobileMenuToggle.addEventListener("click", () => {
  const open = sidebar.classList.toggle("open");
  mobileMenuToggle.setAttribute("aria-expanded", String(open));
  mobileMenuToggle.setAttribute("aria-label", open ? "Close navigation menu" : "Open navigation menu");
});

connectPackagingStock();