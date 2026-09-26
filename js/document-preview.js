export function initDocumentPreview() {
  const modal = document.getElementById("documentPreviewModal");
  const titleElement = document.getElementById("documentPreviewTitle");
  const content = document.getElementById("documentPreviewContent");
  const closeButton = document.getElementById("closeDocumentPreview");
  const closeFooterButton = document.getElementById("closeDocumentPreviewFooter");
  const downloadButton = document.getElementById("downloadDocumentPreview");
  let message = null;
  let previousFocus = null;
  let activeUrl = "";
  let activeTitle = "";

  function fileExtension(url) {
    try {
      const path = decodeURIComponent(new URL(url, window.location.href).pathname);
      return path.split("/").pop().split(".").pop().toLowerCase();
    } catch {
      return "";
    }
  }

  function closeDocumentPreview() {
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
    content.replaceChildren();
    message = null;
    downloadButton.hidden = true;
    document.body.style.overflow = "";
    if (previousFocus?.isConnected) previousFocus.focus();
    previousFocus = null;
    activeUrl = "";
    activeTitle = "";
  }

  function openDocumentPreview(url, title = "Document Preview", fileType = "") {
    let parsedUrl;
    try {
      parsedUrl = new URL(url, window.location.href);
    } catch {
      return;
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) return;

    const type = String(fileType || fileExtension(parsedUrl.href)).toLowerCase().replace(/^\./, "");
    previousFocus = document.activeElement;
    activeUrl = parsedUrl.href;
    activeTitle = title;
    titleElement.textContent = title;
    content.replaceChildren();
    message = document.createElement("span");
    message.className = "document-preview-message";
    message.id = "documentPreviewMessage";
    message.hidden = true;
    content.append(message);
    downloadButton.hidden = true;

    if (type === "pdf") {
      const frame = document.createElement("iframe");
      frame.className = "document-preview-frame";
      frame.src = activeUrl;
      frame.title = `${title} preview`;
      frame.referrerPolicy = "no-referrer";
      content.append(frame);
    } else if (["jpg", "jpeg", "png", "webp"].includes(type)) {
      const image = document.createElement("img");
      image.className = "document-preview-image";
      image.src = activeUrl;
      image.alt = `${title} preview`;
      image.addEventListener("error", () => {
        content.replaceChildren();
        content.append(message);
        message.hidden = false;
        message.textContent = "This image could not be previewed.";
        downloadButton.hidden = false;
      }, { once: true });
      content.append(image);
    } else {
      message.hidden = false;
      message.textContent = "Preview not available for this file type.";
      downloadButton.hidden = false;
    }

    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    closeButton.focus();
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-preview-url]");
    if (!button) return;
    event.preventDefault();
    openDocumentPreview(button.dataset.previewUrl, button.dataset.previewTitle || "Document Preview", button.dataset.previewType || "");
  });

  closeButton.addEventListener("click", closeDocumentPreview);
  closeFooterButton.addEventListener("click", closeDocumentPreview);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeDocumentPreview();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || modal.hidden) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeDocumentPreview();
  });
  downloadButton.addEventListener("click", async () => {
    if (!activeUrl) return;
    const downloadUrl = activeUrl;
    const downloadTitle = activeTitle;
    const downloadMessage = message;
    downloadButton.disabled = true;
    downloadMessage.hidden = false;
    downloadMessage.textContent = "Preparing download...";
    try {
      const response = await fetch(downloadUrl);
      if (!response.ok) throw new Error(`Download failed (${response.status}).`);
      const blobUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = blobUrl;
      const decodedPath = decodeURIComponent(new URL(downloadUrl).pathname);
      link.download = decodedPath.split("/").pop() || downloadTitle;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
      if (message === downloadMessage && !modal.hidden) downloadMessage.textContent = "Download started.";
    } catch (error) {
      console.error("Unable to download document preview.", error);
      if (message === downloadMessage && !modal.hidden) downloadMessage.textContent = "Unable to download this file. Please try again.";
    } finally {
      downloadButton.disabled = false;
    }
  });

  return openDocumentPreview;
}
