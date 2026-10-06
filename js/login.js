import { auth, db, USING_EMULATOR } from "./firebase-config.js";
import {
  onAuthStateChanged, signInWithCustomToken, signInWithEmailAndPassword, signOut, sendPasswordResetEmail, setPersistence, browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { startSession } from "./core.js";

// DOM elements
const loginForm = document.getElementById("loginForm");
const loginMessage = document.getElementById("loginMessage");
const loginBtn = document.getElementById("loginBtn");

const otpSection = document.getElementById("otpSection");
const otpForm = document.getElementById("otpForm");
const otpInput = document.getElementById("otpInput");
const otpMessage = document.getElementById("otpMessage");
const verifyOtpBtn = document.getElementById("verifyOtpBtn");
const resendOtpBtn = document.getElementById("resendOtpBtn");
const resendTimer = document.getElementById("resendTimer");
const backToLoginBtn = document.getElementById("backToLoginBtn");
const otpEmailTarget = document.getElementById("otpEmailTarget");

function showLoginMsg(text, kind = "error") {
  loginMessage.className = text ? `notice ${kind}` : "";
  loginMessage.textContent = text;
}

function showOtpMsg(text, kind = "error") {
  otpMessage.className = text ? `notice ${kind}` : "";
  otpMessage.textContent = text;
}

if (new URLSearchParams(location.search).get("denied")) {
  showLoginMsg("This account is not authorised for the CCPL ERP, or it has been deactivated.");
}

async function activeProfile(user) {
  const snap = await getDoc(doc(db, "users", user.uid));
  return snap.exists() && snap.data().active === true ? snap.data() : null;
}

let signingIn = false;
onAuthStateChanged(auth, async (user) => {
  if (!user || signingIn) return;
  if (await activeProfile(user).catch(() => null)) {
    window.location.replace("/dashboard");
  } else {
    await signOut(auth);
  }
});

// Current active challenge state
let currentChallenge = null;
let resendInterval = null;

function startResendCountdown(seconds = 60) {
  clearInterval(resendInterval);
  let remaining = seconds;
  resendOtpBtn.disabled = true;
  resendTimer.textContent = remaining;

  resendInterval = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(resendInterval);
      resendOtpBtn.disabled = false;
      resendOtpBtn.textContent = "Resend OTP";
    } else {
      resendTimer.textContent = remaining;
      resendOtpBtn.innerHTML = `Resend OTP (<span id="resendTimer">${remaining}</span>s)`;
    }
  }, 1000);
}

function switchToOtpScreen(data) {
  currentChallenge = {
    challenge_id: data.challenge_id,
    challenge_signature: data.challenge_signature,
    email_masked: data.email_masked
  };

  otpEmailTarget.textContent = data.email_masked || "your registered email";
  showOtpMsg("");
  otpInput.value = "";

  loginForm.style.display = "none";
  otpSection.style.display = "block";

  startResendCountdown(data.resend_cooldown || 60);
  setTimeout(() => otpInput.focus(), 100);
}

function switchToLoginScreen() {
  clearInterval(resendInterval);
  currentChallenge = null;
  otpSection.style.display = "none";
  loginForm.style.display = "block";
  showOtpMsg("");
  loginBtn.disabled = false;
}

// Step 1: Submit credentials to PHP backend
loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = loginForm.email.value.trim();
  const password = loginForm.password.value;

  if (!email || !password) {
    showLoginMsg("Enter your email and password.");
    return;
  }

  loginBtn.disabled = true;
  showLoginMsg("");

  // Local test database only (?emulator=1 → fake "demo-ccpl" project, never live data): there is no PHP / e-mail
  // server, so sign in directly. The live site always goes through the PHP password + e-mail OTP check below.
  if (USING_EMULATOR) {
    signingIn = true;
    try {
      await setPersistence(auth, browserLocalPersistence);
      const { user } = await signInWithEmailAndPassword(auth, email, password);
      const profile = await activeProfile(user);
      if (!profile) { await signOut(auth); showLoginMsg("This account is not authorised for the CCPL ERP, or it has been deactivated."); return; }
      await startSession(user, profile).catch((e) => console.warn("Could not record session", e));
      window.location.replace("/dashboard");
    } catch (error) {
      showLoginMsg(["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found", "auth/invalid-email"].includes(error.code) ? "Incorrect email or password." : `Sign-in failed: ${error.message}`);
    } finally { signingIn = false; loginBtn.disabled = false; }
    return;
  }

  try {
    const res = await fetch("api/login.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });

    let data;
    try {
      data = await res.json();
    } catch {
      data = { error: `Server error (HTTP ${res.status}). Check server configuration.` };
    }

    if (!res.ok || !data.success) {
      showLoginMsg(data.error || `Sign-in failed (HTTP ${res.status}). Check credentials and try again.`);
      return;
    }

    switchToOtpScreen(data);
  } catch (error) {
    console.error("Login request error:", error);
    showLoginMsg("Network error connecting to CCPL server: " + (error.message || "Please check connection."));
  } finally {
    loginBtn.disabled = false;
  }
});

// Step 2: Submit OTP for verification and receive Firebase Custom Token
otpForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentChallenge) {
    switchToLoginScreen();
    showLoginMsg("Login session timed out. Please sign in again.");
    return;
  }

  const otp = otpInput.value.trim();
  if (!otp || !/^[0-9]{6}$/.test(otp)) {
    showOtpMsg("Please enter the complete 6-digit code.");
    otpInput.focus();
    return;
  }

  signingIn = true;
  verifyOtpBtn.disabled = true;
  showOtpMsg("");

  try {
    const res = await fetch("api/verify-otp.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challenge_id: currentChallenge.challenge_id,
        challenge_signature: currentChallenge.challenge_signature,
        otp
      })
    });

    let data;
    try {
      data = await res.json();
    } catch {
      data = { error: `Server error (HTTP ${res.status}). Check server configuration.` };
    }

    if (!res.ok || !data.success) {
      showOtpMsg(data.error || `Verification failed (HTTP ${res.status}). Check the code and try again.`);
      if (data.session_expired || data.attempts_exceeded) {
        setTimeout(() => {
          switchToLoginScreen();
          showLoginMsg(data.error || "Session expired. Please sign in again.");
        }, 2000);
      }
      return;
    }

    // OTP Verified -> Establish client Firebase authenticated session via Custom Token
    const customToken = data.custom_token;
    await setPersistence(auth, browserLocalPersistence);
    const userCredential = await signInWithCustomToken(auth, customToken);
    const user = userCredential.user;

    const profile = await activeProfile(user);
    if (!profile) {
      await signOut(auth);
      switchToLoginScreen();
      showLoginMsg("This account is not authorised for the CCPL ERP, or it has been deactivated.");
      return;
    }

    await startSession(user, profile).catch((e) => console.warn("Could not record session", e));
    window.location.replace("/dashboard");
  } catch (error) {
    console.error("OTP verification error:", error);
    showOtpMsg("Verification failed. Please check your connection and try again.");
  } finally {
    signingIn = false;
    verifyOtpBtn.disabled = false;
  }
});

// Resend OTP
resendOtpBtn.addEventListener("click", async () => {
  if (!currentChallenge || resendOtpBtn.disabled) return;

  resendOtpBtn.disabled = true;
  showOtpMsg("");

  try {
    const res = await fetch("api/resend-otp.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challenge_id: currentChallenge.challenge_id,
        challenge_signature: currentChallenge.challenge_signature
      })
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.success) {
      showOtpMsg(data.error || "Failed to resend code.");
      if (data.cooldown) {
        startResendCountdown(data.cooldown);
      } else if (data.session_expired) {
        setTimeout(switchToLoginScreen, 1500);
      }
      return;
    }

    // Update signature for renewed expiry
    currentChallenge.challenge_signature = data.challenge_signature;
    startResendCountdown(data.resend_cooldown || 60);
    showOtpMsg("A new verification code has been sent to your email.", "ok");
    otpInput.value = "";
    otpInput.focus();
  } catch (error) {
    console.error("Resend error:", error);
    showOtpMsg("Could not request a new code. Check your internet connection.");
    resendOtpBtn.disabled = false;
  }
});

// Back to login button
backToLoginBtn.addEventListener("click", () => {
  switchToLoginScreen();
});

// Forgot password reset
document.getElementById("resetBtn").addEventListener("click", async () => {
  const email = loginForm.email.value.trim();
  if (!email) {
    showLoginMsg("Enter your email above, then click “Forgot password?” again.");
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
  } catch (error) {
    console.warn(error);
  }
  showLoginMsg("If this email belongs to an ERP user, a password reset link has been sent.", "info");
});
