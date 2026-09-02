import fs from "node:fs";

const settingsPath = "/home/ec2-user/wolverine/server/config/settings.json";
const signerPath = "/home/ec2-user/ramenpad-backend/.env.signer";
const outputPath = "/home/ec2-user/ramenpad-backend/.env";

const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
const databaseUrl = settings?.platform?.database;
if (!databaseUrl) throw new Error("The shared backend database URL is not configured");

const secretInputPath = fs.existsSync(signerPath) ? signerPath : outputPath;
const signerValues = Object.fromEntries(
  fs.readFileSync(secretInputPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => line.split(/=(.*)/s).slice(0, 2)),
);
if (!/^0x[0-9a-fA-F]{64}$/.test(signerValues.RAMENPAD_QUOTE_SIGNER_PRIVATE_KEY || "")) {
  throw new Error("The RamenPad quote signer key is invalid");
}
if (!/^0x[0-9a-fA-F]{64}$/.test(signerValues.RAMENPAD_KEEPER_PRIVATE_KEY || "")) {
  throw new Error("The RamenPad keeper key is invalid");
}

const output = [
  `DATABASE_URL=${databaseUrl}`,
  `RAMENPAD_QUOTE_SIGNER_PRIVATE_KEY=${signerValues.RAMENPAD_QUOTE_SIGNER_PRIVATE_KEY}`,
  `RAMENPAD_KEEPER_PRIVATE_KEY=${signerValues.RAMENPAD_KEEPER_PRIVATE_KEY}`,
  `RAMENPAD_KEEPER_ADDRESS=${signerValues.RAMENPAD_KEEPER_ADDRESS || ""}`,
  `RAMENPAD_OWNER_ADDRESS=${signerValues.RAMENPAD_OWNER_ADDRESS || ""}`,
  `RAMENPAD_DEPLOYER_ADDRESS=${signerValues.RAMENPAD_DEPLOYER_ADDRESS || ""}`,
  `RAMENPAD_LAUNCHER_ADDRESS=${process.env.RAMENPAD_LAUNCHER_ADDRESS || signerValues.RAMENPAD_LAUNCHER_ADDRESS || ""}`,
  `RAMENPAD_DEPLOYMENT_BLOCK=${process.env.RAMENPAD_DEPLOYMENT_BLOCK || signerValues.RAMENPAD_DEPLOYMENT_BLOCK || ""}`,
  `RAMENPAD_TARGET_2000_ACTIVATION_BLOCK=${process.env.RAMENPAD_TARGET_2000_ACTIVATION_BLOCK || signerValues.RAMENPAD_TARGET_2000_ACTIVATION_BLOCK || ""}`,
  `RAMENPAD_ETH_ROUTER_ADDRESS=${process.env.RAMENPAD_ETH_ROUTER_ADDRESS || signerValues.RAMENPAD_ETH_ROUTER_ADDRESS || ""}`,
  "RAMENPAD_KEEPER_INTERVAL_MS=600000",
  "RAMENPAD_KEEPER_BATCH_SIZE=25",
  "RAMENPAD_KEEPER_MIN_HARVEST=1000",
  "RAMENPAD_INDEXER_INTERVAL_MS=15000",
  "RAMENPAD_INDEXER_MAX_BACKOFF_MS=120000",
  "RAMENPAD_INDEXER_BLOCK_RANGE=1000",
  "RAMENPAD_INDEXER_RANGES_PER_TICK=1",
  `ROBINHOOD_RPC_URL=${process.env.ROBINHOOD_RPC_URL || signerValues.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com"}`,
  `ROBINHOOD_FREE_RPC_URLS=${process.env.ROBINHOOD_FREE_RPC_URLS || signerValues.ROBINHOOD_FREE_RPC_URLS || "https://robinhood-rpc.publicnode.com"}`,
  `ROBINHOOD_LOG_RPC_URLS=${process.env.ROBINHOOD_LOG_RPC_URLS || signerValues.ROBINHOOD_LOG_RPC_URLS || "https://rpc.mainnet.chain.robinhood.com"}`,
  `ROBINHOOD_PAID_RPC_URLS=${process.env.ROBINHOOD_PAID_RPC_URLS || signerValues.ROBINHOOD_PAID_RPC_URLS || ""}`,
  "PUBLIC_BASE_URL=https://api.yougotcoined.com",
  "CORS_ORIGIN=*",
  "PORT=4311",
  "",
].join("\n");
fs.writeFileSync(outputPath, output, { mode: 0o600 });
if (fs.existsSync(signerPath)) fs.rmSync(signerPath);
