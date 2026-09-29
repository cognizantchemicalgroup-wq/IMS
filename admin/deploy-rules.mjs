// Publishes firestore.rules and storage.rules to the live ccpl-ims project
// using the same service-account key as admin/setup.mjs (no `firebase login` needed).
//   GOOGLE_APPLICATION_CREDENTIALS=./service-account.json node admin/deploy-rules.mjs
import { readFileSync } from "node:fs";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getSecurityRules } from "firebase-admin/security-rules";

const BUCKET = "ccpl-ims.firebasestorage.app";
initializeApp({ credential: applicationDefault(), projectId: "ccpl-ims", storageBucket: BUCKET });
const rules = getSecurityRules();
const root = new URL("../", import.meta.url);

const firestore = await rules.releaseFirestoreRulesetFromSource(readFileSync(new URL("firestore.rules", root), "utf8"));
console.log(`Firestore rules published (${firestore.name})`);
const storage = await rules.releaseStorageRulesetFromSource(readFileSync(new URL("storage.rules", root), "utf8"), BUCKET);
console.log(`Storage rules published (${storage.name})`);
console.log("Database and file storage are now locked to active ERP users only.");
