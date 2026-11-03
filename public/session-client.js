// HTTP snapshots and socket events share the same persisted revision counter.
// Only a successful session bootstrap may change the active session identity.
export class TorrentState {
  constructor(onChange = () => {}) {
    this.onChange = onChange;
    this.sessionKey = null;
    this.revision = -1;
  }

  activate(snapshot) {
    const changed = snapshot.sessionKey !== this.sessionKey;
    if (changed) {
      this.sessionKey = snapshot.sessionKey;
      this.revision = -1;
    }
    this.apply(snapshot);
    return changed;
  }

  apply(snapshot) {
    if (snapshot?.sessionKey !== this.sessionKey || !this.sessionKey ||
        !Number.isSafeInteger(snapshot.revision) || snapshot.revision <= this.revision ||
        !Array.isArray(snapshot.torrents)) return false;
    this.revision = snapshot.revision;
    this.onChange(snapshot);
    return true;
  }
}

export function createSessionClient({ socket, fetch = globalThis.fetch, onState, onStatus = () => {} }) {
  const state = new TorrentState(onState);
  let csrfToken;
  let renewing;
  let socketRecoveryUsed = false;

  const fetchResponse = async (url, options) => {
    try { return await fetch(url, { ...options, credentials: "same-origin", redirect: "error" }); }
    catch { throw new Error("Unable to reach the server. Check your connection or reload the page to sign in again."); }
  };

  const readResponse = async response => {
    if (response.redirected || (response.status !== 204 &&
        !response.headers.get("content-type")?.includes("application/json"))) {
      throw new Error("Sign-in may have expired. Reload the page to sign in again.");
    }
    const data = response.status === 204 ? null : await response.json();
    if (!response.ok) {
      throw Object.assign(new Error(data?.error || "Request failed. Please try again."), {
        status: response.status, code: data?.code
      });
    }
    return data;
  };

  const renewSession = () => {
    if (renewing) return renewing;
    renewing = (async () => {
      const data = await readResponse(await fetchResponse("/api/csrf-token", { cache: "no-store" }));
      if (!data.csrfToken || !data.state?.sessionKey || !Array.isArray(data.state.torrents) ||
          !Number.isSafeInteger(data.state.revision)) throw new Error("Unable to restore the session. Reload the page.");
      csrfToken = data.csrfToken;
      const changed = state.activate(data.state);
      if (changed) socket.disconnect();
      if (!socket.connected) socket.connect();
    })().finally(() => { renewing = null; });
    return renewing;
  };

  const refreshState = async () => {
    const snapshot = await readResponse(await fetchResponse("/api/torrents/state", { cache: "no-store" }));
    if (snapshot.sessionKey !== state.sessionKey) await renewSession();
    else state.apply(snapshot);
  };

  const mutate = async (url, options) => {
    if (!csrfToken) await renewSession();
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = csrfToken;
      try {
        result = await readResponse(await fetchResponse(url, {
          ...options, headers: { ...options.headers, "CSRF-Token": token }
        }));
        break;
      } catch (error) {
        // This rejection happens before the controller runs. Never replay a
        // mutation after an ambiguous network error or an upstream failure.
        if (attempt === 0 && error.status === 403 && error.code === "EBADCSRFTOKEN") {
          if (token === csrfToken) await renewSession();
          continue;
        }
        if (error.status === 410) csrfToken = undefined;
        throw error;
      }
    }
    // Mutation responses describe the operation's earlier state. Read a full,
    // versioned snapshot instead of merging an old upload into newer live data.
    try { await refreshState(); }
    catch { throw new Error("Change saved, but the list could not be refreshed. Reload the page to reconnect."); }
    return result;
  };

  const recoverSocket = async () => {
    if (socketRecoveryUsed) {
      onStatus("Unable to reconnect. Reload the page to restore your session.", "error");
      return;
    }
    socketRecoveryUsed = true;
    onStatus("Restoring your session...");
    try { await renewSession(); }
    catch (error) { onStatus(error.message, "error"); }
  };

  socket.on("torrents-updated", snapshot => state.apply(snapshot));
  socket.on("connect", () => {
    socketRecoveryUsed = false;
    onStatus("Connected. Tracking your torrents.");
  });
  socket.on("connect_error", error => {
    if (error.data?.code === "SESSION_REQUIRED") void recoverSocket();
    else onStatus(socket.active ? "Connection interrupted. Reconnecting; reload if sign-in has expired." :
      "Unable to connect. Reload the page to sign in again.", "error");
  });
  socket.on("disconnect", reason => {
    if (reason === "io server disconnect") void recoverSocket();
    else if (reason !== "io client disconnect") onStatus("Connection interrupted. Reconnecting...");
  });

  return { start: renewSession, mutate, refreshState };
}
