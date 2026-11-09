/** Runs the ICS Source as an HTTP plugin on PORT (8080 by default), as its image does. */
import { servePlugin } from "@family-agenda/plugin-kit/server";
import { createIcsPlugin } from "./plugin";

const port = Number(process.env.PORT ?? 8080);
await servePlugin(createIcsPlugin(), { port });
console.log(`ICS Source plugin listening on port ${port}`);
