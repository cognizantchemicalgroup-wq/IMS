const demoStock = [
  { customer: "ABC Chemicals", material: "Empty Box", received: 10, consumed: 2, available: 8, unit: "Pieces", updated: "26 Sep 2026, 10:42 AM" },
  { customer: "ABC Chemicals", material: "2.5 Litre Bottle", received: 10, consumed: 8, available: 2, unit: "Pieces", updated: "26 Sep 2026, 10:38 AM" },
  { customer: "ABC Chemicals", material: "Thermocol", received: 10, consumed: 4, available: 6, unit: "Pieces", updated: "25 Sep 2026, 04:15 PM" },
  { customer: "ABC Chemicals", material: "Box Plate", received: 10, consumed: 4, available: 6, unit: "Pieces", updated: "25 Sep 2026, 03:50 PM" },
  { customer: "XYZ Industries", material: "Empty Box", received: 18, consumed: 18, available: 0, unit: "Pieces", updated: "24 Sep 2026, 11:12 AM" },
  { customer: "XYZ Industries", material: "Thermocol", received: 5, consumed: 1, available: 4, unit: "KG", updated: "24 Sep 2026, 10:55 AM" }
];

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

function getStatus(record) {
  if (record.available <= 0) return "Out of Stock";
  if (record.available <= 2) return "Low Stock";
  return "In Stock";
}

function statusClass(status) {
  return status.toLowerCase().replaceAll(" ", "-");
}

function renderStock() {
  const customer = customerFilter.value;
  const search = materialSearch.value.trim().toLowerCase();
  const status = statusFilter.value;
  const unit = unitFilter.value;
  const filtered = demoStock.filter((record) => {
    return (!customer || record.customer === customer)
      && record.material.toLowerCase().includes(search)
      && (!status || getStatus(record) === status)
      && (!unit || record.unit === unit);
  });

  customerHeading.textContent = customer === "none" ? "No customer selected" : customer || "All customers";
  document.querySelector("#tableDescription").textContent = customer
    ? customer === "none" ? "Choose a customer to view customer-wise packaging stock" : `Packaging materials recorded for ${customer}`
    : "Customer-level demo stock overview";
  stockRows.replaceChildren(...filtered.map((record) => {
    const row = document.createElement("tr");
    const currentStatus = getStatus(record);
    row.innerHTML = `<td>${record.customer}</td><td class="product-name">${record.material}</td><td class="stock-number">${record.received}</td><td>${record.consumed}</td><td class="stock-number">${record.available}</td><td>${record.unit}</td><td><span class="status-badge status-${statusClass(currentStatus)}">${currentStatus}</span></td><td><button class="view-button" type="button">View</button></td>`;
    row.querySelector(".view-button").addEventListener("click", () => openDetails(record));
    return row;
  }));

  loadingState.hidden = true;
  tableWrap.hidden = filtered.length === 0;
  emptyState.hidden = filtered.length !== 0;
  resultCount.textContent = `${filtered.length} ${filtered.length === 1 ? "record" : "records"}`;

  const emptyTitle = document.querySelector("#emptyTitle");
  const emptyMessage = document.querySelector("#emptyMessage");
  if (customer === "none") {
    emptyTitle.textContent = "No customer selected.";
    emptyMessage.textContent = "Select a customer to view packaging stock.";
  } else if (search || status || unit) {
    emptyTitle.textContent = "No search results found.";
    emptyMessage.textContent = "Try changing your search or filters.";
  } else if (customer === "Customer Demo") {
    emptyTitle.textContent = "No packaging stock available.";
    emptyMessage.textContent = "There are no demo materials recorded for Customer Demo.";
  } else if (customer) {
    emptyTitle.textContent = "No packaging stock available.";
    emptyMessage.textContent = `There are no demo materials recorded for ${customer}.`;
  } else {
    emptyTitle.textContent = "No packaging stock available.";
    emptyMessage.textContent = "There are no demo materials to display.";
  }
}

function openDetails(record) {
  const status = getStatus(record);
  document.querySelector("#drawerTitle").textContent = record.material;
  document.querySelector("#drawerContent").innerHTML = `
    <section class="detail-card"><div class="detail-grid">
      <div><span class="detail-label">Customer</span><span class="detail-value">${record.customer}</span></div>
      <div><span class="detail-label">Packaging Material</span><span class="detail-value">${record.material}</span></div>
      <div><span class="detail-label">Total Received</span><span class="detail-value">${record.received} ${record.unit}</span></div>
      <div><span class="detail-label">Total Consumed</span><span class="detail-value">${record.consumed} ${record.unit}</span></div>
      <div><span class="detail-label">Available Stock</span><span class="detail-value">${record.available} ${record.unit}</span></div>
      <div><span class="detail-label">Unit</span><span class="detail-value">${record.unit}</span></div>
      <div><span class="detail-label">Current Status</span><span class="status-badge status-${statusClass(status)}">${status}</span></div>
      <div><span class="detail-label">Last Updated</span><span class="detail-value">${record.updated}</span></div>
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

const sidebar = document.querySelector("#sidebar");
const mobileMenuToggle = document.querySelector("#mobileMenuToggle");
mobileMenuToggle.addEventListener("click", () => {
  const open = sidebar.classList.toggle("open");
  mobileMenuToggle.setAttribute("aria-expanded", String(open));
  mobileMenuToggle.setAttribute("aria-label", open ? "Close navigation menu" : "Open navigation menu");
});

window.setTimeout(renderStock, 450);