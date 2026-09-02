import { Router, type Request } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { getAddress, recoverMessageAddress } from "viem";
import { z } from "zod";
import type { Database } from "./db.js";
import { launcherAbi } from "./abi.js";
import { publicClient, requiredAddress, requiredPrivateKey, TARGET_MARKET_CAP_USD, TARGET_TOKEN_USD, TOTAL_SUPPLY } from "./config.js";
import { buildPoolQuote } from "./math.js";
import { getMarketPrices, getRamenUsd } from "./ramenPrice.js";

const quoteInput = z.object({
  creator: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  name: z.string().trim().min(1).max(32),
  symbol: z.string().trim().min(1).max(10).regex(/^[A-Za-z0-9]+$/),
});

const imageUpdateInput = z.object({
  imageUrl: z.string().url().max(2048).refine((value) => /^https?:\/\//i.test(value), "Image URL must use HTTP(S)"),
  timestamp: z.number().int().positive(),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});

function imageUpdateMessage(token: string, imageUrl: string, timestamp: number) {
  return `RamenPad image update\nChain: 4663\nToken: ${token}\nImage: ${imageUrl}\nTimestamp: ${timestamp}`;
}

const uploadDir = path.resolve(process.cwd(), "uploads");
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (_request, file, done) => done(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_request, file, done) => done(null, ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.mimetype)),
});

export function createRamenpadRouter(db: Database) {
  const router = Router();
  const launcherAddress = process.env.RAMENPAD_LAUNCHER_ADDRESS;
  let systemContracts: Promise<{ locker: string | null; otc: string | null }> | undefined;

  function getSystemContracts() {
    if (!launcherAddress || !/^0x[0-9a-fA-F]{40}$/.test(launcherAddress)) {
      return Promise.resolve({ locker: null, otc: null });
    }
    systemContracts ??= Promise.all([
      publicClient.readContract({ address: launcherAddress as `0x${string}`, abi: launcherAbi, functionName: "locker" }),
      publicClient.readContract({ address: launcherAddress as `0x${string}`, abi: launcherAbi, functionName: "otc" }),
    ]).then(([locker, otc]) => ({ locker, otc })).catch((error) => {
      systemContracts = undefined;
      throw error;
    });
    return systemContracts;
  }

  router.get("/config", async (_request, response, next) => {
    try {
      const { locker, otc } = await getSystemContracts();
      const { ramenUsd, ethUsd, ramenMarketCapUsd, ramenVolumeUsd } = await getMarketPrices();
      response.json({
        chainId: 4663,
        launcher: launcherAddress || null,
        locker,
        otc,
        ethRouter: process.env.RAMENPAD_ETH_ROUTER_ADDRESS || null,
        ramenUsd,
        ethUsd,
        ramenMarketCapUsd,
        ramenVolumeUsd,
        totalSupply: TOTAL_SUPPLY,
        targetMarketCapUsd: TARGET_MARKET_CAP_USD,
        targetTokenUsd: TARGET_TOKEN_USD,
        supplySplit: { lockedLiquidityBps: 9000, initialOtcBps: 1000 },
        otcRoutingBps: 2000,
        feeSplit: { launcherBps: 6900, ramenDevBps: 1550, protocolOwnerBps: 1550 },
      });
    } catch (error) { next(error); }
  });

  router.post("/quote", async (request, response, next) => {
    try {
      const input = quoteInput.parse(request.body);
      const launcher = requiredAddress("RAMENPAD_LAUNCHER_ADDRESS");
      const account = privateKeyToAccount(requiredPrivateKey("RAMENPAD_QUOTE_SIGNER_PRIVATE_KEY"));
      const creator = getAddress(input.creator);
      const symbol = input.symbol.toUpperCase();
      const [predictedToken, salt] = await publicClient.readContract({
        address: launcher,
        abi: launcherAbi,
        functionName: "predictNextTokenAddress",
        args: [creator, input.name, symbol],
      });
      const ramenUsd = await getRamenUsd();
      const poolQuote = buildPoolQuote(predictedToken, ramenUsd);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
      const quote = {
        sqrtPriceX96: poolQuote.sqrtPriceX96,
        tickLower: poolQuote.tickLower,
        tickUpper: poolQuote.tickUpper,
        deadline,
      };
      const digest = await publicClient.readContract({
        address: launcher,
        abi: launcherAbi,
        functionName: "launchQuoteDigest",
        args: [creator, predictedToken, salt, quote],
      });
      const signature = await account.sign({ hash: digest });
      response.json({
        predictedToken,
        ramenUsd,
        targetTokenUsd: TARGET_TOKEN_USD,
        quote: { ...quote, sqrtPriceX96: quote.sqrtPriceX96.toString(), deadline: deadline.toString() },
        signature,
      });
    } catch (error) { next(error); }
  });

  router.post("/uploads", upload.single("image"), (request: Request & { file?: Express.Multer.File }, response) => {
    if (!request.file) { response.status(400).json({ error: "A PNG, JPG, WebP, or GIF image is required" }); return; }
    const base = (process.env.PUBLIC_BASE_URL || `${request.protocol}://${request.get("host")}`).replace(/\/$/, "");
    response.status(201).json({ imageUrl: `${base}/ramenpad/uploads/${request.file.filename}` });
  });

  router.get("/tokens", async (_request, response, next) => {
    try {
      const result = await db.query(`
        SELECT token_address AS "tokenAddress", pool_address AS "poolAddress", launcher,
          position_token_id::text AS "positionTokenId", name, symbol, image_url AS "imageUrl",
          launched_at AS "launchedAt", price_usd::float8 AS "priceUsd",
          market_cap_usd::float8 AS "marketCapUsd", volume_usd::float8 AS "volumeUsd",
          k.total_fee_usd::float8 AS "totalFeeUsd", k.launcher_fee_usd::float8 AS "launcherFeeUsd",
          k.protocol_fee_usd::float8 AS "protocolFeeUsd", k.harvest_count AS "harvestCount",
          k.launcher_token_pending::text AS "launcherTokenPending",
          k.launcher_ramen_pending::text AS "launcherRamenPending",
          k.protocol_token_deposited::text AS "protocolTokenDeposited",
          k.protocol_ramen_deposited::text AS "protocolRamenDeposited"
        FROM ramenpad.launches JOIN ramenpad.fee_kpis k USING(token_address)
        ORDER BY launched_at DESC
      `);
      response.json({ tokens: result.rows });
    } catch (error) { next(error); }
  });

  router.get("/kpis", async (_request, response, next) => {
    try {
      const result = await db.query(`
        SELECT count(*)::integer AS "tokenCount",
          COALESCE(sum(total_fee_usd),0)::float8 AS "totalFeeUsd",
          COALESCE(sum(launcher_fee_usd),0)::float8 AS "launcherFeeUsd",
          COALESCE(sum(protocol_fee_usd),0)::float8 AS "protocolFeeUsd",
          COALESCE(sum(harvest_count),0)::integer AS "harvestCount",
          COALESCE(sum(protocol_token_deposited),0)::text AS "protocolTokenDeposited",
          COALESCE(sum(protocol_ramen_deposited),0)::text AS "protocolRamenDeposited"
        FROM ramenpad.fee_kpis
      `);
      response.json({ kpis: result.rows[0] });
    } catch (error) { next(error); }
  });

  router.get("/tokens/:address/kpis", async (request, response, next) => {
    try {
      const token = z.string().regex(/^0x[0-9a-fA-F]{40}$/).parse(request.params.address).toLowerCase();
      const result = await db.query(`
        SELECT token_address AS "tokenAddress", harvest_count AS "harvestCount",
          launcher_token_earned::text AS "launcherTokenEarned",
          launcher_ramen_earned::text AS "launcherRamenEarned",
          launcher_token_claimed::text AS "launcherTokenClaimed",
          launcher_ramen_claimed::text AS "launcherRamenClaimed",
          launcher_token_pending::text AS "launcherTokenPending",
          launcher_ramen_pending::text AS "launcherRamenPending",
          protocol_token_earned::text AS "protocolTokenEarned",
          protocol_ramen_earned::text AS "protocolRamenEarned",
          protocol_token_deposited::text AS "protocolTokenDeposited",
          protocol_ramen_deposited::text AS "protocolRamenDeposited",
          total_fee_usd::float8 AS "totalFeeUsd", launcher_fee_usd::float8 AS "launcherFeeUsd",
          protocol_fee_usd::float8 AS "protocolFeeUsd", launcher_claimed_usd::float8 AS "launcherClaimedUsd"
        FROM ramenpad.fee_kpis WHERE token_address=$1
      `, [token]);
      if (!result.rowCount) { response.status(404).json({ error: "Unknown RamenPad token" }); return; }
      response.json({ kpis: result.rows[0] });
    } catch (error) { next(error); }
  });

  router.post("/tokens/:address/image", async (request, response, next) => {
    try {
      const token = getAddress(z.string().regex(/^0x[0-9a-fA-F]{40}$/).parse(request.params.address));
      const input = imageUpdateInput.parse(request.body);
      if (Math.abs(Date.now() - input.timestamp) > 10 * 60_000) {
        response.status(400).json({ error: "Image update signature expired" }); return;
      }
      const launch = await db.query<{ launcher: string }>(
        "SELECT launcher FROM ramenpad.launches WHERE token_address=$1", [token.toLowerCase()],
      );
      if (!launch.rowCount) { response.status(404).json({ error: "Unknown RamenPad token" }); return; }
      const signer = await recoverMessageAddress({
        message: imageUpdateMessage(token, input.imageUrl, input.timestamp),
        signature: input.signature as `0x${string}`,
      });
      if (signer.toLowerCase() !== launch.rows[0].launcher.toLowerCase()) {
        response.status(403).json({ error: "Only the token launcher can update its image" }); return;
      }
      await db.query(
        "UPDATE ramenpad.launches SET image_url=$2, image_updated_at=now() WHERE token_address=$1",
        [token.toLowerCase(), input.imageUrl],
      );
      response.json({ tokenAddress: token, imageUrl: input.imageUrl });
    } catch (error) { next(error); }
  });

  router.get("/trades", async (request, response, next) => {
    try {
      const limit = Math.max(1, Math.min(200, Number(request.query.limit) || 50));
      const result = await db.query(`
        SELECT t.id, t.token_address AS "tokenAddress", t.pool_address AS "poolAddress", l.symbol,
          t.side, t.trader, t.token_amount::text AS "tokenAmount", t.ramen_amount::text AS "ramenAmount",
          t.usd_value::float8 AS "usdValue", t.price_usd::float8 AS "priceUsd",
          t.market_cap_usd::float8 AS "marketCapUsd", t.tx_hash AS "txHash", t.block_time AS "blockTime"
        FROM ramenpad.trades t JOIN ramenpad.launches l USING(token_address)
        ORDER BY t.block_time DESC, t.log_index DESC LIMIT $1
      `, [limit]);
      response.json({ trades: result.rows });
    } catch (error) { next(error); }
  });

  return router;
}
