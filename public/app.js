const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const statusEl = document.getElementById("status");
const torrentList = document.getElementById("torrent-list");
const magnetText = document.getElementById("magnet-text");
const magnetSubmit = document.getElementById("magnet-submit");
const rateLimitBanner = document.getElementById("rate-limit-banner");
const rateLimitCountdown = document.getElementById("rate-limit-countdown");

// Initialize Socket.IO connection
const socket = io();

const setStatus = (message, type = "info") => {
  statusEl.textContent = message;
  statusEl.dataset.type = type;
};

const isMagnetLink = (value) =>
  typeof value === "string" && value.trim().toLowerCase().startsWith("magnet:");

const uploadTorrent = async (file) => {
  const form = new FormData();
  form.append("torrent", file, file.name);

  const response = await fetch("/api/torrents/upload", {
    method: "POST",
    body: form
  });

  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error || "Upload failed");
  }

  return response.json();
};

const submitMagnet = async (magnet) => {
  const response = await fetch("/api/torrents/magnet", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ magnet })
  });

  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error || "Magnet submission failed");
  }

  return response.json();
};

const renderTorrents = (torrents) => {
  torrentList.innerHTML = "";

  if (!torrents.length) {
    torrentList.innerHTML = "<p class=\"muted\">No active torrents yet.</p>";
    return;
  }

  torrents.forEach((torrent) => {
    const card = document.createElement("div");
    card.className = "torrent-card";

    const progressPercent = Math.min(100, Math.max(0, Number(torrent.progress)));

    card.innerHTML = `
      <div class="torrent-card__header">
        <div class="torrent-card__name">${torrent.name || "Untitled"}</div>
        <div class="torrent-card__status">${torrent.status || "unknown"}</div>
      </div>
      <div class="progress-bar">
        <div class="progress-bar__fill" style="width: ${progressPercent}%"></div>
      </div>
      <div class="torrent-card__status">Progress: ${progressPercent}%</div>
      <div class="torrent-card__link">
        ${
          torrent.unrestrictedLink
            ? `<a href="${torrent.unrestrictedLink}" target="_blank" rel="noopener">Download</a>`
            : "Waiting for unrestricted link..."
        }
      </div>
    `;

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
      const torrent = await uploadTorrent(files[0]);
      mergeTorrent(torrent);
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
            const torrent = await submitMagnet(text.trim());
            mergeTorrent(torrent);
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
    const torrent = await uploadTorrent(file);
    mergeTorrent(torrent);
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
    const torrent = await submitMagnet(magnet);
    mergeTorrent(torrent);
    magnetText.value = "";
    setStatus("Magnet submitted. Tracking status.");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    magnetSubmit.disabled = false;
  }
};

let currentTorrents = [];

const mergeTorrent = (torrent) => {
  if (!torrent || !torrent.id) {
    return;
  }

  const index = currentTorrents.findIndex((item) => item.id === torrent.id);
  if (index === -1) {
    currentTorrents = [torrent, ...currentTorrents];
  } else {
    currentTorrents = currentTorrents.map((item, idx) =>
      idx === index ? { ...item, ...torrent } : item
    );
  }

  renderTorrents(currentTorrents);
};

// Socket.IO event handlers
socket.on('connect', () => {
  console.log('[Socket.IO] Connected');
});

socket.on('disconnect', () => {
  console.log('[Socket.IO] Disconnected');
});

socket.on('torrents-updated', (data) => {
  currentTorrents = data.torrents || [];
  renderTorrents(currentTorrents);
  
  if (data.allComplete) {
    setStatus("All torrents downloaded.");
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

  // Initial status
  setStatus("Connected. Waiting for updates...");
};

init();
