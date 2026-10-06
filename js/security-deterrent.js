// This is only a frontend deterrent; it cannot protect or hide source code from determined users.
document.addEventListener("contextmenu", (event) => {
  event.preventDefault();
}, true);

document.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  const blockedShortcut = event.key === "F12"
    || (event.ctrlKey && ((event.shiftKey && ["i", "j", "c"].includes(key)) || (key === "u" && !event.shiftKey)))
    || (event.metaKey && event.altKey && ["i", "j", "c", "u"].includes(key));

  if (blockedShortcut) event.preventDefault();
}, true);