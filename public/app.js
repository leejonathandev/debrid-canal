import { createSessionClient } from "./session-client.js";

const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const statusEl = document.getElementById("status");
const torrentList = document.getElementById("torrent-list");
const magnetText = document.getElementById("magnet-text");
const magnetSubmit = document.getElementById("magnet-submit");
const rateLimitBanner = document.getElementById("rate-limit-banner");
const rateLimitCountdown = document.getElementById("rate-limit-countdown");

// Initialize Socket.IO connection
const socket = io({ autoConnect: false });

const setStatus = (message, type = "info") => {
  statusEl.textContent = message;
  statusEl.dataset.type = type;
};

const isMagnetLink = (value) =>
  typeof value === "string" && value.trim().toLowerCase().startsWith("magnet:");

const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");

const renderDownloadLinks = (torrent) => {
  if (Array.isArray(torrent.unrestrictedLinks) && torrent.unrestrictedLinks.length) {
    return torrent.unrestrictedLinks
      .map(
        (fileLink) =>
          `<a href="${escapeHtml(fileLink.url)}" target="_blank" rel="noopener">${escapeHtml(fileLink.name || "Download")}</a>`
      )
      .join("");
  }

  if (torrent.unrestrictedLink) {
    return `<a href="${escapeHtml(torrent.unrestrictedLink)}" target="_blank" rel="noopener">Download</a>`;
  }

  return "";
};

const uploadTorrent = async (file) => {
  const form = new FormData();
  form.append("torrent", file, file.name);
  return client.mutate("/api/torrents/upload", { method: "POST", body: form });
};

const submitMagnet = async (magnet) => {
  return client.mutate("/api/torrents/magnet", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ magnet })
  });
};

const cancelTorrent = async (torrentId) => {
  return client.mutate(`/api/torrents/${encodeURIComponent(torrentId)}`, { method: "DELETE" });
};

const terminalStatuses = new Set(["magnet_error", "error", "virus", "dead"]);

const renderTorrents = (torrents) => {
  torrentList.innerHTML = "";

  if (!torrents.length) {
    torrentList.innerHTML = "<p class=\"torrent-list__empty muted\">No active torrents yet.</p>";
    return;
  }

  torrents.forEach((torrent) => {
    const card = document.createElement("div");
    card.className = "torrent-card";
    const isDownloaded = torrent.status === "downloaded";
    const errorMessage = torrent.error ||
      (terminalStatuses.has(torrent.status) ? "Real-Debrid could not complete this torrent." : "");
    const linkContent = renderDownloadLinks(torrent) || (errorMessage ? "" : "Waiting for unrestricted link...");

    const progressPercent = Math.min(100, Math.max(0, Number(torrent.progress)));

    card.innerHTML = `
      <div class="torrent-card__header">
        <div class="torrent-card__name">${escapeHtml(torrent.name || "Untitled")}</div>
        <div class="torrent-card__header-actions">
          <div class="torrent-card__status">${escapeHtml(torrent.status || "unknown")}</div>
        </div>
      </div>
      <div class="progress-bar">
        <div class="progress-bar__fill" style="width: ${progressPercent}%"></div>
      </div>
      <div class="torrent-card__status">Progress: ${progressPercent}%</div>
      ${errorMessage ? `<p class="torrent-card__error">${escapeHtml(errorMessage)}</p>` : ""}
      ${linkContent ? `<div class="torrent-card__link">${linkContent}</div>` : ""}
    `;

    const cancelButton = document.createElement("button");
    cancelButton.className = "torrent-card__cancel";
    cancelButton.type = "button";
    cancelButton.textContent = "❌";
    cancelButton.setAttribute(
      "aria-label",
      `${isDownloaded ? "Remove finished download" : "Cancel download"} ${torrent.name || "torrent"}`
    );

    const headerActions = card.querySelector(".torrent-card__header-actions");
    if (headerActions) {
      headerActions.appendChild(cancelButton);
    }

    cancelButton.addEventListener("click", async () => {
      try {
        cancelButton.disabled = true;
        setStatus(isDownloaded ? "Removing finished download..." : "Cancelling torrent...");
        await cancelTorrent(torrent.id);
        setStatus("Removed from list.");
      } catch (error) {
        cancelButton.disabled = false;
        setStatus(error.message, "error");
      }
    });

    torrentList.appendChild(card);
  });
};

const handleDrop = async (event) => {
  event.preventDefault();
  dropZone.classList.remove("dragover");

  const { files, items } = event.dataTransfer;

  try {
    if (files && files.length) {
      setStatus("Uploading torrent file...");
      await uploadTorrent(files[0]);
      setStatus("Torrent uploaded. Tracking status.");
      return;
    }

    if (items && items.length) {
      const textItem = Array.from(items).find(
        (item) => item.kind === "string"
      );
      if (textItem) {
        textItem.getAsString(async (text) => {
          if (!isMagnetLink(text)) {
            setStatus("Dropped text is not a magnet link.", "error");
            return;
          }

          try {
            setStatus("Submitting magnet link...");
            await submitMagnet(text.trim());
            setStatus("Magnet submitted. Tracking status.");
          } catch (error) {
            setStatus(error.message, "error");
          }
        });
      }
    }
  } catch (error) {
    setStatus(error.message, "error");
  }
};

const handleFilePick = async (event) => {
  const file = event.target.files[0];
  if (!file) return;

  try {
    setStatus("Uploading torrent file...");
    await uploadTorrent(file);
    setStatus("Torrent uploaded. Tracking status.");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    fileInput.value = "";
  }
};

const handleMagnetSubmit = async () => {
  const magnet = magnetText.value.trim();
  if (!isMagnetLink(magnet)) {
    setStatus("Paste a valid magnet link.", "error");
    return;
  }

  try {
    magnetSubmit.disabled = true;
    setStatus("Submitting magnet link...");
    await submitMagnet(magnet);
    magnetText.value = "";
    setStatus("Magnet submitted. Tracking status.");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    magnetSubmit.disabled = false;
  }
};

const client = createSessionClient({
  socket,
  onStatus: setStatus,
  onState: data => {
    renderTorrents(data.torrents);
    if (data.allComplete) setStatus("All torrents downloaded.");
  }
});

let rateLimitInterval = null;

socket.on('rate-limit-hit', (data) => {
  let timeRemaining = data.timeRemaining || 60;
  
  // Show rate limit banner
  rateLimitBanner.style.display = 'block';
  rateLimitCountdown.textContent = timeRemaining;
  
  // Clear any existing interval
  if (rateLimitInterval) {
    clearInterval(rateLimitInterval);
  }
  
  // Update countdown every second
  rateLimitInterval = setInterval(() => {
    timeRemaining--;
    rateLimitCountdown.textContent = timeRemaining;
    
    if (timeRemaining <= 0) {
      rateLimitBanner.style.display = 'none';
      clearInterval(rateLimitInterval);
      rateLimitInterval = null;
    }
  }, 1000);
});

const init = async () => {
  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("dragover");
  });
  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("dragover");
  });
  dropZone.addEventListener("drop", handleDrop);
  dropZone.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text");
    if (isMagnetLink(text)) {
      magnetText.value = text.trim();
      handleMagnetSubmit();
    }
  });

  fileInput.addEventListener("change", handleFilePick);
  magnetSubmit.addEventListener("click", handleMagnetSubmit);
  magnetText.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleMagnetSubmit();
    }
  });

  // Register controls before bootstrap, so a failed initial connection can be
  // retried by the next user action without leaving the interface inert.
  setStatus("Connecting...");
  await client.start();
};

init().catch(error => setStatus(error.message, "error"));
