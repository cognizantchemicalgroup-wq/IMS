import { db } from "./firebase-config.js";
import {
  collection,
  getDocs,
  onSnapshot,
  query,
  where
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const LOW_STOCK_THRESHOLD = 50;
const VALID_LOCATIONS = ["Warehouse A", "Warehouse B", "Plant Store"];
const LOCATION_CARD_ORDER = ["Plant Store", "Warehouse A", "Warehouse B"];
const stockRecords = [];
const searchInput = document.getElementById("inventorySearch");
const locationFilter = document.getElementById("locationFilter");
const unitFilter = document.getElementById("unitFilter");
const statusFilter = document.getElementById("statusFilter");
const tableBody = document.getElementById("inventoryTableBody");
const tableScroll = document.getElementById("tableScroll");
const emptyState = document.getElementById("emptyState");
const recordCount = document.getElementById("recordCount");
const inventoryConnection = document.getElementById("inventoryConnection");
const locationGrid = document.getElementById("locationGrid");
const drawer = document.getElementById("stockDrawer");
const overlay = document.getElementById("overlay");
const sidebar = document.getElementById("sidebar");
const menuToggle = document.getElementById("mobileMenuToggle");
let previousFocus = null;
let ledgerLoadToken = 0;

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
    if (record[key] !== undefined && record[key] !== null && record[key] !== "") return record[key];
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

function dateText(value) {
  const date = dateValue(value);
  return date ? date.toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" }) : "—";
}

function normalized(value) {
  return String(value ?? "").trim().normalize("NFKC").toLowerCase();
}

function stockStatus(record) {
  if (!Number.isFinite(record.currentStock) || record.currentStock <= 0) return "Out of Stock";
  const rawThreshold = valueOf(record, "low_stock_threshold", "lowStockThreshold");
  const storedThreshold = rawThreshold === "" ? Number.NaN : Number(rawThreshold);
  const threshold = Number.isFinite(storedThreshold) && storedThreshold >= 0 ? storedThreshold : LOW_STOCK_THRESHOLD;
  return record.currentStock <= threshold ? "Low Stock" : "In Stock";
}

function statusClass(status) {
  if (status === "Low Stock") return "status-low-stock";
  if (status === "Out of Stock") return "status-out-of-stock";
  return "status-in-stock";
}

function formatNumber(value) {
  return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 3 }) : "—";
}

function productKey(record) {
  return String(record.productId || normalized(record.productName));
}

function renderSummary() {
  const products = new Set(stockRecords.map(productKey));
  const locations = new Set(stockRecords.map((record) => normalized(record.location)).filter(Boolean));
  const totalStock = stockRecords.reduce((sum, record) => sum + (Number.isFinite(record.currentStock) ? record.currentStock : 0), 0);
  const lowStockCount = stockRecords.filter((record) => stockStatus(record) === "Low Stock").length;
  document.getElementById("totalProducts").textContent = products.size.toLocaleString();
  document.getElementById("totalStock").textContent = formatNumber(totalStock);
  document.getElementById("totalLocations").textContent = locations.size.toLocaleString();
  document.getElementById("lowStockItems").textContent = lowStockCount.toLocaleString();
}

function renderFilters() {
  const selectedLocation = locationFilter.value;
  locationFilter.innerHTML = `<option value="">All Locations</option>${VALID_LOCATIONS.map((location) => `<option value="${escapeHTML(location)}">${escapeHTML(location)}</option>`).join("")}`;
  locationFilter.value = VALID_LOCATIONS.includes(selectedLocation) ? selectedLocation : "";

  const selectedUnit = unitFilter.value;
  const units = [...new Set(stockRecords.map((record) => record.unit).filter(Boolean))]
    .sort((first, second) => first.localeCompare(second));
  unitFilter.innerHTML = `<option value="">All Units</option>${units.map((unit) => `<option value="${escapeHTML(unit)}">${escapeHTML(unit)}</option>`).join("")}`;
  unitFilter.value = units.includes(selectedUnit) ? selectedUnit : "";
}

function renderLocations() {
  locationGrid.innerHTML = LOCATION_CARD_ORDER.map((location) => {
    const records = stockRecords.filter((record) => normalized(record.location) === normalized(location));
    const products = new Set(records.map(productKey));
    const quantityByUnit = new Map();
    records.forEach((record) => {
      const unit = record.unit || "Unspecified";
      quantityByUnit.set(unit, (quantityByUnit.get(unit) || 0) + (Number.isFinite(record.currentStock) ? record.currentStock : 0));
    });
    const totalText = quantityByUnit.size
      ? [...quantityByUnit].map(([unit, quantity]) => `${formatNumber(quantity)} ${unit}`).join(" · ")
      : "0 stock";
    const icon = location.toLowerCase().includes("plant") ? "fa-industry" : "fa-warehouse";
    return `<button class="location-card" type="button" data-location="${escapeHTML(location)}" aria-label="Filter inventory by ${escapeHTML(location)}">
      <span class="location-card-top"><i class="fa-solid ${icon}"></i><i class="fa-solid fa-arrow-up-right-from-square"></i></span>
      <span class="location-name">${escapeHTML(location)}</span>
      <span class="location-meta"><span>${products.size} ${products.size === 1 ? "Product" : "Products"}</span><span>Total stock</span></span>
      <span class="location-total">${escapeHTML(totalText)}</span>
    </button>`;
  }).join("");
}

function renderTable() {
  const search = normalized(searchInput.value);
  const records = stockRecords.filter((record) => {
    const matchesSearch = !search || normalized(`${record.productName} ${record.location}`).includes(search);
    return matchesSearch
      && (!locationFilter.value || record.location === locationFilter.value)
      && (!unitFilter.value || record.unit === unitFilter.value)
      && (!statusFilter.value || stockStatus(record) === statusFilter.value);
  });

  tableBody.innerHTML = records.map((record) => {
    const status = stockStatus(record);
    return `<tr>
      <td><span class="product-name">${escapeHTML(record.productName || "—")}</span></td>
      <td>${escapeHTML(record.location || "—")}</td>
      <td><span class="stock-number">${formatNumber(record.currentStock)}</span></td>
      <td>${escapeHTML(record.unit || "—")}</td>
      <td><span class="status-badge ${statusClass(status)}">${status}</span></td>
      <td>${escapeHTML(dateText(record.updatedAt || record.createdAt))}</td>
      <td><button class="view-button" type="button" data-stock-id="${escapeHTML(record.id)}" aria-label="View ${escapeHTML(record.productName)} at ${escapeHTML(record.location)}">View</button></td>
    </tr>`;
  }).join("");

  const hasRecords = records.length > 0;
  tableScroll.hidden = !hasRecords;
  emptyState.hidden = hasRecords;
  if (!hasRecords) {
    emptyState.querySelector("h3").textContent = "No inventory records found";
    emptyState.querySelector("p").textContent = "Try changing your search or filters.";
  }
  recordCount.textContent = `${records.length} ${records.length === 1 ? "record" : "records"}`;
}

function renderAll() {
  renderSummary();
  renderFilters();
  renderLocations();
  renderTable();
}

function setText(id, value) {
  document.getElementById(id).textContent = value;
}

function openDrawer(record) {
  previousFocus = document.activeElement;
  setText("drawerTitle", record.productName || "Stock details");
  setText("detailProduct", record.productName || "—");
  setText("detailLocation", record.location || "—");
  setText("detailStock", `${formatNumber(record.currentStock)} ${record.unit || ""}`.trim());
  setText("detailUnit", record.unit || "—");
  setText("detailCreated", dateText(record.createdAt));
  setText("detailUpdated", dateText(record.updatedAt));
  setText("detailLastGrn", record.lastGrnId || "—");
  setText("summaryReceived", `${formatNumber(record.totalReceived)} ${record.unit || ""}`.trim());
  setText("summaryIssued", `${formatNumber(record.totalIssued)} ${record.unit || ""}`.trim());
  setText("summaryCurrent", `${formatNumber(record.currentStock)} ${record.unit || ""}`.trim());
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  overlay.classList.add("active");
  overlay.classList.remove("nav-active");
  document.body.style.overflow = "hidden";
  document.getElementById("closeDrawer").focus();
  loadStockMovements(record);
}

async function loadStockMovements(record) {
  const requestToken = ++ledgerLoadToken;
  const movementList = document.getElementById("movementList");
  movementList.innerHTML = `<li class="movement-item">Loading stock movements...</li>`;
  const productField = record.productId ? "product_id" : "product_name";
  const productValue = record.productId || record.productName;
  try {
    const ledgerQuery = query(collection(db, "stockLedger"), where(productField, "==", productValue));
    const snapshot = await getDocs(ledgerQuery);
    if (requestToken !== ledgerLoadToken) return;
    const movements = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
      .filter((item) => {
        const ledgerLocationId = valueOf(item, "location_id", "locationId");
        const matchesLocation = ledgerLocationId && record.locationId
          ? String(ledgerLocationId) === String(record.locationId)
          : normalized(valueOf(item, "location", "receiving_location")) === normalized(record.location);
        return matchesLocation && normalized(valueOf(item, "unit")) === normalized(record.unit);
      })
      .sort((first, second) => (dateValue(valueOf(second, "created_at", "createdAt"))?.getTime() || 0)
        - (dateValue(valueOf(first, "created_at", "createdAt"))?.getTime() || 0));

    movementList.innerHTML = movements.length ? movements.map((movement) => {
      const type = String(valueOf(movement, "transaction_type", "transactionType") || "IN").toUpperCase();
      const quantity = Number(valueOf(movement, "quantity"));
      const sign = type === "OUT" ? "−" : "+";
      const reference = valueOf(movement, "reference_id", "grn_id", "referenceId", "grnId") || "—";
      return `<li class="movement-item">
        <span><span class="movement-date">${escapeHTML(dateText(valueOf(movement, "created_at", "createdAt")))}</span><span class="movement-ref">${escapeHTML(reference)}</span></span>
        <span class="movement-qty">${escapeHTML(`${sign}${formatNumber(Math.abs(quantity))} ${record.unit || ""}`.trim())}<span class="movement-type">${escapeHTML(type)}</span></span>
      </li>`;
    }).join("") : `<li class="movement-item">No stock movements found.</li>`;
  } catch (error) {
    console.error("Unable to load stock movements.", error);
    if (requestToken === ledgerLoadToken) movementList.innerHTML = `<li class="movement-item">Stock movements could not be loaded.</li>`;
  }
}

function closeDrawer() {
  ledgerLoadToken += 1;
  drawer.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
  overlay.classList.remove("active");
  document.body.style.overflow = "";
  if (previousFocus && typeof previousFocus.focus === "function") previousFocus.focus();
}

function closeMobileMenu() {
  sidebar.classList.remove("open");
  menuToggle.setAttribute("aria-expanded", "false");
  menuToggle.setAttribute("aria-label", "Open navigation menu");
  overlay.classList.remove("active", "nav-active");
}

[searchInput, locationFilter, unitFilter, statusFilter].forEach((control) => {
  control.addEventListener(control === searchInput ? "input" : "change", renderTable);
});

document.getElementById("resetFilters").addEventListener("click", () => {
  searchInput.value = "";
  locationFilter.value = "";
  unitFilter.value = "";
  statusFilter.value = "";
  renderTable();
  searchInput.focus();
});

locationGrid.addEventListener("click", (event) => {
  const card = event.target.closest("[data-location]");
  if (!card) return;
  locationFilter.value = card.dataset.location;
  renderTable();
  document.getElementById("registerHeading").scrollIntoView({ behavior: "smooth", block: "start" });
});

tableBody.addEventListener("click", (event) => {
  const viewButton = event.target.closest("[data-stock-id]");
  if (!viewButton) return;
  const record = stockRecords.find((item) => item.id === viewButton.dataset.stockId);
  if (record) openDrawer(record);
});

document.getElementById("closeDrawer").addEventListener("click", closeDrawer);
overlay.addEventListener("click", () => {
  if (drawer.classList.contains("open")) closeDrawer();
  if (sidebar.classList.contains("open")) closeMobileMenu();
});

menuToggle.addEventListener("click", () => {
  const isOpen = sidebar.classList.toggle("open");
  menuToggle.setAttribute("aria-expanded", String(isOpen));
  menuToggle.setAttribute("aria-label", isOpen ? "Close navigation menu" : "Open navigation menu");
  overlay.classList.toggle("active", isOpen);
  overlay.classList.toggle("nav-active", isOpen);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (drawer.classList.contains("open")) closeDrawer();
    if (sidebar.classList.contains("open")) closeMobileMenu();
  }
});

onSnapshot(collection(db, "stock"), (snapshot) => {
  const loadedRecords = snapshot.docs.map((item) => {
    const data = item.data();
    const stockValue = valueOf(data, "current_stock", "currentStock", "available_quantity", "availableQuantity", "quantity");
    const currentStock = stockValue === "" ? Number.NaN : Number(stockValue);
    return {
      ...data,
      id: item.id,
      productId: valueOf(data, "product_id", "productId"),
      productName: String(valueOf(data, "product_name", "product", "productName") || "").trim(),
      location: valueOf(data, "receiving_location", "location", "receivingLocation"),
      locationId: valueOf(data, "receiving_location_id", "location_id", "locationId"),
      currentStock,
      unit: String(valueOf(data, "unit", "quantity_unit", "quantityUnit") || "").trim(),
      createdAt: valueOf(data, "created_at", "createdAt"),
      updatedAt: valueOf(data, "updated_at", "updatedAt"),
      totalReceived: Number(valueOf(data, "total_received", "totalReceived")) || 0,
      totalIssued: Number(valueOf(data, "total_issued", "totalIssued")) || 0,
      lastGrnId: valueOf(data, "last_grn_id", "lastGrnId")
    };
  });
  const validRecords = loadedRecords.filter((record) => VALID_LOCATIONS.includes(record.location));
  const invalidLocationCount = loadedRecords.length - validRecords.length;
  stockRecords.splice(0, stockRecords.length, ...validRecords);
  inventoryConnection.textContent = invalidLocationCount
    ? `Live stock connected · ${invalidLocationCount} invalid-location record${invalidLocationCount === 1 ? "" : "s"} excluded`
    : "Live stock connected";
  renderAll();
}, (error) => {
  console.error("Unable to load inventory stock.", error);
  inventoryConnection.textContent = "Stock connection unavailable";
  tableScroll.hidden = true;
  emptyState.hidden = false;
  emptyState.querySelector("h3").textContent = "Inventory could not be loaded";
  emptyState.querySelector("p").textContent = "Check your connection and access, then refresh.";
  recordCount.textContent = "";
});
