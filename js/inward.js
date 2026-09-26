import { db, storage } from "./firebase-config.js";
import {
  collection,
  doc,
  serverTimestamp,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  deleteObject,
  getDownloadURL,
  ref,
  uploadBytes
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

const form = document.getElementById("inwardForm");
const formMessage = document.getElementById("formMessage");
const submitButton = form.querySelector("button[type=submit]");
const receivedAs = document.getElementById("receivedAs");
const invoiceUpload = document.getElementById("invoiceUpload");
const supplierCoa = document.getElementById("supplierCoa");
const poUpload = document.getElementById("poUpload");

function showMessage(message, color = "var(--danger)") {
  formMessage.textContent = message;
  formMessage.style.color = color;
}

function setFieldValidity(field, valid) {
  field.style.borderColor = valid ? "var(--border)" : "var(--danger)";
}

function positiveNumber(id, label) {
  const field = document.getElementById(id);
  const value = Number(field.value);
  const valid = field.value.trim() !== "" && Number.isFinite(value) && value > 0;
  setFieldValidity(field, valid);
  return valid ? value : { error: `${label} must be greater than 0.` };
}

function getDeclaredQuantity() {
  const type = receivedAs.value;

  if (type === "other") {
    const receiveType = document.getElementById("otherReceiveType").value.trim();
    const quantity = document.getElementById("otherDeclaredQty").value.trim();

    if (!receiveType) return { error: "Please enter the receive type for Other." };
    if (!quantity) return { error: "Please enter a total declared quantity for Other." };

    return { declaredQuantity: quantity, unit: "Other", receiveType, totalContainers: null, qtyPerContainer: null };
  }

  if (["drums", "ibc", "tanker"].includes(type)) {
    const mapped = {
      drums: "drumsDeclaredQty",
      ibc: "ibcDeclaredQty",
      tanker: "tankerDeclaredQty"
    };
    const quantity = document.getElementById(mapped[type]).value.trim();
    if (!quantity) return { error: "Please enter a total declared quantity." };
    return { declaredQuantity: quantity, unit: "Qty", receiveType: type, totalContainers: null, qtyPerContainer: null };
  }

  return { error: "Please select how the material was received." };
}

function validateRequiredFields() {
  const requiredIds = ["supplier", "product", "receivingLocation", "receivedAs"];
  let valid = true;

  requiredIds.forEach((id) => {
    const field = document.getElementById(id);
    const fieldValid = Boolean(field.value);
    setFieldValidity(field, fieldValid);
    valid = fieldValid && valid;
  });

  if (!valid) showMessage("Please complete all required fields before receiving the material.");
  return valid;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024;

function validateFile(file, label) {
  if (!file) return null;
  const allowedTypes = new Set([
    "application/pdf",
    "image/jpeg",
    "image/png",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ]);

  if (!allowedTypes.has(file.type)) {
    return `${label} must be a PDF or a supported document/image file.`;
  }
  if (file.size <= 0 || file.size > MAX_FILE_SIZE) {
    return `${label} must be smaller than 10 MB.`;
  }
  return null;
}

async function uploadDocument(file, folder, inwardId, uploadedRefs) {
  if (!file) return "";
  const filePath = `CCPL-IMS/${folder}/${inwardId}/${file.name}`;
  const fileRef = ref(storage, filePath);
  await uploadBytes(fileRef, file, { contentType: file.type });
  uploadedRefs.push(fileRef);
  return getDownloadURL(fileRef);
}

async function deleteUploadedFiles(uploadedRefs) {
  await Promise.all(uploadedRefs.map(async (fileRef) => {
    try {
      await deleteObject(fileRef);
    } catch (error) {
      console.error("Unable to clean up uploaded inward document.", error);
    }
  }));
}

function resetForm() {
  form.reset();
  receivedAs.dispatchEvent(new Event("change"));
  document.getElementById("drumsDeclaredQty").value = "";
  document.getElementById("ibcDeclaredQty").value = "";
  document.getElementById("tankerDeclaredQty").value = "";
  document.getElementById("otherDeclaredQty").value = "";
  document.getElementById("otherReceiveType").value = "";
  document.getElementById("invoiceFileName").textContent = "No file selected";
  document.getElementById("coaFileName").textContent = "No file selected";
  document.getElementById("poFileName").textContent = "No file selected";
  form.querySelectorAll("input, select").forEach((field) => {
    field.style.borderColor = "var(--border)";
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (submitButton.disabled) return;
  showMessage("");

  if (!validateRequiredFields()) return;
  const quantity = getDeclaredQuantity();
  if (quantity.error) {
    showMessage(quantity.error);
    return;
  }

  const invoiceFile = invoiceUpload.files[0];
  const coaFile = supplierCoa.files[0];
  const poFile = poUpload.files[0];
  const invoiceValidationError = validateFile(invoiceFile, "Invoice");
  const coaValidationError = validateFile(coaFile, "Supplier COA");
  const poValidationError = validateFile(poFile, "PO");
  if (invoiceValidationError) {
    showMessage(invoiceValidationError);
    return;
  }
  if (coaValidationError) {
    showMessage(coaValidationError);
    return;
  }
  if (poValidationError) {
    showMessage(poValidationError);
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = "Saving...";

  const inwardRef = doc(collection(db, "inward"));
  const data = {
    supplier: document.getElementById("supplier").value,
    product: document.getElementById("product").value,
    vehicleNo: document.getElementById("vehicleNo").value.trim(),
    invoiceChallanNo: document.getElementById("invoiceChallanNo").value.trim(),
    industryType: document.getElementById("industryType").value.trim(),
    industry_type: document.getElementById("industryType").value.trim(),
    purchaseOrder: document.getElementById("purchaseOrder").value.trim(),
    purchase_order: document.getElementById("purchaseOrder").value.trim(),
    receivingLocation: document.getElementById("receivingLocation").value,
    supplierLotNo: document.getElementById("supplierLotNo").value.trim(),
    receivedAs: receivedAs.value,
    receiveType: quantity.receiveType || receivedAs.value,
    receive_type: quantity.receiveType || receivedAs.value,
    declaredQuantity: quantity.declaredQuantity,
    declared_quantity: quantity.declaredQuantity,
    unit: quantity.unit,
    quantity_unit: quantity.unit,
    status: "KANTA PENDING",
    invoiceFileUrl: "",
    invoice_file_url: "",
    coaFileUrl: "",
    coa_file_url: "",
    poFileUrl: "",
    po_file_url: "",
    createdAt: serverTimestamp()
  };

  const uploadedRefs = [];

  try {
    try {
      data.invoiceFileUrl = await uploadDocument(invoiceFile, "invoices", inwardRef.id, uploadedRefs);
    } catch (error) {
      console.error("Invoice upload failed.", error);
      await deleteUploadedFiles(uploadedRefs);
      showMessage("Invoice upload failed.");
      return;
    }

    try {
      data.coaFileUrl = await uploadDocument(coaFile, "supplier-coa", inwardRef.id, uploadedRefs);
      data.coa_file_url = data.coaFileUrl;
    } catch (error) {
      console.error("Supplier COA upload failed.", error);
      await deleteUploadedFiles(uploadedRefs);
      showMessage("Supplier COA upload failed.");
      return;
    }

    try {
      data.poFileUrl = await uploadDocument(poFile, "purchase-order", inwardRef.id, uploadedRefs);
      data.po_file_url = data.poFileUrl;
    } catch (error) {
      console.error("PO upload failed.", error);
      await deleteUploadedFiles(uploadedRefs);
      showMessage("PO upload failed.");
      return;
    }

    await setDoc(inwardRef, data);
    showMessage(`Material received successfully. Inward ID: ${inwardRef.id}`, "var(--success)");
    resetForm();
  } catch (error) {
    console.error("Unable to save inward record.", error);
    await deleteUploadedFiles(uploadedRefs);
    showMessage("Unable to save inward record.");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Receive Material";
  }
});
