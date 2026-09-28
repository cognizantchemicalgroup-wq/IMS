const recipeUnits = ["Pieces", "KG", "Liter"];
const defaultRecipeMaterials = [
  { material: "Empty Box", quantity: 1, unit: "Pieces" },
  { material: "2.5 Litre Bottle", quantity: 4, unit: "Pieces" },
  { material: "Thermocol", quantity: 2, unit: "Pieces" },
  { material: "Box Plate", quantity: 2, unit: "Pieces" }
];
const configurations = [{
  name: "2.5L Acetone Packing",
  customer: "E Sayyed Chemicals",
  product: "Acetone",
  packingBasis: "10 Litre / Box",
  chemicalQuantityPerBox: 10,
  chemicalUnit: "Liter",
  bottleCapacity: 2.5,
  bottleUnit: "Liter",
  bottlesPerBox: 4,
  status: "Active",
  materials: defaultRecipeMaterials.map((material) => ({ ...material }))
}];

const configurationRows = document.querySelector("#configurationRows");
const configurationDrawer = document.querySelector("#configurationDrawer");
const configurationOverlay = document.querySelector("#configurationOverlay");
const configurationForm = document.querySelector("#configurationForm");
const configurationView = document.querySelector("#configurationView");
const materialBody = document.querySelector("#configurationMaterials");
const calculationQuantity = document.querySelector("#calculationQuantity");
const calculationUnit = document.querySelector("#calculationUnit");
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
    row.append(makeCell(configuration.packingBasis));
    row.append(makeCell(`${configuration.materials.length} ${configuration.materials.length === 1 ? "Material" : "Materials"}`));
    const statusCell = document.createElement("td");
    const status = document.createElement("span");
    status.className = `status-badge ${configuration.status === "Active" ? "status-in-stock" : "status-out-of-stock"}`;
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
    <td><select class="recipe-material" aria-label="Packaging material"><option value="">Select material</option><option>Empty Box</option><option>2.5 Litre Bottle</option><option>Thermocol</option><option>Box Plate</option></select><span class="workflow-row-error recipe-material-error"></span></td>
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
  row.querySelectorAll("input, select").forEach((field) => field.addEventListener(field.tagName === "SELECT" ? "change" : "input", () => {
    row.classList.remove("workflow-invalid");
    row.querySelectorAll(".workflow-row-error").forEach((error) => { error.textContent = ""; });
    updateCalculation();
  }));
  materialBody.append(row);
  syncMaterialRows();
  return row;
}

function syncMaterialRows() {
  const isEmpty = materialBody.children.length === 0;
  document.querySelector("#configurationMaterialsEmpty").hidden = !isEmpty;
  document.querySelector("#configurationMaterialsError").textContent = "";
  updateCalculation();
}

function normalizedUnit(unit) {
  return String(unit).trim().toLowerCase().replace("litre", "liter");
}

function calculationStep(label, value) {
  const step = document.createElement("div");
  step.className = "calculation-step";
  const caption = document.createElement("span");
  caption.textContent = label;
  const result = document.createElement("strong");
  result.textContent = value;
  step.append(caption, result);
  return step;
}

function updateCalculation() {
  const chemical = Number(calculationQuantity.value);
  const chemicalUnit = calculationUnit.value;
  const capacity = Number(document.querySelector("#bottleCapacity").value);
  const bottleUnit = document.querySelector("#bottleUnit").value;
  const bottlesPerBox = Number(document.querySelector("#bottlesPerBox").value);
  const compatible = chemicalUnit && bottleUnit && normalizedUnit(chemicalUnit) === normalizedUnit(bottleUnit);
  const valid = compatible && chemical > 0 && capacity > 0 && bottlesPerBox > 0;
  const requiredBottles = valid ? Math.ceil(chemical / capacity) : 0;
  const boxes = valid ? Math.ceil(requiredBottles / bottlesPerBox) : 0;
  const flow = document.querySelector("#calculationFlow");
  flow.replaceChildren();
  flow.append(calculationStep("Chemical", `${Number.isFinite(chemical) ? chemical : 0} ${chemicalUnit}`));
  const bottleStep = calculationStep("Required Bottles", valid ? String(requiredBottles) : "—");
  const boxStep = calculationStep("Boxes", valid ? String(boxes) : "—");
  [bottleStep, boxStep].forEach((step) => {
    const arrow = document.createElement("i");
    arrow.className = "fa-solid fa-arrow-down calculation-arrow";
    arrow.setAttribute("aria-hidden", "true");
    flow.append(arrow, step);
  });
  if (!compatible) {
    const warning = document.createElement("p");
    warning.className = "calculation-warning";
    warning.textContent = "Chemical and bottle units must match for this preview.";
    flow.append(warning);
  }

  const rows = [...materialBody.querySelectorAll("tr")].map((row) => {
    const name = row.querySelector(".recipe-material").value;
    const rawPerBox = row.querySelector(".recipe-quantity").value;
    const perBox = rawPerBox ? Number(rawPerBox) : null;
    const required = valid && Number.isFinite(perBox) && perBox > 0 ? perBox * boxes : null;
    return { name, perBox, required };
  }).filter((row) => row.name);
  document.querySelector("#calculationRows").replaceChildren(...rows.map((item) => {
    const row = document.createElement("tr");
    const requiredText = item.required === null ? "—" : String(Number(item.required.toFixed(4)));
    row.append(makeCell(item.name, "product-name"), makeCell(Number.isFinite(item.perBox) ? String(item.perBox) : "—"), makeCell(requiredText));
    return row;
  }));
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
    document.querySelector("#packingBasis").value = configuration.packingBasis;
    document.querySelector("#chemicalQuantityPerBox").value = configuration.chemicalQuantityPerBox;
    document.querySelector("#chemicalUnit").value = configuration.chemicalUnit;
    document.querySelector("#bottleCapacity").value = configuration.bottleCapacity;
    document.querySelector("#bottleUnit").value = configuration.bottleUnit;
    document.querySelector("#bottlesPerBox").value = configuration.bottlesPerBox;
    document.querySelector("#configurationStatus").value = configuration.status;
    calculationUnit.value = configuration.chemicalUnit;
    configuration.materials.forEach((material) => makeMaterialRow(material.material, material.quantity, material.unit));
  } else {
    document.querySelector("#configurationName").value = "2.5L Acetone Packing";
    document.querySelector("#configurationCustomer").value = "E Sayyed Chemicals";
    document.querySelector("#configurationProduct").value = "Acetone";
    document.querySelector("#packingBasis").value = "10 Litre / Box";
    document.querySelector("#chemicalQuantityPerBox").value = "10";
    document.querySelector("#chemicalUnit").value = "Liter";
    document.querySelector("#bottleCapacity").value = "2.5";
    document.querySelector("#bottleUnit").value = "Liter";
    document.querySelector("#bottlesPerBox").value = "4";
    document.querySelector("#configurationStatus").value = "Active";
    calculationUnit.value = "Liter";
    defaultRecipeMaterials.forEach((material) => makeMaterialRow(material.material, material.quantity, material.unit));
  }
  calculationQuantity.value = "100";
  updateCalculation();
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
  addDetail(grid, "Packing Basis", configuration.packingBasis);
  addDetail(grid, "Chemical Quantity per Box", `${configuration.chemicalQuantityPerBox} ${configuration.chemicalUnit}`);
  addDetail(grid, "Bottle Capacity", `${configuration.bottleCapacity} ${configuration.bottleUnit}`);
  addDetail(grid, "Bottles per Box", String(configuration.bottlesPerBox));
  addDetail(grid, "Status", configuration.status);
  details.append(grid);
  configurationView.append(details);

  const requirementsTitle = document.createElement("h3");
  requirementsTitle.className = "config-requirements-heading";
  requirementsTitle.textContent = "Packaging Recipe";
  const tableWrap = document.createElement("div");
  tableWrap.className = "workflow-table-wrap";
  const table = document.createElement("table");
  table.className = "workflow-table";
  table.innerHTML = "<thead><tr><th>Packaging Material</th><th>Quantity per Box</th><th>Unit</th></tr></thead>";
  const body = document.createElement("tbody");
  configuration.materials.forEach((material) => {
    const row = document.createElement("tr");
    row.append(makeCell(material.material, "product-name"), makeCell(String(material.quantity)), makeCell(material.unit));
    body.append(row);
  });
  table.append(body);
  tableWrap.append(table);
  const exampleQuantity = 100;
  const requiredBottles = Math.ceil(exampleQuantity / configuration.bottleCapacity);
  const boxes = Math.ceil(requiredBottles / configuration.bottlesPerBox);
  const example = document.createElement("section");
  example.className = "config-detail-card calculation-example";
  const exampleTitle = document.createElement("h3");
  exampleTitle.textContent = "Calculation Example";
  const exampleFlow = document.createElement("div");
  exampleFlow.className = "view-calculation-flow";
  [
    `${exampleQuantity} ${configuration.bottleUnit}`,
    `${requiredBottles} Bottles`,
    `${boxes} Boxes`
  ].forEach((value, index) => {
    if (index) {
      const arrow = document.createElement("i");
      arrow.className = "fa-solid fa-arrow-down calculation-arrow";
      arrow.setAttribute("aria-hidden", "true");
      exampleFlow.append(arrow);
    }
    const step = document.createElement("strong");
    step.textContent = value;
    exampleFlow.append(step);
  });
  example.append(exampleTitle, exampleFlow);
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
  configurationView.append(requirementsTitle, tableWrap, example, actionRow);
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
["#chemicalQuantityPerBox", "#chemicalUnit", "#bottleCapacity", "#bottleUnit", "#bottlesPerBox", "#calculationQuantity", "#calculationUnit"].forEach((selector) => {
  const control = document.querySelector(selector);
  control.addEventListener(control.tagName === "SELECT" ? "change" : "input", updateCalculation);
});
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
  const packingBasis = document.querySelector("#packingBasis").value.trim();
  const chemicalQuantityPerBox = Number(document.querySelector("#chemicalQuantityPerBox").value);
  const chemicalUnit = document.querySelector("#chemicalUnit").value;
  const bottleCapacity = Number(document.querySelector("#bottleCapacity").value);
  const bottleUnit = document.querySelector("#bottleUnit").value;
  const bottlesPerBox = Number(document.querySelector("#bottlesPerBox").value);
  const status = document.querySelector("#configurationStatus").value;
  setFieldError("configurationNameField", "configurationNameError", name ? "" : "Configuration Name is required.");
  setFieldError("configurationCustomerField", "configurationCustomerError", customer ? "" : "Customer is required.");
  setFieldError("configurationProductField", "configurationProductError", product ? "" : "Product is required.");
  setFieldError("packingBasisField", "packingBasisError", packingBasis ? "" : "Packing Basis is required.");
  setFieldError("chemicalQuantityPerBoxField", "chemicalQuantityPerBoxError", chemicalQuantityPerBox > 0 ? "" : "Enter a quantity greater than zero.");
  setFieldError("bottleCapacityField", "bottleCapacityError", bottleCapacity > 0 ? "" : "Enter a capacity greater than zero.");
  setFieldError("bottlesPerBoxField", "bottlesPerBoxError", Number.isInteger(bottlesPerBox) && bottlesPerBox > 0 ? "" : "Enter a whole number greater than zero.");

  let valid = Boolean(name && customer && product && packingBasis
    && Number.isFinite(chemicalQuantityPerBox) && chemicalQuantityPerBox > 0
    && Number.isFinite(bottleCapacity) && bottleCapacity > 0
    && Number.isInteger(bottlesPerBox) && bottlesPerBox > 0);
  const materials = [...materialBody.children].map((row) => {
    const material = row.querySelector(".recipe-material").value.trim();
    const quantity = row.querySelector(".recipe-quantity").value;
    const unit = row.querySelector(".recipe-unit").value;
    let rowValid = true;
    if (!material) {
      row.querySelector(".recipe-material-error").textContent = "Packaging Material is required.";
      rowValid = false;
    }
    if (!quantity || !Number.isFinite(Number(quantity)) || Number(quantity) <= 0) {
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

  const saved = { name, customer, product, packingBasis, chemicalQuantityPerBox, chemicalUnit, bottleCapacity, bottleUnit, bottlesPerBox, materials, status };
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