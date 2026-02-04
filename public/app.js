const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const statusEl = document.getElementById("status");
const torrentList = document.getElementById("torrent-list");
const magnetText = document.getElementById("magnet-text");
const magnetSubmit = document.getElementById("magnet-submit");

const POLL_INTERVAL = 5000;

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

const fetchTorrents = async (refresh = false) => {
  const response = await fetch(`/api/torrents?refresh=${refresh ? 1 : 0}`);

  if (!response.ok) {
    throw new Error("Failed to load torrents.");
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
      await uploadTorrent(files[0]);
      setStatus("Torrent uploaded. Tracking status.");
      await refreshAndRender();
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
            await refreshAndRender();
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
    await refreshAndRender();
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
    await refreshAndRender();
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    magnetSubmit.disabled = false;
  }
};

const refreshAndRender = async () => {
  const torrents = await fetchTorrents(true);
  renderTorrents(torrents);
};

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

  try {
    const torrents = await fetchTorrents(false);
    renderTorrents(torrents);
  } catch (error) {
    setStatus(error.message, "error");
  }

  setInterval(async () => {
    try {
      await refreshAndRender();
    } catch (error) {
      setStatus(error.message, "error");
    }
  }, POLL_INTERVAL);
};

init();
