import "dotenv/config";
import { createApplication } from "./app.js";
import { positiveInteger } from "./config.js";
import logger from "./utils/logger.js";

const application = createApplication();
const port = positiveInteger(process.env.PORT, 3000);
if (!process.env.REALDEBRID_API_KEY) logger.warn("REALDEBRID_API_KEY is not set; readiness will fail.");
application.httpServer.listen(port, () => logger.info(`debrid-canal listening on port ${port}`));
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    const deadline = setTimeout(() => process.exit(1), 10000);
    deadline.unref();
    void application.close().then(() => { clearTimeout(deadline); });
  });
}
