const recipeUnits = ["Pieces", "KG", "Liter"];
const configurations = [{
  name: "2.5L Bottle Packing",
  customer: "ABC Chemicals",
  product: "Acetone 2.5L",
  status: "Active",
  materials: [
    { material: "Empty Box", quantity: 1, unit: "Pieces" },
    { material: "2.5 Litre Bottle", quantity: 4, unit: "Pieces" },
    { material: "Thermocol", quantity: 2, unit: "Pieces" },
    { material: "Box Plate", quantity: 2, unit: "Pieces" }
  ]
}];

const configurationRows = document.querySelector("#configurationRows");
const configurationDrawer = document.querySelector("#configurationDrawer");
const configurationOverlay = document.querySelector("#configurationOverlay");
const configurationForm = document.querySelector("#configurationForm");
const configurationView = document.querySelector("#configurationView");
const materialBody = document.querySelector("#configurationMaterials");
let editingIndex = null;

function makeCell(value, className = "") {
  const cell = document.createElement("td");
  cell.textContent = value;
  if (className) cell.className = className;
  return cell;
}

function renderConfigurations() {
  configurationRows.replaceChildren(...configurations.map((configuration, index) => {
    const row = document.createElement("tr");
    row.append(makeCell(configuration.name, "product-name"));
    row.append(makeCell(configuration.customer));
    row.append(makeCell(configuration.product));
    row.append(makeCell(`${configuration.materials.length} ${configuration.materials.length === 1 ? "Material" : "Materials"}`));
    const statusCell = document.createElement("td");
    const status = document.createElement("span");
    status.className = "status-badge status-in-stock";
    status.textContent = configuration.status;
    statusCell.append(status);
    row.append(statusCell);
    const actionCell = document.createElement("td");
    const actions = document.createElement("span");
    actions.className = "table-action-group";
    const viewButton = document.createElement("button");
    viewButton.className = "table-action";
    viewButton.type = "button";
    viewButton.textContent = "View";
    viewButton.addEventListener("click", () => openView(index));
    const editButton = document.createElement("button");
    editButton.className = "table-action edit-action";
    editButton.type = "button";
    editButton.textContent = "Edit";
    editButton.addEventListener("click", () => openEditor(index));
    actions.append(viewButton, editButton);
    actionCell.append(actions);
    row.append(actionCell);
    return row;
  }));
  document.querySelector("#configurationCount").textContent = `${configurations.length} ${configurations.length === 1 ? "configuration" : "configurations"}`;
  document.querySelector("#configurationFooter").textContent = `${configurations.length} demo ${configurations.length === 1 ? "recipe" : "recipes"}`;
  document.querySelector("#configurationEmpty").hidden = configurations.length !== 0;
  document.querySelector(".configuration-table").parentElement.hidden = configurations.length === 0;
}

function makeMaterialRow(material = "", quantity = "", unit = "") {
  const row = document.createElement("tr");
  row.innerHTML = `
    <td><input class="recipe-material" list="configurationMaterialOptions" aria-label="Packaging material" placeholder="Search material" autocomplete="off"><span class="workflow-row-error recipe-material-error"></span></td>
    <td><input class="recipe-quantity" type="number" min="0.01" step="any" aria-label="Quantity per box" placeholder="0"><span class="workflow-row-error recipe-quantity-error"></span></td>
    <td><select class="recipe-unit" aria-label="Unit"><option value="">Select unit</option>${recipeUnits.map((option) => `<option>${option}</option>`).join("")}</select><span class="workflow-row-error recipe-unit-error"></span></td>
    <td><button class="workflow-row-remove" type="button" aria-label="Remove packaging material"><i class="fa-solid fa-trash-can"></i></button></td>`;
  row.querySelector(".recipe-material").value = material;
  row.querySelector(".recipe-quantity").value = quantity;
  row.querySelector(".recipe-unit").value = unit;
  row.querySelector(".workflow-row-remove").addEventListener("click", () => {
    row.remove();
    syncMaterialRows();
  });
  row.querySelectorAll("input, select").forEach((field) => field.addEventListener("input", () => {
    row.classList.remove("workflow-invalid");
    row.querySelectorAll(".workflow-row-error").forEach((error) => { error.textContent = ""; });
  }));
  materialBody.append(row);
  syncMaterialRows();
  return row;
}

function syncMaterialRows() {
  const isEmpty = materialBody.children.length === 0;
  document.querySelector("#configurationMaterialsEmpty").hidden = !isEmpty;
  document.querySelector("#configurationMaterialsError").textContent = "";
}

function openDrawer() {
  configurationDrawer.classList.add("open");
  configurationDrawer.setAttribute("aria-hidden", "false");
  configurationOverlay.classList.add("active");
}

function closeDrawer() {
  configurationDrawer.classList.remove("open");
  configurationDrawer.setAttribute("aria-hidden", "true");
  configurationOverlay.classList.remove("active");
}

function openEditor(index = null) {
  editingIndex = index;
  const configuration = index === null ? null : configurations[index];
  document.querySelector("#drawerTitle").textContent = configuration ? "Edit Configuration" : "Create Configuration";
  configurationView.hidden = true;
  configurationForm.hidden = false;
  configurationForm.reset();
  materialBody.replaceChildren();
  clearConfigurationErrors();
  if (configuration) {
    document.querySelector("#configurationName").value = configuration.name;
    document.querySelector("#configurationCustomer").value = configuration.customer;
    document.querySelector("#configurationProduct").value = configuration.product;
    configuration.materials.forEach((material) => makeMaterialRow(material.material, material.quantity, material.unit));
  } else {
    makeMaterialRow();
  }
  openDrawer();
  document.querySelector("#configurationName").focus();
}

function addDetail(container, label, value) {
  const item = document.createElement("div");
  const detailLabel = document.createElement("span");
  detailLabel.className = "detail-label";
  detailLabel.textContent = label;
  const detailValue = document.createElement("span");
  detailValue.className = "detail-value";
  detailValue.textContent = value;
  item.append(detailLabel, detailValue);
  container.append(item);
}

function openView(index) {
  const configuration = configurations[index];
  document.querySelector("#drawerTitle").textContent = configuration.name;
  configurationForm.hidden = true;
  configurationView.hidden = false;
  configurationView.replaceChildren();

  const details = document.createElement("section");
  details.className = "config-detail-card";
  const grid = document.createElement("div");
  grid.className = "config-detail-grid";
  addDetail(grid, "Configuration Name", configuration.name);
  addDetail(grid, "Customer", configuration.customer);
  addDetail(grid, "Product", configuration.product);
  details.append(grid);
  configurationView.append(details);

  const requirementsTitle = document.createElement("h3");
  requirementsTitle.className = "config-requirements-heading";
  requirementsTitle.textContent = "Packaging Requirements";
  const tableWrap = document.createElement("div");
  tableWrap.className = "workflow-table-wrap";
  const table = document.createElement("table");
  table.className = "workflow-table";
  table.innerHTML = "<thead><tr><th>Material</th><th>Qty Per Box</th><th>Unit</th></tr></thead>";
  const body = document.createElement("tbody");
  configuration.materials.forEach((material) => {
    const row = document.createElement("tr");
    row.append(makeCell(material.material, "product-name"), makeCell(String(material.quantity)), makeCell(material.unit));
    body.append(row);
  });
  table.append(body);
  tableWrap.append(table);
  const actionRow = document.createElement("div");
  actionRow.className = "drawer-action-row";
  const editButton = document.createElement("button");
  editButton.className = "button button-primary";
  editButton.type = "button";
  editButton.innerHTML = '<i class="fa-solid fa-pen"></i> Edit';
  editButton.addEventListener("click", () => openEditor(index));
  const closeButton = document.createElement("button");
  closeButton.className = "button";
  closeButton.type = "button";
  closeButton.textContent = "Close";
  closeButton.addEventListener("click", closeDrawer);
  actionRow.append(editButton, closeButton);
  configurationView.append(requirementsTitle, tableWrap, actionRow);
  openDrawer();
  editButton.focus();
}

function clearConfigurationErrors() {
  document.querySelectorAll(".config-fields .field").forEach((field) => field.classList.remove("invalid"));
  document.querySelectorAll(".config-fields .field-error").forEach((error) => { error.textContent = ""; });
  document.querySelector("#configurationMaterialsError").textContent = "";
  materialBody.querySelectorAll(".workflow-invalid").forEach((row) => row.classList.remove("workflow-invalid"));
  materialBody.querySelectorAll(".workflow-row-error").forEach((error) => { error.textContent = ""; });
}

function setFieldError(fieldId, errorId, message) {
  document.querySelector(`#${fieldId}`).classList.toggle("invalid", Boolean(message));
  document.querySelector(`#${errorId}`).textContent = message;
}

document.querySelector("#createConfiguration").addEventListener("click", () => openEditor());
document.querySelector("#addConfigurationMaterial").addEventListener("click", () => makeMaterialRow().querySelector(".recipe-material").focus());
document.querySelector("#cancelConfiguration").addEventListener("click", closeDrawer);
document.querySelector("#closeConfigurationIcon").addEventListener("click", closeDrawer);
configurationOverlay.addEventListener("click", closeDrawer);
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeDrawer(); });

configurationForm.addEventListener("submit", (event) => {
  event.preventDefault();
  clearConfigurationErrors();
  const name = document.querySelector("#configurationName").value.trim();
  const customer = document.querySelector("#configurationCustomer").value;
  const product = document.querySelector("#configurationProduct").value;
  setFieldError("configurationNameField", "configurationNameError", name ? "" : "Configuration Name is required.");
  setFieldError("configurationCustomerField", "configurationCustomerError", customer ? "" : "Customer is required.");
  setFieldError("configurationProductField", "configurationProductError", product ? "" : "Product is required.");

  let valid = Boolean(name && customer && product);
  const materials = [...materialBody.children].map((row) => {
    const material = row.querySelector(".recipe-material").value.trim();
    const quantity = row.querySelector(".recipe-quantity").value;
    const unit = row.querySelector(".recipe-unit").value;
    let rowValid = true;
    if (!material) {
      row.querySelector(".recipe-material-error").textContent = "Packaging Material is required.";
      rowValid = false;
    }
    if (!quantity || Number(quantity) <= 0) {
      row.querySelector(".recipe-quantity-error").textContent = "Quantity must be greater than 0.";
      rowValid = false;
    }
    if (!unit) {
      row.querySelector(".recipe-unit-error").textContent = "Select a unit.";
      rowValid = false;
    }
    if (!rowValid) row.classList.add("workflow-invalid");
    valid = valid && rowValid;
    return { material, quantity: Number(quantity), unit };
  });

  const hasMaterials = materials.length > 0;
  document.querySelector("#configurationMaterialsError").textContent = hasMaterials ? "" : "At least one packaging material is required.";
  document.querySelector("#configurationMaterialsEmpty").hidden = hasMaterials;
  valid = valid && hasMaterials;
  if (!valid) {
    configurationDrawer.querySelector(".invalid input, .invalid select, .workflow-invalid input, .workflow-invalid select")?.focus();
    return;
  }

  const saved = { name, customer, product, materials, status: "Active" };
  if (editingIndex === null) configurations.push(saved);
  else configurations[editingIndex] = saved;
  renderConfigurations();
  closeDrawer();
});

const sidebar = document.querySelector("#sidebar");
const mobileMenuToggle = document.querySelector("#mobileMenuToggle");
mobileMenuToggle.addEventListener("click", () => {
  const open = sidebar.classList.toggle("open");
  mobileMenuToggle.setAttribute("aria-expanded", String(open));
  mobileMenuToggle.setAttribute("aria-label", open ? "Close navigation menu" : "Open navigation menu");
});

renderConfigurations();