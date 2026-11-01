const terminalStates = new Set(["magnet_error", "error", "virus", "dead"]);

export const needsPolling = torrent => !terminalStates.has(torrent.status) && (
  torrent.status !== "downloaded" || torrent.progress !== 100 || torrent.linksPending !== false
);
