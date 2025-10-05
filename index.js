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
    const deadline = Math.floor(Date.now() / 1000) + 1800;
    const params = {
      tokenIn: TOKEN_B,
      tokenOut: TOKEN_B,
      deployer: "0x0000000000000000000000000000000000000000",
      recipient: signer.address,
      deadline,
      amountIn: amountInWei,
      amountOutMinimum: 0,
      limitSqrtPrice: 0
    };

    const iface = new ethers.Interface(SWAP_ROUTER_ABI);
    const encoded = iface.encodeFunctionData("exactInputSingle", [params]);

    addLog(`Acct ${accountIndex+1}: swapping ${amountIn} (template)`, "info");
    const nonce = await providerB.getTransactionCount(signer.address, "pending");
    const feeData = await providerB.getFeeData();
    const tx = await swapRouter.multicall([encoded], {
      value: 0,
      gasLimit: 500000,
      maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
      nonce
    });
    addLog(`Acct ${accountIndex+1}: swap tx ${shortHash(tx.hash)} sent`, "wait");
    await tx.wait();
    addLog(`Acct ${accountIndex+1}: swap completed`, "success");
    return true;
  } catch (e) {
    addLog(`Acct ${accountIndex+1}: swap error: ${e.message}`, "error");
    return false;
  }
}

/* ===== Runner ===== */

async function runDailyActivityLoop() {
  if (privateKeys.length === 0) {
    addLog("No private keys loaded. Add keys to pk.txt", "error");
    return;
  }
  if (activityRunning) { addLog("Activity already running", "warn"); return; }
  activityRunning = true;
  shouldStop = false;
  addLog("Starting activity loop", "success");

  try {
    for (let i = 0; i < privateKeys.length && !shouldStop; i++) {
      addLog(`Processing account ${i+1}/${privateKeys.length}`, "info");
      const pk = privateKeys[i];
      const proxyUrl = proxies[i % Math.max(1, proxies.length)] || null;

      // Bridges
      for (let b = 0; b < (dailyActivityConfig.bridgeRepetitions || 1) && !shouldStop; b++) {
        await performBridgeSimple(pk, proxyUrl, i);
        if (b < (dailyActivityConfig.bridgeRepetitions - 1)) await sleepRandom(8000, 20000);
      }

      await sleepRandom(7000, 15000);

      // Swaps
      for (let s = 0; s < (dailyActivityConfig.swapRepetitions || 1) && !shouldStop; s++) {
        await performSwapSimple(pk, proxyUrl, i);
        if (s < (dailyActivityConfig.swapRepetitions - 1)) await sleepRandom(8000, 20000);
      }

      if (i < privateKeys.length - 1) {
        addLog("Waiting 30s before next account...", "wait");
        await sleep(30_000);
      }
    }
    addLog("Activity loop finished for all accounts", "success");
  } catch (e) {
    addLog(`Runner unexpected error: ${e.message}`, "error");
  } finally {
    activityRunning = false;
    shouldStop = false;
  }
}

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }
function sleepRandom(minMs, maxMs) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return sleep(ms);
}

/* ===== UI (neo-blessed) ===== */

const screen = blessed.screen({
  smartCSR: true,
  title: "UNIVERSAL TESTNET BOT (Mouse)",
  fullUnicode: true,
  autoPadding: true
});

const header = blessed.box({
  top: 0, left: "center", width: "100%", height: 5,
  tags: true,
  content: figlet.textSync("UNIVERSAL BOT", { horizontalLayout: "default" }),
  style: { fg: "yellow" }
});

const status = blessed.box({
  top: 5, left: 0, width: "100%", height: 3, border: { type: "line" },
  label: chalk.cyan(" Status "), padding: { left: 1 },
  content: "Status: Idle"
});

const walletBox = blessed.list({
  label: " Wallets ",
  top: 9, left: 0, width: "40%", height: "60%",
  border: { type: "line" },
  style: {
    border: { fg: "cyan" },
    selected: { bg: "magenta", fg: "white" },
    item: { fg: "white" }
  },
  scrollable: true,
  keys: true,
  vi: true,
  mouse: true,
  items: ["No wallets loaded"]
});

const logBox = blessed.log({
  label: " Logs ",
  top: 9, left: "41%", width: "59%", height: "80%",
  border: { type: "line" }, tags: true,
  scrollbar: { ch: "│" },
  style: { border: { fg: "magenta" } },
  mouse: true
});

const hintBar = blessed.box({
  bottom: 0, left: "center", width: "100%", height: 1, align: "center",
  content: "↑↓ = Navigate | Enter / Click = Select | Ctrl+C = Exit",
  style: { fg: "grey" }
});

const menu = blessed.list({
  label: " Menu ",
  top: "70%", left: 0, width: "40%", height: "30%",
  border: { type: "line" },
  keys: true, vi: true, mouse: true, interactive: true,
  style: {
    selected: { bg: "green", fg: "black" },
    item: { hover: { bg: "blue" } },
    border: { fg: "red" }
  },
  items: ["Start Activity", "Stop Activity", "Set Config", "Clear Logs", "Refresh Wallets", "Exit"]
});

screen.append(header);
screen.append(status);
screen.append(walletBox);
screen.append(logBox);
screen.append(menu);
screen.append(hintBar);

/* Utility to refresh wallet list display */
async function refreshWalletList() {
  const items = [];
  for (let i = 0; i < privateKeys.length; i++) {
    try {
      const pk = privateKeys[i];
      const providerA = getProvider(RPC_A, CHAIN_ID_A);
      const wallet = new ethers.Wallet(pk, providerA);
      const bal = await providerA.getBalance(wallet.address).catch(() => 0n);
      const formatted = Number(ethers.formatUnits(bal, 18)).toFixed(4);
      items.push(`${i+1}. ${wallet.address} - ${formatted}`);
    } catch (e) {
      items.push(`${i+1}. ERROR - ${e.message}`);
    }
  }
  walletBox.setItems(items.length ? items : ["No wallets loaded"]);
  screen.render();
}

/* Logs update */
function updateLogs() {
  logBox.setContent(transactionLogs.join("\n"));
  screen.render();
}

/* Status update */
function updateStatus(txt) {
  status.setContent(`Status: ${txt}`);
  screen.render();
}

/* Menu action handler (used by both click and keyboard select) */
async function handleMenuAction(label) {
  if (label.includes("Start")) {
    if (activityRunning) addLog("Activity already running", "warn");
    else {
      updateStatus("Starting...");
      runDailyActivityLoop().catch(e => addLog(`Runner crashed: ${e.message}`, "error"));
    }
  } else if (label.includes("Stop")) {
    if (!activityRunning) addLog("Activity not running", "info");
    else {
      shouldStop = true;
      updateStatus("Stopping...");
      addLog("Stop requested. Waiting for current operations to finish...", "wait");
    }
  } else if (label.includes("Set Config")) {
    showConfigForm();
  } else if (label.includes("Clear Logs")) {
    transactionLogs = [];
    updateLogs();
    addLog("Logs cleared", "success");
  } else if (label.includes("Refresh Wallets")) {
    loadPrivateKeys();
    loadProxies();
    await refreshWalletList();
    addLog("Refreshed environment", "success");
  } else if (label.includes("Exit")) {
    addLog("Exiting...", "info");
    process.exit(0);
  } else {
    addLog(`Unknown menu action: ${label}`, "error");
  }
}

/* Bind keyboard selection */
menu.on("select", (item, idx) => {
  const label = item.getText();
  handleMenuAction(label);
});

/* Bind click - map click to item selected */
menu.on("click", (data) => {
  // neo-blessed gives data.y to calculate which item clicked; fallback to selected index
  try {
    const idx = menu.getItemIndex(menu.getItem(menu.selected));
    const label = menu.items[idx].getText();
    handleMenuAction(label);
  } catch {
    const label = menu.getItem(menu.selected).getText();
    handleMenuAction(label);
  }
});

/* Also allow clicking on log lines to copy index (optional) */
logBox.on("click", () => {
  // focus menu for convenience
  menu.focus();
});

/* Config form */
function showConfigForm() {
  const form = blessed.form({
    parent: screen,
    left: "center", top: "center",
    width: "50%", height: 12,
    keys: true, mouse: true,
    border: { type: "line" },
    label: " Set Config "
  });

  const bridgeInput = blessed.textbox({
    parent: form, name: "bridge",
    top: 2, left: 2, height: 3, width: "90%",
    label: "Bridge repetitions",
    inputOnFocus: true
  });

  const swapInput = blessed.textbox({
    parent: form, name: "swap",
    top: 6, left: 2, height: 3, width: "90%",
    label: "Swap repetitions",
    inputOnFocus: true
  });

  const saveButton = blessed.button({
    parent: form,
    bottom: 1, left: "center",
    content: " Save ",
    shrink: true, mouse: true, keys: true,
    style: { bg: "green", fg: "black", focus: { bg: "yellow" } }
  });

  bridgeInput.setValue(String(dailyActivityConfig.bridgeRepetitions));
  swapInput.setValue(String(dailyActivityConfig.swapRepetitions));

  saveButton.on("press", () => {
    const bridge = Number(bridgeInput.getValue()) || 1;
    const swap = Number(swapInput.getValue()) || 1;
    dailyActivityConfig.bridgeRepetitions = bridge;
    dailyActivityConfig.swapRepetitions = swap;
    saveConfig();
    addLog(`Config updated: bridge=${bridge}, swap=${swap}`, "success");
    form.destroy();
    menu.focus();          // ✅ fix: kembalikan fokus ke menu
    screen.render();
  });

  // tombol esc / q untuk keluar tanpa simpan
  form.key(["escape", "q"], () => {
    form.destroy();
    menu.focus();          // ✅ fix juga di sini
    screen.render();
  });

  bridgeInput.focus();
  screen.render();
}

/* Key bindings */
screen.key(["C-c"], () => process.exit(0));
screen.key(["tab"], () => {
  // cycle focus
  if (screen.focused === menu) walletBox.focus();
  else if (screen.focused === walletBox) logBox.focus();
  else menu.focus();
});

/* ===== Startup ===== */

async function bootstrap() {
  addLog("Booting universal_testnet_bot (mouse-enabled)...", "info");
  loadPrivateKeys();
  loadProxies();
  loadConfig();
  await refreshWalletList();
  updateLogs();
  updateStatus("Idle");
  menu.focus();
  screen.render();
}

bootstrap().catch(e => addLog(`Bootstrap failed: ${e.message}`, "error"));

/* expose for debugging if needed */
export default {};
