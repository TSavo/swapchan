import { homedir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { installScopedFetch, startWatchdog } from "./scanctx.js";

installScopedFetch();
const { createApp } = await import("./index.js");

const port = Number(process.env.PORT ?? 8787);
serve(
  {
    fetch: createApp(undefined, {
      paymentStoreFile: join(
        process.env.SWAPCHAN_DATA_DIR ?? join(homedir(), ".swapchan"),
        "payments.db",
      ),
    }).fetch,
    port,
  },
  (i) => console.log(`swapchan api on :${i.port}`),
);
startWatchdog();
