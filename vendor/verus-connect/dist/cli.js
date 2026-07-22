#!/usr/bin/env node
import { createRequire as __cjsRequire } from 'module'; const require = __cjsRequire(import.meta.url);
import {
  KNOWN_CHAINS,
  verusAuth
} from "./chunk-447U76BP.js";

// src/cli.ts
import fs from "fs";
import path from "path";
import express from "express";
var envPath = path.join(process.cwd(), ".env");
try {
  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') || val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
} catch {
}
var PORT = parseInt(process.env.PORT || "8100", 10);
var HOST = process.env.HOST || "127.0.0.1";
var SIGNING_IADDRESS = process.env.SIGNING_IADDRESS || "";
var CALLBACK_URL = process.env.CALLBACK_URL || process.env.SERVER_URL || "";
function defaultRedirectUrl() {
  if (process.env.REDIRECT_URL) return process.env.REDIRECT_URL;
  try {
    return new URL(CALLBACK_URL).origin + "/";
  } catch {
    return "";
  }
}
var REDIRECT_URL = defaultRedirectUrl();
function defaultCorsOrigins() {
  if (process.env.CORS_ORIGINS) return process.env.CORS_ORIGINS;
  try {
    return new URL(CALLBACK_URL).origin;
  } catch {
    return "*";
  }
}
var CORS_ORIGINS = defaultCorsOrigins();
if (!SIGNING_IADDRESS) {
  console.error("Error: SIGNING_IADDRESS is required");
  process.exit(1);
}
if (!CALLBACK_URL) {
  console.error("Error: CALLBACK_URL is required");
  process.exit(1);
}
var chainsList = (process.env.CHAINS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
var confPathOverrides = {};
for (const name of Object.keys(KNOWN_CHAINS)) {
  const envKey = `CONF_PATH_${name.toUpperCase()}`;
  if (process.env[envKey]) confPathOverrides[name] = process.env[envKey];
}
var verifyNodeUrls = {};
for (const name of Object.keys(KNOWN_CHAINS)) {
  const envKey = `VERIFY_NODE_URL_${name.toUpperCase()}`;
  if (process.env[envKey]) verifyNodeUrls[name] = process.env[envKey];
}
var isLite = process.env.MODE === "lite" || !process.env.MODE && !!process.env.PRIVATE_KEY;
var isMultiChain = chainsList.length > 0;
var defaultChain = (process.env.DEFAULT_CHAIN || chainsList[0] || "vrsc").toLowerCase();
if (!isLite && !isMultiChain) {
  console.error("Error: daemon mode requires CHAINS=... (comma-separated chain names)");
  process.exit(1);
}
if (isMultiChain && !chainsList.includes(defaultChain)) {
  console.error(`Error: DEFAULT_CHAIN=${defaultChain} must be one of CHAINS=${chainsList.join(",")}`);
  process.exit(1);
}
var app = express();
var allowedOrigins = CORS_ORIGINS === "*" ? null : CORS_ORIGINS.split(",").map((s) => s.trim());
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!allowedOrigins || origin && allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin || "*");
  }
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use("/", verusAuth({
  mode: process.env.MODE || (isLite ? "lite" : "daemon"),
  iAddress: SIGNING_IADDRESS,
  callbackUrl: CALLBACK_URL,
  redirectUrl: REDIRECT_URL || void 0,
  chains: isMultiChain ? chainsList : void 0,
  defaultChain: isMultiChain ? defaultChain : void 0,
  confPathOverrides: !isLite && isMultiChain ? confPathOverrides : void 0,
  apiUrl: process.env.API_URL,
  privateKey: process.env.PRIVATE_KEY,
  // VERIFY_NODE_URL is the modern name. `API` is the legacy alias used by
  // earlier deployments (e.g. the rugpull and cryptoworld lite-mode
  // sidecars) — kept so a fresh dist can drop onto an old .env without
  // changing the env.
  verifyNodeUrl: process.env.VERIFY_NODE_URL || process.env.API,
  // For multi-chain lite, per-chain verify URLs override the single one.
  verifyNodeUrls: Object.keys(verifyNodeUrls).length ? verifyNodeUrls : void 0,
  ...process.env.CHAIN ? { chain: process.env.CHAIN } : {},
  debug: process.env.DEBUG === "true" || process.env.DEBUG === "1"
}));
app.listen(PORT, HOST, () => {
  const mode = isLite ? "lite" : "daemon";
  console.log(`verus-connect v4 listening on http://${HOST}:${PORT}`);
  console.log(`  Mode: ${mode}`);
  console.log(`  Signing ID: ${SIGNING_IADDRESS}`);
  console.log(`  Callback: ${CALLBACK_URL}`);
  if (isMultiChain) {
    console.log(`  Chains: ${chainsList.join(", ")}  (default: ${defaultChain})`);
  }
  console.log(`  CORS:  ${CORS_ORIGINS}`);
  if (CORS_ORIGINS === "*") {
    console.warn("  \u26A0 CORS is set to `*` \u2014 any origin can call this server and trigger wallet");
    console.warn("    prompts under your signing identity. Prefer an explicit allow-list.");
  }
  console.log(`  Endpoints:`);
  console.log(`    GET  /chains             List supported chains + health`);
  console.log(`    POST /login              Create login challenge (body: { chain? })`);
  console.log(`    POST /verusidlogin       Wallet callback (auto)`);
  console.log(`    GET  /result/:id         Poll challenge status`);
  console.log(`    POST /pay-deeplink       Generate payment deep link`);
  console.log(`    POST /generic-request    Create generic request`);
  console.log(`    POST /identity-update-request  Create identity update request`);
  console.log(`    GET  /health             Health check`);
});
