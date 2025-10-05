#!/usr/bin/env node
/**
 * index.js
 * Universal testnet bot (Enhanced CLI + Mouse support)
 * - Uses neo-blessed for better mouse events.
 * - Template: multi-wallet, proxy, simple bridge & swap flows, config via UI.
 *
 * IMPORTANT: this is a template. Replace RPC/TOKEN/ROUTER constants for real testnet usage.
 */

import blessed from "neo-blessed";
import chalk from "chalk";
import figlet from "figlet";
import { ethers } from "ethers";
import fs from "fs";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import axios from "axios";

/* ===========================
   ========== CONFIG =========
   =========================== */

/*
 * Default values: "random" (dummy) — replace with real RPC/addresses per target testnet.
 */
const RPC_A = "https://rpc.random-networkA.test"; // change
const RPC_B = "https://rpc.random-networkB.test"; // change
const CHAIN_ID_A = 1337; // change
const CHAIN_ID_B = 1338; // change

// Dummy token/router addresses (replace before use)
const TOKEN_A = "0x0000000000000000000000000000000000000001";
const TOKEN_B = "0x0000000000000000000000000000000000000002";
const BRIDGE_ROUTER = "0x0000000000000000000000000000000000000b1d";
const SWAP_ROUTER = "0x0000000000000000000000000000000000005wap";

const PK_FILE = "pk.txt";
const PROXY_FILE = "proxy.txt";
const CONFIG_FILE = "config.json";

/* ===========================
   ========== END =============
   =========================== */

const isDebug = false;
let privateKeys = [];
let proxies = [];
let dailyActivityConfig = { bridgeRepetitions: 1, swapRepetitions: 1 };
let transactionLogs = [];
let activityRunning = false;
let shouldStop = false;

/* ===== ABIs (simple) ===== */
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

const BRIDGE_ABI = [
  "function deposit(uint256 amount, address receiver) payable"
];

// Minimal swap router ABI: multicall + exactInputSingle (structure is template; adapt to router)
const SWAP_ROUTER_ABI = [
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "function exactInputSingle(tuple(address tokenIn,address tokenOut,address deployer,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 limitSqrtPrice)) payable returns (uint256)"
];

/* ===== Helpers ===== */

function addLog(str, type = "info") {
  const t = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" });
  let msg = `[${t}] ${str}`;
  if (type === "error") msg = chalk.red(msg);
  else if (type === "success") msg = chalk.green(msg);
  else if (type === "warn") msg = chalk.yellow(msg);
  else if (type === "debug") msg = chalk.blue(msg);
  transactionLogs.push(msg);
  trimLogs();
  updateLogs();
}

function trimLogs(limit = 1000) {
  if (transactionLogs.length > limit) transactionLogs = transactionLogs.slice(-limit);
}

function readLines(file) {
  try {
    if (!fs.existsSync(file)) return [];
    const data = fs.readFileSync(file, "utf8");
    return data.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  } catch (e) {
    addLog(`readLines ${file} error: ${e.message}`, "error");
    return [];
  }
}

function createAgent(proxyUrl) {
  if (!proxyUrl) return null;
  if (proxyUrl.startsWith("socks")) return new SocksProxyAgent(proxyUrl);
  return new HttpsProxyAgent(proxyUrl);
}

function shortHash(h) { return h ? `${h.slice(0,6)}...${h.slice(-4)}` : "N/A"; }

/* ===== Environment loaders ===== */

function loadPrivateKeys() {
  privateKeys = readLines(PK_FILE).filter(k => k.match(/^(0x)?[0-9a-fA-F]{64}$/));
  if (privateKeys.length === 0) addLog("No private keys found (pk.txt). Add at least one 0x... private key.", "warn");
  else addLog(`Loaded ${privateKeys.length} private key(s) from ${PK_FILE}`, "success");
}

function loadProxies() {
  proxies = readLines(PROXY_FILE);
  if (proxies.length) addLog(`Loaded ${proxies.length} proxies from ${PROXY_FILE}`, "success");
  else addLog(`No proxies loaded (proxy.txt missing or empty). Running without proxies.`, "info");
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const c = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      dailyActivityConfig.bridgeRepetitions = Number(c.bridgeRepetitions) || 1;
      dailyActivityConfig.swapRepetitions = Number(c.swapRepetitions) || 1;
      addLog("Loaded config.json", "success");
    } else {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(dailyActivityConfig, null, 2));
      addLog("Created default config.json", "info");
    }
  } catch (e) {
    addLog(`Failed to load config.json: ${e.message}`, "error");
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(dailyActivityConfig, null, 2));
    addLog("Saved config.json", "success");
  } catch (e) {
    addLog(`Failed to save config: ${e.message}`, "error");
  }
}

/* ===== ethers provider utils ===== */

function getProvider(rpcUrl, chainId, proxyUrl = null) {
  // We create a JsonRpcProvider normally. If proxies needed for axios/http requests, createAgent used there.
  return new ethers.JsonRpcProvider(rpcUrl, { chainId, name: `chain-${chainId}` });
}

async function getBalanceFormatted(provider, address) {
  try {
    const b = await provider.getBalance(address);
    return Number(ethers.formatUnits(b, 18)).toFixed(4);
  } catch (e) {
    return "0.0000";
  }
}

/* ===== On-chain actions (template) ===== */

async function checkAndApproveIfNeeded(signer, tokenAddr, spender, amountWei, provider, accountIndex, note = "") {
  try {
    const token = new ethers.Contract(tokenAddr, ERC20_ABI, signer);
    const allowance = await token.allowance(signer.address, spender);
    if (allowance >= amountWei) {
      addLog(`Acct ${accountIndex+1}: allowance already OK for ${note}`, "debug");
      return true;
    }
    addLog(`Acct ${accountIndex+1}: approving ${note}...`, "info");
    const nonce = await provider.getTransactionCount(signer.address, "pending");
    const feeData = await provider.getFeeData();
    const tx = await token.approve(spender, ethers.MaxUint256, {
      gasLimit: 200000,
      maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
      nonce
    });
    addLog(`Acct ${accountIndex+1}: approval tx ${shortHash(tx.hash)} sent`, "wait");
    await tx.wait();
    addLog(`Acct ${accountIndex+1}: approval mined`, "success");
    return true;
  } catch (e) {
    addLog(`Acct ${accountIndex+1}: approve failed: ${e.message}`, "error");
    return false;
  }
}

async function performBridgeSimple(pk, proxyUrl, accountIndex) {
  if (!BRIDGE_ROUTER) { addLog("Bridge router not configured", "error"); return false; }
  try {
    const providerA = getProvider(RPC_A, CHAIN_ID_A, proxyUrl);
    const wallet = new ethers.Wallet(pk, providerA);
    const signer = wallet.connect(providerA);
    const bridge = new ethers.Contract(BRIDGE_ROUTER, BRIDGE_ABI, signer);

    // pick a small dummy amount (0.01 - 0.03)
    const amount = (Math.random() * (0.03 - 0.01) + 0.01).toFixed(6);
    const decimals = 18;
    const amountWei = ethers.parseUnits(amount.toString(), decimals);

    // Approve token (if token is ERC20)
    await checkAndApproveIfNeeded(signer, TOKEN_A, BRIDGE_ROUTER, amountWei, providerA, accountIndex, "bridge token");

    addLog(`Acct ${accountIndex+1}: bridging ${amount} tokenA -> router`, "info");
    const nonce = await providerA.getTransactionCount(signer.address, "pending");
    const feeData = await providerA.getFeeData();
    const tx = await bridge.deposit(amountWei, signer.address, {
      gasLimit: 800000,
      maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
      nonce
    });
    addLog(`Acct ${accountIndex+1}: bridge tx ${shortHash(tx.hash)} sent`, "wait");
    await tx.wait();
    addLog(`Acct ${accountIndex+1}: bridge completed`, "success");
    return true;
  } catch (e) {
    addLog(`Acct ${accountIndex+1}: bridge error: ${e.message}`, "error");
    return false;
  }
}

async function performSwapSimple(pk, proxyUrl, accountIndex) {
  if (!SWAP_ROUTER) { addLog("Swap router not configured", "error"); return false; }
  try {
    const providerB = getProvider(RPC_B, CHAIN_ID_B, proxyUrl);
    const wallet = new ethers.Wallet(pk, providerB);
    const signer = wallet.connect(providerB);
    const swapRouter = new ethers.Contract(SWAP_ROUTER, SWAP_ROUTER_ABI, signer);

    // small amount to swap
    const amountIn = (Math.random() * (0.02 - 0.005) + 0.005).toFixed(6);
    const amountInWei = ethers.parseUnits(amountIn.toString(), 18);

    // NOTE: many swap routers differ; this is a template using exactInputSingle tuple.
    const deadline = Math.floor(Date.now() / 1000) + 180
