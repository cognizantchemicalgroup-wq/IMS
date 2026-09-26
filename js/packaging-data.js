import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  where
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

function valueOf(record, ...keys) {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== "") return record[key];
  }
  return "";
}

function normalizedName(value) {
  return String(value ?? "").trim().normalize("NFKC");
}

function idPart(value) {
  const encoded = encodeURIComponent(normalizedName(value).toLowerCase());
  return `${encoded.length}_${encoded}`;
}

export function packagingEntityId(value) {
  return idPart(value);
}

export function packagingStockId(customerId, materialId) {
  return `${idPart(customerId)}__${idPart(materialId)}`;
}

function currentUser() {
  if (auth.currentUser) return Promise.resolve(auth.currentUser);
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    }, reject);
  });
}

export async function requireActiveUser() {
  const user = await currentUser();
  if (!user?.email) throw new Error("Sign in with an authorized CCPL IMS account to continue.");
  const usersQuery = query(collection(db, "users"), where("email", "==", user.email), limit(1));
  const usersSnapshot = await getDocs(usersQuery);
  if (!usersSnapshot.empty && usersSnapshot.docs[0].data().active === true) return user;
  const userDocument = await getDoc(doc(db, "users", user.email));
  if (userDocument.exists() && userDocument.data().active === true) return user;
  throw new Error("Access denied. Your account is not authorized to access CCPL IMS.");
}

function actorFor(user) {
  return { uid: user.uid, email: user.email || "", name: user.displayName || "" };
}

function positiveQuantity(value, label) {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`${label} must be greater than zero.`);
  return quantity;
}

function getAvailablePackaging(stock) {
  const raw = valueOf(stock, "available_quantity", "availableQuantity", "current_stock", "currentStock");
  const available = raw === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(available) || available < 0) throw new Error("Packaging stock record has an invalid available quantity.");
  return available;
}

function getProductQuantity(stock) {
  const raw = valueOf(stock, "current_stock", "currentStock", "available_quantity", "availableQuantity", "quantity");
  const quantity = raw === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(quantity) || quantity < 0) throw new Error("Product stock record has an invalid available quantity.");
  return quantity;
}

export async function loadPackagingStock() {
  await requireActiveUser();
  const snapshot = await getDocs(collection(db, "packaging_stock"));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
}

export async function loadPackagingConfigurations() {
  await requireActiveUser();
  const snapshot = await getDocs(query(collection(db, "packaging_configurations"), orderBy("created_at", "desc")));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
}

export async function loadPackagingTransactions() {
  await requireActiveUser();
  const snapshot = await getDocs(query(collection(db, "packaging_transactions"), orderBy("created_at", "desc"), limit(500)));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
}

export async function loadProductStock() {
  await requireActiveUser();
  const snapshot = await getDocs(collection(db, "stock"));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
    .filter((item) => valueOf(item, "product_id", "productId", "product_name", "productName", "product"));
}

export async function loadOutwardRecords() {
  await requireActiveUser();
  const snapshot = await getDocs(query(collection(db, "outward"), orderBy("created_at", "desc"), limit(100)));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
}

export async function savePackagingReceipt(payload) {
  const user = await requireActiveUser();
  const customerName = normalizedName(payload.customer);
  if (!customerName) throw new Error("Select a customer.");
  if (!Array.isArray(payload.materials) || payload.materials.length === 0) throw new Error("Add at least one packaging material.");

  const receiptLines = payload.materials.map((line) => {
    const materialName = normalizedName(line.material);
    const quantity = positiveQuantity(line.quantity, "Received quantity");
    const unit = normalizedName(line.unit);
    if (!materialName) throw new Error("Packaging material is required.");
    if (!unit) throw new Error("Unit is required.");
    return { material_id: packagingEntityId(materialName), material_name: materialName, quantity, unit };
  });
  const customerId = packagingEntityId(customerName);
  const receiptRef = doc(collection(db, "packaging_receipts"));
  const actor = actorFor(user);
  const timestamp = serverTimestamp();
  const stockEntries = new Map();
  receiptLines.forEach((line) => {
    const stockId = packagingStockId(customerId, line.material_id);
    const current = stockEntries.get(stockId);
    if (current && current.unit.toLowerCase() !== line.unit.toLowerCase()) {
      throw new Error(`${line.material_name} has conflicting units in this receipt.`);
    }
    if (current) current.quantity += line.quantity;
    else stockEntries.set(stockId, { ...line, quantity: line.quantity, stockId });
  });

  const stockRefs = [...stockEntries.values()].map((entry) => doc(db, "packaging_stock", entry.stockId));
  const transactionRefs = receiptLines.map((_, index) => doc(db, "packaging_transactions", `${receiptRef.id}_${index + 1}_IN`));
  await runTransaction(db, async (transaction) => {
    const refs = [receiptRef, ...stockRefs, ...transactionRefs];
    const snapshots = await Promise.all(refs.map((reference) => transaction.get(reference)));
    if (snapshots[0].exists()) throw new Error("This packaging receipt already exists.");
    const stockSnapshots = snapshots.slice(1, 1 + stockRefs.length);
    const transactionSnapshots = snapshots.slice(1 + stockRefs.length);
    if (transactionSnapshots.some((snapshot) => snapshot.exists())) throw new Error("This receipt has already been recorded.");

    stockSnapshots.forEach((snapshot, index) => {
      const entry = [...stockEntries.values()][index];
      const previous = snapshot.exists() ? snapshot.data() : {};
      if (snapshot.exists() && String(valueOf(previous, "unit")).toLowerCase() !== entry.unit.toLowerCase()) {
        throw new Error(`${entry.material_name} stock is stored as ${valueOf(previous, "unit") || "an unknown unit"}; the receipt unit does not match.`);
      }
      const available = snapshot.exists() ? getAvailablePackaging(previous) : 0;
      const received = Number(valueOf(previous, "received_quantity", "receivedQuantity") || 0);
      const consumed = Number(valueOf(previous, "consumed_quantity", "consumedQuantity") || 0);
      if (!Number.isFinite(received) || received < 0 || !Number.isFinite(consumed) || consumed < 0) {
        throw new Error("Packaging stock totals are invalid; the receipt was not saved.");
      }
      transaction.set(stockRefs[index], {
        id: entry.stockId,
        customer_id: customerId,
        customer_name: customerName,
        material_id: entry.material_id,
        material_name: entry.material_name,
        unit: entry.unit,
        received_quantity: received + entry.quantity,
        consumed_quantity: consumed,
        available_quantity: available + entry.quantity,
        created_at: valueOf(previous, "created_at", "createdAt") || timestamp,
        updated_at: timestamp,
        last_transaction_id: transactionRefs[receiptLines.findIndex((line) => line.material_id === entry.material_id)]?.id || ""
      }, { merge: true });
    });

    transaction.set(receiptRef, {
      id: receiptRef.id,
      customer_id: customerId,
      customer_name: customerName,
      reference: normalizedName(payload.reference),
      remark: normalizedName(payload.remark),
      materials: receiptLines,
      status: "RECEIVED",
      created_at: timestamp,
      created_by: actor
    });
    receiptLines.forEach((line, index) => {
      transaction.set(transactionRefs[index], {
        id: transactionRefs[index].id,
        customer_id: customerId,
        customer_name: customerName,
        material_id: line.material_id,
        material_name: line.material_name,
        transaction_type: "IN",
        quantity: line.quantity,
        unit: line.unit,
        reference_id: receiptRef.id,
        reference: normalizedName(payload.reference) || receiptRef.id,
        reference_type: "PACKAGING_RECEIPT",
        receipt_id: receiptRef.id,
        created_at: timestamp,
        created_by: actor,
        remark: normalizedName(payload.remark)
      });
    });
  });
  return receiptRef.id;
}

export async function savePackagingConfiguration(configuration) {
  const user = await requireActiveUser();
  const name = normalizedName(configuration.name);
  const customerName = normalizedName(configuration.customer);
  const productName = normalizedName(configuration.product);
  if (!name) throw new Error("Configuration Name is required.");
  if (!customerName) throw new Error("Customer is required.");
  if (!productName) throw new Error("Product is required.");
  if (!Array.isArray(configuration.materials) || configuration.materials.length === 0) {
    throw new Error("At least one packaging material is required.");
  }
  const materials = configuration.materials.map((line) => {
    const materialName = normalizedName(line.material_name || line.material);
    const quantity = positiveQuantity(line.quantity_per_box ?? line.quantity, "Quantity per box");
    const unit = normalizedName(line.unit);
    if (!materialName) throw new Error("Packaging Material is required.");
    if (!unit) throw new Error("Unit is required.");
    return { material_id: packagingEntityId(materialName), material_name: materialName, quantity_per_box: quantity, unit };
  });
  const configurationRef = configuration.id
    ? doc(db, "packaging_configurations", configuration.id)
    : doc(collection(db, "packaging_configurations"));
  const actor = actorFor(user);
  const timestamp = serverTimestamp();
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(configurationRef);
    transaction.set(configurationRef, {
      id: configurationRef.id,
      name,
      customer_id: packagingEntityId(customerName),
      customer_name: customerName,
      product_id: normalizedName(configuration.product_id || "") || null,
      product_name: productName,
      materials,
      status: "ACTIVE",
      active: true,
      created_at: snapshot.exists() ? valueOf(snapshot.data(), "created_at", "createdAt") || timestamp : timestamp,
      updated_at: timestamp,
      created_by: snapshot.exists() ? valueOf(snapshot.data(), "created_by", "createdBy") || actor : actor,
      updated_by: actor
    }, { merge: true });
  });
  return { id: configurationRef.id, name, customer: customerName, product: productName, materials, status: "ACTIVE" };
}

export async function saveOutwardDraft(payload, existingId = "") {
  const user = await requireActiveUser();
  const customerName = normalizedName(payload.customer);
  const productName = normalizedName(payload.product_name);
  const location = normalizedName(payload.location);
  const productStockId = normalizedName(payload.product_stock_id);
  const boxes = Number(payload.number_of_boxes);
  const productQuantity = positiveQuantity(payload.product_quantity, "Product quantity");
  if (!customerName) throw new Error("Customer is required.");
  if (!productName) throw new Error("Product is required.");
  if (!location || !productStockId) throw new Error("Select a valid product stock location.");
  if (!payload.configuration_id) throw new Error("Packaging configuration is required.");
  if (!Number.isInteger(boxes) || boxes <= 0) throw new Error("Number of boxes must be a whole number greater than zero.");
  const outwardRef = existingId ? doc(db, "outward", existingId) : doc(collection(db, "outward"));
  const userRecord = actorFor(user);
  const timestamp = serverTimestamp();
  await runTransaction(db, async (transaction) => {
    const [outwardSnapshot, configurationSnapshot, productStockSnapshot] = await Promise.all([
      transaction.get(outwardRef),
      transaction.get(doc(db, "packaging_configurations", payload.configuration_id)),
      transaction.get(doc(db, "stock", productStockId))
    ]);
    if (outwardSnapshot.exists() && String(valueOf(outwardSnapshot.data(), "status")).toUpperCase() !== "DRAFT") {
      throw new Error("Only a draft Outward can be edited.");
    }
    if (!configurationSnapshot.exists()) throw new Error("The selected packaging configuration no longer exists.");
    if (!productStockSnapshot.exists()) throw new Error("The selected product stock record no longer exists.");
    const recipe = configurationSnapshot.data();
    const stock = productStockSnapshot.data();
    if (valueOf(recipe, "customer_id") !== packagingEntityId(customerName)) throw new Error("Configuration customer does not match the selected customer.");
    if (valueOf(recipe, "product_name") !== productName) throw new Error("Configuration product does not match the selected product.");
    if (valueOf(stock, "receiving_location", "location") !== location) throw new Error("Selected product stock location changed. Refresh and try again.");
    transaction.set(outwardRef, {
      id: outwardRef.id,
      status: "DRAFT",
      customer_id: packagingEntityId(customerName),
      customer_name: customerName,
      product_id: valueOf(stock, "product_id", "productId") || null,
      product_name: productName,
      product_stock_id: productStockId,
      product_quantity: productQuantity,
      product_unit: valueOf(stock, "unit", "quantity_unit", "quantityUnit"),
      receiving_location: location,
      packaging_configuration_id: payload.configuration_id,
      packaging_configuration_name: valueOf(recipe, "name"),
      number_of_boxes: boxes,
      packaging_stock_updated: false,
      created_at: outwardSnapshot.exists() ? valueOf(outwardSnapshot.data(), "created_at", "createdAt") || timestamp : timestamp,
      created_by: outwardSnapshot.exists() ? valueOf(outwardSnapshot.data(), "created_by", "createdBy") || userRecord : userRecord,
      updated_at: timestamp,
      updated_by: userRecord
    }, { merge: true });
  });
  return outwardRef.id;
}

export async function finalizeOutward(outwardId) {
  const user = await requireActiveUser();
  if (!outwardId) throw new Error("Save this Outward as a draft before finalizing.");
  const actor = actorFor(user);
  const outwardRef = doc(db, "outward", outwardId);

  return runTransaction(db, async (transaction) => {
    const outwardSnapshot = await transaction.get(outwardRef);
    if (!outwardSnapshot.exists()) throw new Error("The Outward record was not found.");
    const outward = outwardSnapshot.data();
    const status = String(valueOf(outward, "status")).toUpperCase();
    if (status === "DISPATCHED" && outward.packaging_stock_updated === true) {
      return { id: outwardId, alreadyFinalized: true };
    }
    if (status !== "DRAFT") throw new Error("Only a draft Outward can be finalized.");
    if (outward.packaging_stock_updated === true || valueOf(outward, "packaging_transaction_ids").length) {
      throw new Error("Packaging transactions already exist for this Outward. Contact an administrator before retrying.");
    }

    const boxes = Number(outward.number_of_boxes);
    const productQuantity = positiveQuantity(outward.product_quantity, "Product quantity");
    if (!Number.isInteger(boxes) || boxes <= 0) throw new Error("Number of boxes must be a whole number greater than zero.");
    const configurationRef = doc(db, "packaging_configurations", outward.packaging_configuration_id);
    const productStockRef = doc(db, "stock", outward.product_stock_id);
    const configurationSnapshot = await transaction.get(configurationRef);
    const productStockSnapshot = await transaction.get(productStockRef);
    if (!configurationSnapshot.exists()) throw new Error("The selected packaging configuration no longer exists.");
    if (!productStockSnapshot.exists()) throw new Error("The selected product stock record is missing.");
    const configuration = configurationSnapshot.data();
    const productStock = productStockSnapshot.data();
    if (configuration.active !== true || String(valueOf(configuration, "status")).toUpperCase() !== "ACTIVE") {
      throw new Error("The selected packaging configuration is not active.");
    }
    if (valueOf(configuration, "customer_id") !== outward.customer_id) throw new Error("Configuration customer does not match this Outward.");
    if (valueOf(configuration, "product_name") !== outward.product_name) throw new Error("Configuration product does not match this Outward.");
    const stockProductId = valueOf(productStock, "product_id", "productId");
    const stockProductName = valueOf(productStock, "product_name", "product", "productName");
    const stockLocation = valueOf(productStock, "receiving_location", "location", "receivingLocation");
    const stockUnit = valueOf(productStock, "unit", "quantity_unit", "quantityUnit");
    if (stockProductName !== outward.product_name || stockLocation !== outward.receiving_location) {
      throw new Error("Product stock identity no longer matches the saved Outward.");
    }
    if (outward.product_id && stockProductId && outward.product_id !== stockProductId) throw new Error("Product ID does not match the saved Outward.");
    if (!stockUnit || stockUnit !== outward.product_unit) throw new Error("Product stock unit changed. Refresh and save the draft again.");
    const availableProduct = getProductQuantity(productStock);
    if (availableProduct < productQuantity) throw new Error(`Insufficient product stock. Available: ${availableProduct} ${stockUnit}, Required: ${productQuantity} ${stockUnit}.`);

    const recipeLines = configuration.materials;
    if (!Array.isArray(recipeLines) || recipeLines.length === 0) throw new Error("The packaging configuration has no materials.");
    const materialRequirements = recipeLines.map((line) => {
      const materialName = normalizedName(valueOf(line, "material_name", "material"));
      const materialId = normalizedName(valueOf(line, "material_id")) || packagingEntityId(materialName);
      const perBox = Number(valueOf(line, "quantity_per_box", "quantity"));
      const unit = normalizedName(valueOf(line, "unit"));
      if (!materialName || !materialId || !unit || !Number.isFinite(perBox) || perBox <= 0) {
        throw new Error("The packaging configuration contains a missing material or invalid quantity.");
      }
      return { materialId, materialName, perBox, required: perBox * boxes, unit };
    });
    const seenMaterialIds = new Set();
    materialRequirements.forEach((item) => {
      if (seenMaterialIds.has(item.materialId)) throw new Error(`Configuration repeats ${item.materialName}; edit it to use one material row.`);
      seenMaterialIds.add(item.materialId);
    });

    const packageStockRefs = materialRequirements.map((item) => doc(db, "packaging_stock", packagingStockId(outward.customer_id, item.materialId)));
    const productLedgerId = `${outwardId}_OUT`;
    const productLedgerRef = doc(db, "stockLedger", productLedgerId);
    const packagingTransactionRefs = materialRequirements.map((item) => doc(db, "packaging_transactions", `${outwardId}__${idPart(item.materialId)}__OUT`));
    const readRefs = [...packageStockRefs, productLedgerRef, ...packagingTransactionRefs];
    const readSnapshots = await Promise.all(readRefs.map((reference) => transaction.get(reference)));
    const packageSnapshots = readSnapshots.slice(0, packageStockRefs.length);
    const productLedgerSnapshot = readSnapshots[packageStockRefs.length];
    const packagingTransactionSnapshots = readSnapshots.slice(packageStockRefs.length + 1);
    if (productLedgerSnapshot.exists() || packagingTransactionSnapshots.some((snapshot) => snapshot.exists())) {
      throw new Error("A stock transaction already exists for this Outward. No additional deduction was made.");
    }

    const deductions = materialRequirements.map((requirement, index) => {
      const stockSnapshot = packageSnapshots[index];
      if (!stockSnapshot.exists()) throw new Error(`No packaging stock record exists for ${requirement.materialName} for ${outward.customer_name}.`);
      const stock = stockSnapshot.data();
      if (valueOf(stock, "customer_id") !== outward.customer_id || valueOf(stock, "material_id") !== requirement.materialId) {
        throw new Error(`Packaging stock identity mismatch for ${requirement.materialName}.`);
      }
      const stockUnit = normalizedName(valueOf(stock, "unit"));
      if (stockUnit.toLowerCase() !== requirement.unit.toLowerCase()) {
        throw new Error(`${requirement.materialName} stock is in ${stockUnit || "an unknown unit"}; the configuration requires ${requirement.unit}.`);
      }
      const available = getAvailablePackaging(stock);
      if (available < requirement.required) {
        throw new Error(`Insufficient Packaging Stock. ${requirement.materialName}. Available: ${available}, Required: ${requirement.required}.`);
      }
      const consumedRaw = valueOf(stock, "consumed_quantity", "consumedQuantity");
      const consumed = consumedRaw === "" ? 0 : Number(consumedRaw);
      const receivedRaw = valueOf(stock, "received_quantity", "receivedQuantity");
      const received = receivedRaw === "" ? 0 : Number(receivedRaw);
      if (!Number.isFinite(consumed) || consumed < 0 || !Number.isFinite(received) || received < 0) {
        throw new Error(`Packaging stock totals are invalid for ${requirement.materialName}.`);
      }
      return { ...requirement, available, consumed, received, stockSnapshot, stockRef: packageStockRefs[index], transactionRef: packagingTransactionRefs[index] };
    });

    const currentProductIssuedRaw = valueOf(productStock, "total_issued", "totalIssued");
    const currentProductIssued = currentProductIssuedRaw === "" ? 0 : Number(currentProductIssuedRaw);
    const currentProductReceivedRaw = valueOf(productStock, "total_received", "totalReceived");
    const currentProductReceived = currentProductReceivedRaw === "" ? 0 : Number(currentProductReceivedRaw);
    if (!Number.isFinite(currentProductIssued) || currentProductIssued < 0 || !Number.isFinite(currentProductReceived) || currentProductReceived < 0) {
      throw new Error("Product stock totals are invalid. No stock was changed.");
    }

    const timestamp = serverTimestamp();
    deductions.forEach((item) => {
      transaction.update(item.stockRef, {
        available_quantity: item.available - item.required,
        consumed_quantity: item.consumed + item.required,
        updated_at: timestamp,
        last_transaction_id: item.transactionRef.id
      });
      transaction.set(item.transactionRef, {
        id: item.transactionRef.id,
        customer_id: outward.customer_id,
        customer_name: outward.customer_name,
        material_id: item.materialId,
        material_name: item.materialName,
        transaction_type: "OUT",
        quantity: -item.required,
        unit: item.unit,
        reference_id: outwardId,
        reference: outwardId,
        reference_type: "OUTWARD",
        outward_id: outwardId,
        product_id: outward.product_id || null,
        product_name: outward.product_name,
        packaging_configuration_id: outward.packaging_configuration_id,
        packaging_configuration_name: outward.packaging_configuration_name,
        number_of_boxes: boxes,
        created_at: timestamp,
        created_by: actor,
        remark: "Packaging consumed for finalized Outward."
      });
    });
    const currentProduct = getProductQuantity(productStock);
    transaction.update(productStockRef, {
      current_stock: currentProduct - productQuantity,
      total_issued: currentProductIssued + productQuantity,
      updated_at: timestamp,
      last_transaction_id: productLedgerId
    });
    transaction.set(productLedgerRef, {
      transaction_id: productLedgerId,
      outward_id: outwardId,
      stock_id: productStockRef.id,
      product_id: stockProductId || null,
      product_name: stockProductName,
      location: stockLocation,
      location_id: valueOf(productStock, "receiving_location_id", "location_id", "locationId") || null,
      transaction_type: "OUT",
      quantity: productQuantity,
      unit: stockUnit,
      reference_type: "OUTWARD",
      reference_id: outwardId,
      created_at: timestamp,
      created_by: actor
    });
    transaction.update(outwardRef, {
      status: "DISPATCHED",
      finalized_at: timestamp,
      finalized_by: actor,
      packaging_stock_updated: true,
      packaging_stock_updated_at: timestamp,
      packaging_transaction_ids: deductions.map((item) => item.transactionRef.id),
      product_stock_updated: true,
      product_transaction_id: productLedgerId,
      updated_at: timestamp
    });
    return { id: outwardId, alreadyFinalized: false };
  });
}