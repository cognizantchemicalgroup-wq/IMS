import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyASaR4XRhIgrSMAgvHGaLpxfCKMKvDLLro",
  authDomain: "ccpl-ims.firebaseapp.com",
  projectId: "ccpl-ims",
  storageBucket: "ccpl-ims.firebasestorage.app",
  messagingSenderId: "477570894491",
  appId: "1:477570894491:web:bafaf6d719303eabbc143e",
  measurementId: "G-9ZMMEDKWB6"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);