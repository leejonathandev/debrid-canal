const levelMap = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5
};

const rawLevel = (process.env.LOG_LEVEL || "info").toLowerCase();
const currentLevel = levelMap[rawLevel] ?? levelMap.info;

const canLog = (level) => levelMap[level] >= currentLevel;

const logWith = (level, ...args) => {
  if (!canLog(level)) {
    return;
  }

  const method = level === "trace" || level === "debug"
    ? "debug"
    : level === "info"
      ? "info"
      : level === "warn"
        ? "warn"
        : "error";

  console[method](`[${level.toUpperCase()}]`, ...args);
};

const logger = {
  level: rawLevel,
  isDebug: () => currentLevel <= levelMap.debug,
  trace: (...args) => logWith("trace", ...args),
  debug: (...args) => logWith("debug", ...args),
  info: (...args) => logWith("info", ...args),
  warn: (...args) => logWith("warn", ...args),
  error: (...args) => logWith("error", ...args),
  fatal: (...args) => logWith("fatal", ...args)
};

export default logger;
