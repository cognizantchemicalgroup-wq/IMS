const materialRows = document.querySelector("#materialRows");
const rowsEmpty = document.querySelector("#rowsEmpty");
const receiptForm = document.querySelector("#receiptForm");
const materialNames = ["Empty Box", "2.5 Litre Bottle", "Thermocol", "Box Plate"];
const unitNames = ["Pieces", "KG", "Liter"];

function updateTimestamp() {
  document.querySelector("#receivedAt").value = new Intl.DateTimeFormat("en-IN", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
  }).format(new Date());
}

function makeRow() {
  const row = document.createElement("tr");
  row.innerHTML = `
    <td><input class="material-input" list="materialOptions" aria-label="Packaging material" placeholder="Search material" autocomplete="off"><span class="row-error material-error"></span></td>
    <td><input class="qty-input" type="number" min="0.01" step="any" aria-label="Received quantity" placeholder="0"><span class="row-error quantity-error"></span></td>
    <td><select class="unit-input" aria-label="Unit"><option value="">Select unit</option>${unitNames.map((unit) => `<option>${unit}</option>`).join("")}</select><span class="row-error unit-error"></span></td>
    <td><button class="row-remove" type="button" aria-label="Remove material row"><i class="fa-solid fa-trash-can"></i></button></td>`;
  row.querySelector(".row-remove").addEventListener("click", () => {
    row.remove();
    syncRowsEmpty();
    clearSuccess();
  });
  row.querySelectorAll("input, select").forEach((field) => field.addEventListener("input", () => {
    row.classList.remove("row-invalid");
    row.querySelectorAll(".row-error").forEach((error) => { error.textContent = ""; });
    clearSuccess();
  }));
  materialRows.append(row);
  syncRowsEmpty();
  return row;
}

function syncRowsEmpty() {
  rowsEmpty.hidden = materialRows.children.length > 0;
}

function clearSuccess() {
  document.querySelector("#successBanner").classList.remove("visible");
}

function showError(row, selector, message) {
  row.querySelector(selector).textContent = message;
  row.classList.add("row-invalid");
}

document.querySelector("#addRow").addEventListener("click", () => {
  const row = makeRow();
  row.querySelector(".material-input").focus();
  clearSuccess();
});

document.querySelector("#showAddMaterial").addEventListener("click", () => {
  const panel = document.querySelector("#newMaterialPanel");
  panel.hidden = !panel.hidden;
  if (!panel.hidden) document.querySelector("#newMaterialInput").focus();
});

document.querySelector("#confirmAddMaterial").addEventListener("click", () => {
  const input = document.querySelector("#newMaterialInput");
  const name = input.value.trim();
  if (!name) {
    input.setCustomValidity("Enter a material name.");
    input.reportValidity();
    return;
  }
  input.setCustomValidity("");
  if (!materialNames.some((material) => material.toLowerCase() === name.toLowerCase())) {
    materialNames.push(name);
    const option = document.createElement("option");
    option.value = name;
    document.querySelector("#materialOptions").append(option);
  }
  let targetRow = materialRows.lastElementChild;
  if (!targetRow) targetRow = makeRow();
  targetRow.querySelector(".material-input").value = name;
  input.value = "";
  document.querySelector("#newMaterialPanel").hidden = true;
  clearSuccess();
});

document.querySelector("#customerInput").addEventListener("input", () => {
  document.querySelector("#customerField").classList.remove("invalid");
  document.querySelector("#customerError").textContent = "";
  clearSuccess();
});

document.querySelector("#referenceInput").addEventListener("input", clearSuccess);
document.querySelector("#remarkInput").addEventListener("input", clearSuccess);

receiptForm.addEventListener("submit", (event) => {
  event.preventDefault();
  clearSuccess();
  const customerInput = document.querySelector("#customerInput");
  const customerField = document.querySelector("#customerField");
  const knownCustomers = [...document.querySelectorAll("#customerOptions option")].map((option) => option.value);
  const customerValid = knownCustomers.includes(customerInput.value.trim());
  customerField.classList.toggle("invalid", !customerValid);
  document.querySelector("#customerError").textContent = customerValid ? "" : "Select a customer from the list.";

  let valid = customerValid && materialRows.children.length > 0;
  [...materialRows.children].forEach((row) => {
    const materialInput = row.querySelector(".material-input");
    const quantityInput = row.querySelector(".qty-input");
    const unitInput = row.querySelector(".unit-input");
    let rowValid = true;
    if (!materialInput.value.trim()) {
      showError(row, ".material-error", "Select a material.");
      rowValid = false;
    }
    if (!quantityInput.value || Number(quantityInput.value) <= 0) {
      showError(row, ".quantity-error", "Enter a quantity above zero.");
      rowValid = false;
    }
    if (!unitInput.value) {
      showError(row, ".unit-error", "Select a unit.");
      rowValid = false;
    }
    valid = valid && rowValid;
  });

  if (!materialRows.children.length) {
    rowsEmpty.textContent = "Add at least one packaging material before saving.";
    rowsEmpty.hidden = false;
  } else {
    rowsEmpty.textContent = "No materials added yet. Use “Add row” to start this receipt.";
  }
  if (!valid) {
    const firstInvalid = receiptForm.querySelector(".invalid input, .row-invalid input, .row-invalid select");
    firstInvalid?.focus();
    return;
  }

  const customer = customerInput.value.trim();
  const count = materialRows.children.length;
  document.querySelector("#successMessage").textContent = `Preview receipt for ${customer} with ${count} ${count === 1 ? "material row" : "material rows"}. No receipt or stock records were created.`;
  document.querySelector("#successBanner").classList.add("visible");
  document.querySelector("#successBanner").scrollIntoView({ behavior: "smooth", block: "center" });
});

const sidebar = document.querySelector("#sidebar");
const mobileMenuToggle = document.querySelector("#mobileMenuToggle");
mobileMenuToggle.addEventListener("click", () => {
  const open = sidebar.classList.toggle("open");
  mobileMenuToggle.setAttribute("aria-expanded", String(open));
  mobileMenuToggle.setAttribute("aria-label", open ? "Close navigation menu" : "Open navigation menu");
});

updateTimestamp();
makeRow();