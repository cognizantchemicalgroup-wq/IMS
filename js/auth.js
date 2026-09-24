import { auth, db } from "./firebase-config.js";
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection,
  doc,
  getDocs,
  getDoc,
  limit,
  query,
  where
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const loginPage = document.body.dataset.authPage === "login";
const googleButton = document.getElementById("googleSignIn");
const authMessage = document.getElementById("authMessage");
const provider = new GoogleAuthProvider();

function setMessage(message, isError = true) {
  if (!authMessage) return;
  authMessage.textContent = message;
  authMessage.classList.toggle("is-error", isError && Boolean(message));
}

async function isAuthorized(user) {
  const usersQuery = query(
    collection(db, "users"),
    where("email", "==", user.email),
    limit(1)
  );
  const snapshot = await getDocs(usersQuery);
  if (!snapshot.empty) return snapshot.docs[0].data().active === true;

  const emailDocument = await getDoc(doc(db, "users", user.email));
  return emailDocument.exists() && emailDocument.data().active === true;
}

function publishUser(user) {
  window.CCPLUser = {
    displayName: user.displayName || "",
    email: user.email || "",
    photoURL: user.photoURL || ""
  };
  window.dispatchEvent(new CustomEvent("ccpl-authenticated", { detail: window.CCPLUser }));
}

async function rejectUser(message) {
  await signOut(auth);
  setMessage(message);
}

async function handleAuthenticatedUser(user) {
  if (!user) {
    if (!loginPage) window.location.replace("index.html");
    return;
  }

  try {
    const authorized = await isAuthorized(user);
    if (!authorized) {
      await rejectUser("Access denied. Your Google account is not authorized to access CCPL IMS.");
      if (!loginPage) window.location.replace("index.html");
      return;
    }

    publishUser(user);
    if (loginPage) window.location.replace("dashboard.html");
  } catch (error) {
    console.error("Unable to verify CCPL IMS access.", error);
    await rejectUser("We could not verify your access right now. Please try again.");
  }
}

if (googleButton) {
  googleButton.addEventListener("click", async () => {
    googleButton.disabled = true;
    setMessage("");

    try {
      const result = await signInWithPopup(auth, provider);
      await handleAuthenticatedUser(result.user);
    } catch (error) {
      console.error("Google sign-in failed.", error);
      if (error.code === "auth/popup-closed-by-user") return;
      if (error.code === "auth/unauthorized-domain" || window.location.protocol === "file:") {
        setMessage("Open CCPL IMS through a web server, such as http://localhost:5500. Google sign-in cannot run from a file opened directly.");
      } else if (error.code === "auth/popup-blocked") {
        setMessage("Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.");
      } else {
        setMessage("Sign-in could not be completed. Please try again.");
      }
    } finally {
      googleButton.disabled = false;
    }
  });
}

onAuthStateChanged(auth, handleAuthenticatedUser);

export async function logout() {
  await signOut(auth);
  window.location.replace("index.html");
}

window.CCPLAuth = { logout };
