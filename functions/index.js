import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";

initializeApp();
const db = getFirestore();
const region = "us-central1";

function valueOf(record, ...keys) {
  for (const key of keys) {
    if (record?.[key] !== undefined && record[key] !== null && record[key] !== "") return record[key];
  }
  return "";
}

function normalized(value) {
  return String(value ?? "").trim().normalize("NFKC");
}

function idPart(value) {
  const encoded = encodeURIComponent(normalized(value).toLowerCase());
  return `${encoded.length}_${encoded}`;
}

function packageStockId(customerId, materialId) {
  return `${idPart(customerId)}__${idPart(materialId)}`;
}

function entityId(value) {
  return idPart(value);
}

function positiveQuantity(value, label) {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity <= 0) throw new HttpsError("invalid-argument", `${label} must be greater than zero.`);
  return quantity;
}

function authorizedError(error) {
  if (error instanceof HttpsError) return error;
  console.error("Packaging workflow request failed.", error);
  if (error?.code === "permission-denied" || error?.code === "unauthenticated") {
    return new HttpsError("permission-denied", "Your account does not have access to this packaging workflow.");
  }
  return new HttpsError("failed-precondition", error?.message || "The packaging operation could not be completed.");
}

function call(handler) {
  return onCall({ region, enforceAppCheck: false }, async (request) => {
    try {
      if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Sign in to CCPL IMS to continue.");
      const token = request.auth.token;
      const email = String(token.email || "").trim();
      if (!email) throw new HttpsError("permission-denied", "An authorized CCPL IMS account is required.");
      const matchingUsers = await db.collection("users").where("email", "==", email).limit(1).get();
      let active = !matchingUsers.empty && matchingUsers.docs[0].data().active === true;
      if (!active) {
        const emailUser = await db.collection("users").doc(email).get();
        active = emailUser.exists && emailUser.data().active === true;
      }
      if (!active) throw new HttpsError("permission-denied", "Access denied. Your account is not authorized to access CCPL IMS.");
      return await handler(request.data || {}, { uid: request.auth.uid, email, name: String(token.name || "") });
    } catch (error) {
      throw authorizedError(error);
    }
  });
}

function stockAvailable(stock) {
  const raw = valueOf(stock, "available_quantity", "availableQuantity", "current_stock", "currentStock");
  const quantity = raw === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(quantity) || quantity < 0) throw new HttpsError("failed-precondition", "Packaging stock has an invalid available quantity.");
  return quantity;
}

function productAvailable(stock) {
  const raw = valueOf(stock, "current_stock", "currentStock", "available_quantity", "availableQuantity", "quantity");
  const quantity = raw === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(quantity) || quantity < 0) throw new HttpsError("failed-precondition", "Product stock has an invalid available quantity.");
  return quantity;
}

function actor(user) {
  return { uid: user.uid, email: user.email, name: user.name };
}

export const getPackagingData = call(async (data) => {
  const datasets = {
    stock: ["packaging_stock", 0],
    configurations: ["packaging_configurations", 500],
    transactions: ["packaging_transactions", 1000],
    productStock: ["stock", 0],
    outwards: ["outward", 500]
  };
  const requested = String(data.dataset || "");
  if (!datasets[requested]) throw new HttpsError("invalid-argument", "Unknown packaging data request.");
  const [collectionName, maxRecords] = datasets[requested];
  let firestoreQuery = db.collection(collectionName);
  if (requested === "transactions" || requested === "configurations" || requested === "outwards") {
    firestoreQuery = firestoreQuery.orderBy("created_at", "desc");
  }
  if (maxRecords) firestoreQuery = firestoreQuery.limit(maxRecords);
  const snapshot = await firestoreQuery.get();
  return { records: snapshot.docs.map((document) => ({ id: document.id, ...document.data() })) };
});

export const receivePackaging = call(async (data, user) => {
  const customerName = normalized(data.customer);
  if (!customerName) throw new HttpsError("invalid-argument", "Customer is required.");
  if (!Array.isArray(data.materials) || data.materials.length === 0) throw new HttpsError("invalid-argument", "At least one packaging material is required.");
  const customerId = entityId(customerName);
  const materials = data.materials.map((line) => {
    const materialName = normalized(line.material);
    const quantity = positiveQuantity(line.quantity, "Received quantity");
    const unit = normalized(line.unit);
    if (!materialName) throw new HttpsError("invalid-argument", "Packaging material is required.");
    if (!unit) throw new HttpsError("invalid-argument", "Unit is required.");
    return { material_id: entityId(materialName), material_name: materialName, quantity, unit };
  });
  const receiptRef = db.collection("packaging_receipts").doc();
  const receiptLines = materials.map((line, index) => ({ ...line, index, transactionId: `${receiptRef.id}_${index + 1}_IN` }));
  const aggregates = new Map();
  receiptLines.forEach((line) => {
    const stockId = packageStockId(customerId, line.material_id);
    const current = aggregates.get(stockId);
    if (current && current.unit.toLowerCase() !== line.unit.toLowerCase()) {
      throw new HttpsError("invalid-argument", `${line.material_name} has conflicting units in this receipt.`);
    }
    if (current) current.quantity += line.quantity;
    else aggregates.set(stockId, { stockId, customerId, customerName, ...line, quantity: line.quantity });
  });
  const stockRefs = [...aggregates.values()].map((entry) => db.collection("packaging_stock").doc(entry.stockId));
  const transactionRefs = receiptLines.map((line) => db.collection("packaging_transactions").doc(line.transactionId));
  await db.runTransaction(async (transaction) => {
    const readRefs = [...stockRefs, ...transactionRefs];
    const snapshots = readRefs.length ? await transaction.getAll(...readRefs) : [];
    const stockSnapshots = snapshots.slice(0, stockRefs.length);
    if (snapshots.slice(stockRefs.length).some((snapshot) => snapshot.exists)) {
      throw new HttpsError("already-exists", "This packaging receipt has already been recorded.");
    }
    const timestamp = FieldValue.serverTimestamp();
    stockSnapshots.forEach((snapshot, index) => {
      const entry = [...aggregates.values()][index];
      const prior = snapshot.exists ? snapshot.data() : {};
      if (snapshot.exists && normalized(valueOf(prior, "unit")).toLowerCase() !== entry.unit.toLowerCase()) {
        throw new HttpsError("failed-precondition", `${entry.material_name} stock uses a different unit.`);
      }
      const available = snapshot.exists ? stockAvailable(prior) : 0;
      const received = Number(valueOf(prior, "received_quantity", "receivedQuantity") || 0);
      const consumed = Number(valueOf(prior, "consumed_quantity", "consumedQuantity") || 0);
      if (!Number.isFinite(received) || received < 0 || !Number.isFinite(consumed) || consumed < 0) {
        throw new HttpsError("failed-precondition", "Existing packaging stock totals are invalid.");
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
        created_at: valueOf(prior, "created_at", "createdAt") || timestamp,
        updated_at: timestamp,
        last_transaction_id: entry.transactionId
      }, { merge: true });
    });
    transaction.create(receiptRef, {
      id: receiptRef.id,
      customer_id: customerId,
      customer_name: customerName,
      reference: normalized(data.reference),
      remark: normalized(data.remark),
      materials: receiptLines.map(({ index, transactionId, ...line }) => line),
      status: "RECEIVED",
      created_at: timestamp,
      created_by: actor(user)
    });
    receiptLines.forEach((line, index) => {
      const transactionRef = transactionRefs[index];
      transaction.create(transactionRef, {
        id: transactionRef.id,
        customer_id: customerId,
        customer_name: customerName,
        material_id: line.material_id,
        material_name: line.material_name,
        transaction_type: "IN",
        quantity: line.quantity,
        unit: line.unit,
        reference_id: receiptRef.id,
        reference: normalized(data.reference) || receiptRef.id,
        reference_type: "PACKAGING_RECEIPT",
        receipt_id: receiptRef.id,
        created_at: timestamp,
        created_by: actor(user),
        remark: normalized(data.remark)
      });
    });
  });
  return { receiptId: receiptRef.id };
});

export const savePackagingConfiguration = call(async (data, user) => {
  const name = normalized(data.name);
  const customerName = normalized(data.customer);
  const productName = normalized(data.product);
  if (!name) throw new HttpsError("invalid-argument", "Configuration Name is required.");
  if (!customerName) throw new HttpsError("invalid-argument", "Customer is required.");
  if (!productName) throw new HttpsError("invalid-argument", "Product is required.");
  if (!Array.isArray(data.materials) || !data.materials.length) throw new HttpsError("invalid-argument", "At least one packaging material is required.");
  const materials = data.materials.map((line) => {
    const materialName = normalized(line.material_name || line.material);
    const quantity = positiveQuantity(line.quantity_per_box ?? line.quantity, "Quantity per box");
    const unit = normalized(line.unit);
    if (!materialName) throw new HttpsError("invalid-argument", "Packaging material is required.");
    if (!unit) throw new HttpsError("invalid-argument", "Packaging material unit is required.");
    return { material_id: entityId(materialName), material_name: materialName, quantity_per_box: quantity, unit };
  });
  if (new Set(materials.map((line) => line.material_id)).size !== materials.length) {
    throw new HttpsError("invalid-argument", "A material can appear only once in a configuration.");
  }
  const configurationRef = data.id
    ? db.collection("packaging_configurations").doc(String(data.id))
    : db.collection("packaging_configurations").doc();
  const productId = normalized(data.product_id);
  const productQuery = productId
    ? db.collection("stock").where("product_id", "==", productId).limit(1)
    : db.collection("stock").where("product_name", "==", productName).limit(1);
  const customerId = entityId(customerName);
  const materialStockRefs = materials.map((material) => db.collection("packaging_stock").doc(packageStockId(customerId, material.material_id)));
  await db.runTransaction(async (transaction) => {
    const [existing, matchingProduct, ...materialStockSnapshots] = await Promise.all([
      transaction.get(configurationRef),
      transaction.get(productQuery),
      ...materialStockRefs.map((reference) => transaction.get(reference))
    ]);
    if (matchingProduct.empty) throw new HttpsError("failed-precondition", "Choose a product that exists in Product Inventory.");
    materialStockSnapshots.forEach((snapshot, index) => {
      const material = materials[index];
      if (!snapshot.exists) throw new HttpsError("failed-precondition", `${material.material_name} has not been received for ${customerName}.`);
      const stock = snapshot.data();
      if (stock.customer_id !== customerId || stock.material_id !== material.material_id) {
        throw new HttpsError("failed-precondition", `Packaging stock ownership does not match ${customerName} for ${material.material_name}.`);
      }
      if (normalized(stock.unit).toLowerCase() !== material.unit.toLowerCase()) {
        throw new HttpsError("failed-precondition", `${material.material_name} is stocked in ${stock.unit || "an unknown unit"}; the recipe uses ${material.unit}.`);
      }
    });
    const timestamp = FieldValue.serverTimestamp();
    transaction.set(configurationRef, {
      id: configurationRef.id,
      name,
      customer_id: customerId,
      customer_name: customerName,
      product_id: productId || valueOf(matchingProduct.docs[0].data(), "product_id", "productId") || null,
      product_name: productName,
      materials,
      status: "ACTIVE",
      active: true,
      created_at: existing.exists ? valueOf(existing.data(), "created_at", "createdAt") || timestamp : timestamp,
      created_by: existing.exists ? valueOf(existing.data(), "created_by", "createdBy") || actor(user) : actor(user),
      updated_at: timestamp,
      updated_by: actor(user)
    }, { merge: true });
  });
  return { id: configurationRef.id };
});

export const saveOutwardDraft = call(async (data, user) => {
  const customerName = normalized(data.customer);
  const productName = normalized(data.product_name);
  const location = normalized(data.location);
  const productStockId = normalized(data.product_stock_id);
  const boxes = Number(data.number_of_boxes);
  const productQuantity = positiveQuantity(data.product_quantity, "Product quantity");
  if (!customerName) throw new HttpsError("invalid-argument", "Customer is required.");
  if (!productName) throw new HttpsError("invalid-argument", "Product is required.");
  if (!location || !productStockId) throw new HttpsError("invalid-argument", "Select a product stock location.");
  if (!data.configuration_id) throw new HttpsError("invalid-argument", "Packaging configuration is required.");
  if (!Number.isInteger(boxes) || boxes <= 0) throw new HttpsError("invalid-argument", "Number of boxes must be a whole number greater than zero.");
  const outwardRef = data.id ? db.collection("outward").doc(String(data.id)) : db.collection("outward").doc();
  const configurationRef = db.collection("packaging_configurations").doc(String(data.configuration_id));
  const productStockRef = db.collection("stock").doc(productStockId);
  await db.runTransaction(async (transaction) => {
    const [outwardSnapshot, configurationSnapshot, stockSnapshot] = await transaction.getAll(outwardRef, configurationRef, productStockRef);
    if (outwardSnapshot.exists && String(valueOf(outwardSnapshot.data(), "status")).toUpperCase() !== "DRAFT") {
      throw new HttpsError("failed-precondition", "Only a draft Outward can be edited.");
    }
    if (!configurationSnapshot.exists || !stockSnapshot.exists) throw new HttpsError("not-found", "The selected configuration or product stock record no longer exists.");
    const configuration = configurationSnapshot.data();
    const stock = stockSnapshot.data();
    if (configuration.active !== true || String(valueOf(configuration, "status")).toUpperCase() !== "ACTIVE") {
      throw new HttpsError("failed-precondition", "The selected packaging configuration is not active.");
    }
    if (valueOf(configuration, "customer_id") !== entityId(customerName)) throw new HttpsError("failed-precondition", "Configuration customer does not match the selected customer.");
    if (valueOf(configuration, "product_name") !== productName) throw new HttpsError("failed-precondition", "Configuration product does not match the selected product.");
    if (valueOf(stock, "receiving_location", "location") !== location) throw new HttpsError("failed-precondition", "The selected stock location does not match the product stock record.");
    const stockProductName = normalized(valueOf(stock, "product_name", "product", "productName"));
    if (stockProductName !== productName) throw new HttpsError("failed-precondition", "The selected product does not match the product stock record.");
    const timestamp = FieldValue.serverTimestamp();
    transaction.set(outwardRef, {
      id: outwardRef.id,
      status: "DRAFT",
      customer_id: entityId(customerName),
      customer_name: customerName,
      product_id: valueOf(stock, "product_id", "productId") || null,
      product_name: productName,
      product_stock_id: productStockId,
      product_quantity: productQuantity,
      product_unit: valueOf(stock, "unit", "quantity_unit", "quantityUnit"),
      receiving_location: location,
      packaging_configuration_id: configurationRef.id,
      packaging_configuration_name: valueOf(configuration, "name"),
      packaging_configuration_updated_at: valueOf(configuration, "updated_at", "updatedAt") || null,
      number_of_boxes: boxes,
      packaging_stock_updated: false,
      created_at: outwardSnapshot.exists ? valueOf(outwardSnapshot.data(), "created_at", "createdAt") || timestamp : timestamp,
      created_by: outwardSnapshot.exists ? valueOf(outwardSnapshot.data(), "created_by", "createdBy") || actor(user) : actor(user),
      updated_at: timestamp,
      updated_by: actor(user)
    }, { merge: true });
  });
  return { outwardId: outwardRef.id };
});

export const finalizeOutward = call(async (data, user) => {
  const outwardId = normalized(data.outward_id);
  if (!outwardId) throw new HttpsError("invalid-argument", "Save this Outward as a draft before finalizing.");
  const outwardRef = db.collection("outward").doc(outwardId);
  return db.runTransaction(async (transaction) => {
    const outwardSnapshot = await transaction.get(outwardRef);
    if (!outwardSnapshot.exists) throw new HttpsError("not-found", "The Outward record was not found.");
    const outward = outwardSnapshot.data();
    const currentStatus = String(valueOf(outward, "status")).toUpperCase();
    if (currentStatus === "DISPATCHED" && outward.packaging_stock_updated === true && outward.product_stock_updated === true) {
      return { outwardId, alreadyFinalized: true };
    }
    if (currentStatus !== "DRAFT") throw new HttpsError("failed-precondition", "Only a draft Outward can be finalized.");
    const boxes = Number(outward.number_of_boxes);
    if (!Number.isInteger(boxes) || boxes <= 0) throw new HttpsError("invalid-argument", "Number of boxes must be a whole number greater than zero.");
    const productQuantity = positiveQuantity(outward.product_quantity, "Product quantity");
    const configurationRef = db.collection("packaging_configurations").doc(String(outward.packaging_configuration_id || ""));
    const productStockRef = db.collection("stock").doc(String(outward.product_stock_id || ""));
    const [configurationSnapshot, productStockSnapshot] = await transaction.getAll(configurationRef, productStockRef);
    if (!configurationSnapshot.exists) throw new HttpsError("not-found", "The packaging configuration was not found.");
    if (!productStockSnapshot.exists) throw new HttpsError("not-found", "The product stock record was not found.");
    const configuration = configurationSnapshot.data();
    const productStock = productStockSnapshot.data();
    if (configuration.active !== true || String(valueOf(configuration, "status")).toUpperCase() !== "ACTIVE") throw new HttpsError("failed-precondition", "The packaging configuration is not active.");
    if (valueOf(configuration, "customer_id") !== outward.customer_id) throw new HttpsError("failed-precondition", "Configuration customer does not match this Outward.");
    if (valueOf(configuration, "product_name") !== outward.product_name) throw new HttpsError("failed-precondition", "Configuration product does not match this Outward.");
    const savedRecipeVersion = outward.packaging_configuration_updated_at;
    const currentRecipeVersion = valueOf(configuration, "updated_at", "updatedAt");
    if (savedRecipeVersion && currentRecipeVersion) {
      const savedMillis = typeof savedRecipeVersion.toMillis === "function" ? savedRecipeVersion.toMillis() : new Date(savedRecipeVersion).getTime();
      const currentMillis = typeof currentRecipeVersion.toMillis === "function" ? currentRecipeVersion.toMillis() : new Date(currentRecipeVersion).getTime();
      if (!Number.isFinite(savedMillis) || !Number.isFinite(currentMillis) || savedMillis !== currentMillis) {
        throw new HttpsError("failed-precondition", "The packaging configuration changed after this draft was saved. Re-save the draft and review its requirements.");
      }
    }
    const stockProductName = normalized(valueOf(productStock, "product_name", "product", "productName"));
    const stockLocation = normalized(valueOf(productStock, "receiving_location", "location", "receivingLocation"));
    const stockProductId = valueOf(productStock, "product_id", "productId");
    const productUnit = normalized(valueOf(productStock, "unit", "quantity_unit", "quantityUnit"));
    if (stockProductName !== outward.product_name || stockLocation !== outward.receiving_location) throw new HttpsError("failed-precondition", "Product stock identity does not match this Outward.");
    if (outward.product_id && stockProductId && outward.product_id !== stockProductId) throw new HttpsError("failed-precondition", "Product ID does not match this Outward.");
    if (!productUnit || productUnit !== outward.product_unit) throw new HttpsError("failed-precondition", "Product stock unit changed. Re-save the draft before finalizing.");
    const availableProduct = productAvailable(productStock);
    if (availableProduct < productQuantity) throw new HttpsError("failed-precondition", `Insufficient product stock. Available: ${availableProduct} ${productUnit}, Required: ${productQuantity} ${productUnit}.`);
    if (!Array.isArray(configuration.materials) || configuration.materials.length === 0) throw new HttpsError("failed-precondition", "The packaging configuration has no materials.");

    const requirements = configuration.materials.map((line) => {
      const materialName = normalized(valueOf(line, "material_name", "material"));
      const materialId = normalized(valueOf(line, "material_id")) || entityId(materialName);
      const perBox = Number(valueOf(line, "quantity_per_box", "quantity"));
      const unit = normalized(valueOf(line, "unit"));
      if (!materialName || !unit || !Number.isFinite(perBox) || perBox <= 0) throw new HttpsError("failed-precondition", "The packaging configuration contains invalid materials or quantities.");
      return { materialName, materialId, perBox, quantity: perBox * boxes, unit };
    });
    if (new Set(requirements.map((item) => item.materialId)).size !== requirements.length) throw new HttpsError("failed-precondition", "The packaging configuration contains duplicate materials.");
    const stockRefs = requirements.map((item) => db.collection("packaging_stock").doc(packageStockId(outward.customer_id, item.materialId)));
    const productLedgerId = `${outwardId}_OUT`;
    const productLedgerRef = db.collection("stockLedger").doc(productLedgerId);
    const packagingTransactionRefs = requirements.map((item) => db.collection("packaging_transactions").doc(`${outwardId}__${idPart(item.materialId)}__OUT`));
    const readRefs = [...stockRefs, productLedgerRef, ...packagingTransactionRefs];
    const snapshots = await transaction.getAll(...readRefs);
    const packagingStockSnapshots = snapshots.slice(0, stockRefs.length);
    const productLedgerSnapshot = snapshots[stockRefs.length];
    const packagingTransactionSnapshots = snapshots.slice(stockRefs.length + 1);
    if (productLedgerSnapshot.exists || packagingTransactionSnapshots.some((snapshot) => snapshot.exists)) {
      throw new HttpsError("already-exists", "A stock transaction already exists for this Outward. No further deduction was made.");
    }

    const deductions = requirements.map((requirement, index) => {
      const snapshot = packagingStockSnapshots[index];
      if (!snapshot.exists) throw new HttpsError("failed-precondition", `No packaging stock record exists for ${requirement.materialName} for ${outward.customer_name}.`);
      const stock = snapshot.data();
      if (stock.customer_id !== outward.customer_id || stock.material_id !== requirement.materialId) throw new HttpsError("failed-precondition", `Customer packaging stock identity mismatch for ${requirement.materialName}.`);
      const stockUnit = normalized(stock.unit);
      if (stockUnit.toLowerCase() !== requirement.unit.toLowerCase()) throw new HttpsError("failed-precondition", `${requirement.materialName} stock uses ${stockUnit || "an unknown unit"}; the recipe requires ${requirement.unit}.`);
      const available = stockAvailable(stock);
      if (available < requirement.quantity) throw new HttpsError("failed-precondition", `Insufficient Packaging Stock. ${requirement.materialName}. Available: ${available}, Required: ${requirement.quantity}.`);
      const consumed = Number(valueOf(stock, "consumed_quantity", "consumedQuantity") || 0);
      const received = Number(valueOf(stock, "received_quantity", "receivedQuantity") || 0);
      if (!Number.isFinite(consumed) || consumed < 0 || !Number.isFinite(received) || received < 0) throw new HttpsError("failed-precondition", `Packaging stock totals are invalid for ${requirement.materialName}.`);
      return { ...requirement, available, consumed, stockRef: stockRefs[index], transactionRef: packagingTransactionRefs[index] };
    });
    const totalIssued = Number(valueOf(productStock, "total_issued", "totalIssued") || 0);
    const totalReceived = Number(valueOf(productStock, "total_received", "totalReceived") || 0);
    if (!Number.isFinite(totalIssued) || totalIssued < 0 || !Number.isFinite(totalReceived) || totalReceived < 0) throw new HttpsError("failed-precondition", "Product stock totals are invalid.");

    const timestamp = FieldValue.serverTimestamp();
    const userActor = actor(user);
    deductions.forEach((item) => {
      transaction.update(item.stockRef, {
        available_quantity: item.available - item.quantity,
        consumed_quantity: item.consumed + item.quantity,
        updated_at: timestamp,
        last_transaction_id: item.transactionRef.id
      });
      transaction.create(item.transactionRef, {
        id: item.transactionRef.id,
        customer_id: outward.customer_id,
        customer_name: outward.customer_name,
        material_id: item.materialId,
        material_name: item.materialName,
        transaction_type: "OUT",
        quantity: -item.quantity,
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
        created_by: userActor,
        remark: "Packaging consumed for finalized Outward."
      });
    });
    transaction.update(productStockRef, {
      current_stock: availableProduct - productQuantity,
      total_issued: totalIssued + productQuantity,
      updated_at: timestamp,
      last_transaction_id: productLedgerId
    });
    transaction.create(productLedgerRef, {
      transaction_id: productLedgerId,
      outward_id: outwardId,
      stock_id: productStockRef.id,
      product_id: stockProductId || null,
      product_name: stockProductName,
      location: stockLocation,
      location_id: valueOf(productStock, "receiving_location_id", "location_id", "locationId") || null,
      transaction_type: "OUT",
      quantity: productQuantity,
      unit: productUnit,
      reference_type: "OUTWARD",
      reference_id: outwardId,
      created_at: timestamp,
      created_by: userActor
    });
    transaction.update(outwardRef, {
      status: "DISPATCHED",
      finalized_at: timestamp,
      finalized_by: userActor,
      packaging_stock_updated: true,
      packaging_stock_updated_at: timestamp,
      packaging_transaction_ids: deductions.map((item) => item.transactionRef.id),
      product_stock_updated: true,
      product_transaction_id: productLedgerId,
      updated_at: timestamp
    });
    return { outwardId, alreadyFinalized: false };
  });
});

export const cancelOutwardDraft = call(async (data) => {
  const outwardId = normalized(data.outward_id);
  if (!outwardId) throw new HttpsError("invalid-argument", "Outward ID is required.");
  const outwardRef = db.collection("outward").doc(outwardId);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(outwardRef);
    if (!snapshot.exists) throw new HttpsError("not-found", "The Outward record was not found.");
    if (String(valueOf(snapshot.data(), "status")).toUpperCase() !== "DRAFT") throw new HttpsError("failed-precondition", "Only a draft Outward can be cancelled.");
    transaction.update(outwardRef, { status: "CANCELLED", cancelled_at: FieldValue.serverTimestamp() });
  });
  return { outwardId, cancelled: true };
});

export const getPackagingStockHistory = call(async (data) => {
  let historyQuery = db.collection("packaging_transactions").orderBy("created_at", "desc");
  if (data.customer_id) historyQuery = historyQuery.where("customer_id", "==", String(data.customer_id));
  if (data.material_id) historyQuery = historyQuery.where("material_id", "==", String(data.material_id));
  if (data.transaction_type) historyQuery = historyQuery.where("transaction_type", "==", String(data.transaction_type).toUpperCase());
  const snapshot = await historyQuery.limit(1000).get();
  return { records: snapshot.docs.map((document) => ({ id: document.id, ...document.data() })) };
});

