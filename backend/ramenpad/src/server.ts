import express from "express";
import http from "node:http";
import path from "node:path";
import { Server as SocketServer } from "socket.io";
import { createDatabase, migrate } from "./db.js";
import { createRamenpadRouter } from "./router.js";
import { RamenpadIndexer } from "./indexer.js";
import { RamenpadKeeper } from "./keeper.js";
import { getRpcStats } from "./config.js";

const app = express();
const server = http.createServer(app);
const io = new SocketServer(server, {
  path: "/ramenpad/socket.io",
  cors: { origin: process.env.CORS_ORIGIN?.split(",") || true },
});

app.use((_request, response, next) => {
  response.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  next();
});
app.use(express.json({ limit: "64kb" }));
app.use("/ramenpad/uploads", express.static(path.resolve(process.cwd(), "uploads"), { immutable: true, maxAge: "1y" }));

const db = createDatabase();
await migrate(db);
app.use("/api/ramenpad", createRamenpadRouter(db));
app.get("/health/ramenpad", (_request, response) => response.json({
  ok: true,
  service: "ramenpad",
  chainId: 4663,
  rpc: getRpcStats(),
}));
app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error("[ramenpad:http]", error);
  const message = error instanceof Error ? error.message : "Internal server error";
  response.status(message.includes("required") || message.includes("valid") ? 400 : 500).json({ error: message });
});

const port = Number(process.env.PORT || 4311);
server.listen(port, () => console.log(`[ramenpad] listening on :${port}`));

const indexer = process.env.RAMENPAD_LAUNCHER_ADDRESS ? new RamenpadIndexer(db, io) : undefined;
if (indexer) await indexer.start();
else console.warn("[ramenpad] RAMENPAD_LAUNCHER_ADDRESS is unset; indexer disabled");
const keeper = process.env.RAMENPAD_LAUNCHER_ADDRESS && process.env.RAMENPAD_KEEPER_PRIVATE_KEY
  ? new RamenpadKeeper(db)
  : undefined;
if (keeper) await keeper.start();
else console.warn("[ramenpad] keeper disabled until launcher and RAMENPAD_KEEPER_PRIVATE_KEY are configured");

async function shutdown() {
  const indexerStopped = indexer?.stop() || Promise.resolve();
  keeper?.stop();
  server.close();
  const cleanShutdown = indexerStopped.then(() => db.end());
  await Promise.race([
    cleanShutdown,
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
