#!/usr/bin/env node
/**
 * universal_testnet_bot.js
 * Template clean universal version
 *
 * Requirements:
 *  - Node 18+ (fetch available in environment used by ethers)
 *  - Dependencies: blessed, chalk, figlet, ethers, axios, https-proxy-agent, socks-proxy-agent
 *
 * Files used:
 *  - pk.txt      => list of private keys (one per line)
 *  - proxy.txt   => list of proxies (optional)
 *  - config.json => { "bridgeRepetitions":1, "swapRepetitions":1 }
 *
 * Customize RPC / CHAIN / CONTRACT constants below.
 */

import blessed from "blessed";
import chalk from "chalk";
import figlet from "figlet";
import { ethers } from "ethers";
import fs from "fs";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

/* =======================
   CONFIGURE THESE VALUES
   ======================= */

// RPC endpoints and chain IDs for two networks (can be same for single-network swap)
const RPC_A = "https://rpc.networkA.test";           // <-- ganti
const RPC_B = "https://rpc.networkB.test";           // <-- ganti
const CHAIN_ID_A = 11155111;                         // <-- ganti
const CHAIN_ID_B = 267;                              // <-- ganti

// Token and contract addresses (update per target testnet)
const TOKEN_A = "0xTokenAAddress000000000000000000000000"; // token on chain A (to bridge)
const TOKEN_B = "0xTokenBAddress000000000000000000000000"; // token on chain B (swap target)
const BRIDGE_ROUTER = "0xBridgeRouterAddress000000000000000000"; // bridge router on chain A
const SWAP_ROUTER = "0xSwapRouterAddress0000000000000000000000"; // swap router on chain B

// Files
const PK_FILE = "pk.txt";
const PROXY_FILE = "proxy.txt";
const CONFIG_FILE = "config.json";

/* =======================
   END CONFIG
   ======================= */

const isDebug = false;
let privateKeys = [];
let proxies = [];
let selectedWalletIndex = 0;
let transactionLogs = [];
let activityRunning = false;
let shouldStop = false;
let dailyActivityConfig = { bridgeRepetitions: 1, swapRepetitions: 1 };

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

const BRIDGE_ABI = [
  "function deposit(uint256 amount, address receiver) payable"
];

const SWAP_ROUTER_ABI = [
  "function exactInputSingle(tuple(address tokenIn,address tokenOut,address deployer,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 limitSqrtPrice)) payable returns (uint256)",
  "function multicall(bytes[] data) payable returns (bytes[] results)"
];

/* ===== Utils & Helpers ===== */

function addLog(message, type = "info") {
  const ts = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" });
  let colored = message;
  if (type === "error") colored = chalk.red(message);
  else if (type === "success") colored = chalk.green(message);
  else if (type === "wait") colored = chalk.yellow(message);
  else if (type === "debug") colored = chalk.blue(message);
  transactionLogs.push(`[${ts}] ${colored}`);
  updateLogs();
}

function readFileLines(path) {
  try {
    if (!fs.existsSync(path)) return [];
    const data = fs.readFileSync(path, "utf8");
    return data.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  } catch (e) {
    addLog(`Failed read ${path}: ${e.message}`, "error");
    return [];
  }
}

function createAgent(proxyUrl) {
  if (!proxyUrl) return null;
  if (proxyUrl.startsWith("socks")) return new SocksProxyAgent(proxyUrl);
  return new HttpsProxyAgent(proxyUrl);
}

function getProvider(rpcUrl, chainId, proxyUrl = null) {
  try {
    if (proxyUrl) {
      const agent = createAgent(proxyUrl);
      // ethers v6 allows passing a custom fetch; simplest fallback is direct provider - proxies supported via global agent is environment specific
      // We attempt to create JsonRpcProvider normally and rely on HTTP proxy via environment if needed.
      return new ethers.JsonRpcProvider(rpcUrl, { chainId, name: `chain-${chainId}` });
    }
    return new ethers.JsonRpcProvider(rpcUrl, { chainId, name: `chain-${chainId}` });
  } catch (e) {
    addLog(`Provider init failed: ${e.message}`, "error");
    throw e;
  }
}

async function getBalance(provider, address) {
  try {
    const bal = await provider.getBalance(address);
    return Number(ethers.formatUnits(bal, 18));
  } catch (e) {
    addLog(`getBalance failed: ${e.message}`, "error");
    return 0;
  }
}

async function loadEnvironment() {
  privateKeys = readFileLines(PK_FILE).filter(k => !!k);
  if (privateKeys.length === 0) addLog("No private keys found in pk.txt", "error");
  else addLog(`Loaded ${privateKeys.length} private keys`, "success");

  proxies = readFileLines(PROXY_FILE);
  if (proxies.length > 0) addLog(`Loaded ${proxies.length} proxies`, "success");
  else addLog("No proxies loaded (proxy.txt missing or empty)", "info");

  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const c = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      dailyActivityConfig.bridgeRepetitions = Number(c.bridgeRepetitions) || 1;
      dailyActivityConfig.swapRepetitions = Number(c.swapRepetitions) || 1;
      addLog("Loaded config.json", "success");
    } catch (e) {
      addLog("Invalid config.json, using defaults", "error");
    }
  } else {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(dailyActivityConfig, null, 2));
    addLog("Created default config.json", "info");
  }
}

/* ===== Wallet / On-chain actions ===== */

async function getNextNonce(provider, addr) {
  try {
    return await provider.getTransactionCount(addr, "pending");
  } catch (e) {
    addLog(`getNextNonce error: ${e.message}`, "error");
    throw e;
  }
}

async function checkAndApprove(signer, tokenAddress, spender, amountWei, provider, accountIdx, note = "") {
  try {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
    const allowance = await token.allowance(signer.address, spender);
    if (allowance >= amountWei) {
      addLog(`Acct ${accountIdx+1}: allowance sufficient for ${note}`, "debug");
      return true;
    }
    addLog(`Acct ${accountIdx+1}: approving ${note}...`, "info");
    const nonce = await getNextNonce(provider, signer.address);
    const feeData = await provider.getFeeData();
    const tx = await token.approve(spender, ethers.MaxUint256, {
      gasLimit: 200000,
      maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
      nonce
    });
    addLog(`Acct ${accountIdx+1}: approval tx sent ${shortHash(tx.hash)}`, "wait");
    await tx.wait();
    addLog(`Acct ${accountIdx+1}: approved`, "success");
    return true;
  } catch (e) {
    addLog(`Acct ${accountIdx+1}: approve failed: ${e.message}`, "error");
    return false;
  }
}

function shortHash(h) { return h ? `${h.slice(0,6)}...${h.slice(-4)}` : "N/A"; }

async function performBridgeSimple(privateKey, proxyUrl, accountIdx) {
  // Bridge on chain A using BRIDGE_ROUTER.deposit(amount, receiver)
  if (!BRIDGE_ROUTER || !TOKEN_A) {
    addLog("Bridge addresses not configured", "error");
    return false;
  }
  try {
    const providerA = getProvider(RPC_A, CHAIN_ID_A, proxyUrl);
    const wallet = new ethers.Wallet(privateKey, providerA);
    const signer = wallet.connect(providerA);
    const bridge = new ethers.Contract(BRIDGE_ROUTER, BRIDGE_ABI, signer);

    // Choose a small random amount (0.01 - 0.05)
    const amount = (Math.random() * (0.05 - 0.01) + 0.01).toFixed(6);
    const amountWei = ethers.parseUnits(amount.toString(), 18);

    // Ensure token approved
    const ok = await checkAndApprove(signer, TOKEN_A, BRIDGE_ROUTER, amountWei, providerA, accountIdx, "bridge token");
    if (!ok) return false;

    addLog(`Acct ${accountIdx+1}: bridging ${amount} tokenA ->`, "info");
    const nonce = await getNextNonce(providerA, signer.address);
    const feeData = await providerA.getFeeData();
    const tx = await bridge.deposit(amountWei, signer.address, {
      gasLimit: 800000,
      maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
      nonce
    });
    addLog(`Acct ${accountIdx+1}: bridge tx ${shortHash(tx.hash)} sent`, "wait");
    await tx.wait();
    addLog(`Acct ${accountIdx+1}: bridge completed`, "success");
    return true;
  } catch (e) {
    addLog(`Acct ${accountIdx+1}: bridge error: ${e.message}`, "error");
    return false;
  }
}

async function performSwapSimple(privateKey, proxyUrl, accountIdx) {
  // Swap on chain B using SWAP_ROUTER.exactInputSingle or multicall
  if (!SWAP_ROUTER || !TOKEN_B) {
    addLog("Swap addresses not configured", "error");
    return false;
  }
  try {
    const providerB = getProvider(RPC_B, CHAIN_ID_B, proxyUrl);
    const wallet = new ethers.Wallet(privateKey, providerB);
    const signer = wallet.connect(providerB);
    const swapRouter = new ethers.Contract(SWAP_ROUTER, SWAP_ROUTER_ABI, signer);

    // Choose small amount
    const amountIn = (Math.random() * (0.02 - 0.005) + 0.005).toFixed(6);
    const amountInWei = ethers.parseUnits(amountIn.toString(), 18);

    // If token being swapped is ERC20 on chain B, ensure approval
    // Here we assume TOKEN_B is either input or output - adapt as needed
    // For template: skip approval unless you set correct token addresses/roles

    // Try multicall with exactInputSingle param encoded (basic template - the exact tuple shape depends on router)
    // Many routers require different signatures; adapt when targeting a concrete router.
    try {
      // Build a dummy params object (match router signature in config)
      const deadline = Math.floor(Date.now() / 1000) + 1800;
      const params = {
        tokenIn: TOKEN_B, // adjust to actual tokenIn
        tokenOut: TOKEN_B, // adjust accordingly
        deployer: "0x0000000000000000000000000000000000000000",
        recipient: signer.address,
        deadline,
        amountIn: amountInWei,
        amountOutMinimum: 0,
        limitSqrtPrice: 0
      };
      const iface = new ethers.Interface(SWAP_ROUTER_ABI);
      const encoded = iface.encodeFunctionData("exactInputSingle", [params]);
      addLog(`Acct ${accountIdx+1}: swapping ${amountIn}...`, "info");
      const nonce = await getNextNonce(providerB, signer.address);
      const feeData = await providerB.getFeeData();
      const tx = await swapRouter.multicall([encoded], {
        value: 0,
        gasLimit: 500000,
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
        nonce
      });
      addLog(`Acct ${accountIdx+1}: swap tx ${shortHash(tx.hash)} sent`, "wait");
      await tx.wait();
      addLog(`Acct ${accountIdx+1}: swap completed`, "success");
      return true;
    } catch (inner) {
      // Router mismatch or signature difference - report
      addLog(`Acct ${accountIdx+1}: swap encoding failed: ${inner.message}`, "error");
      return false;
    }
  } catch (e) {
    addLog(`Acct ${accountIdx+1}: swap error: ${e.message}`, "error");
    return false;
  }
}

/* ===== Daily runner ===== */

async function runDailyActivityLoop() {
  if (privateKeys.length === 0) {
    addLog("No private keys loaded. Aborting activity.", "error");
    activityRunning = false;
    return;
  }
  activityRunning = true;
  shouldStop = false;
  addLog("Starting daily activity loop", "success");
  for (let i = 0; i < privateKeys.length && !shouldStop; i++) {
    const pk = privateKeys[i];
    const proxyUrl = proxies[i % proxies.length] || null;
    addLog(`Processing account ${i+1} (proxy=${proxyUrl || "none"})`, "info");

    // Bridge repetitions
    for (let b = 0; b < (dailyActivityConfig.bridgeRepetitions || 1) && !shouldStop; b++) {
      await performBridgeSimple(pk, proxyUrl, i);
      if (b < (dailyActivityConfig.bridgeRepetitions - 1)) await sleepRandom(8000, 20000);
    }

    // Wait small gap
    await sleepRandom(8000, 15000);

    // Swap repetitions
    for (let s = 0; s < (dailyActivityConfig.swapRepetitions || 1) && !shouldStop; s++) {
      await performSwapSimple(pk, proxyUrl, i);
      if (s < (dailyActivityConfig.swapRepetitions - 1)) await sleepRandom(8000, 20000);
    }

    // Wait between accounts
    if (i < privateKeys.length - 1) {
      addLog("Waiting 30s before next account...", "wait");
      await sleep(30_000);
    }
  }
  addLog("Daily loop finished.", "success");
  activityRunning = false;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
function sleepRandom(minMs, maxMs) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return sleep(ms);
}

/* ===== UI (blessed) ===== */

const screen = blessed.screen({ smartCSR: true, title: "UNIVERSAL TESTNET BOT", autoPadding: true });
const header = blessed.box({
  top: 0, left: "center", width: "100%", height: 5, tags: true, content: figlet.textSync("UNIVERSAL BOT", { horizontalLayout: "default" }),
  style: { fg: "yellow" }
});
const statusBox = blessed.box({
  top: 5, left: 0, width: "100%", height: 3, border: { type: "line" }, label: " Status ",
  content: "Status: Idle", padding: { left: 1 }
});
const walletBox = blessed.list({
  label: " Wallets ", top: 9, left: 0, width: "40%", height: "60%", border: { type: "line" }, keys: true, vi: true, mouse: true,
  items: ["No wallets loaded"]
});
const logBox = blessed.log({
  label: " Logs ", top: 9, left: "41%", width: "59%", height: "80%", border: { type: "line" }, tags: true, scrollbar: { ch: "│" }, scrollable: true
});
const menu = blessed.list({
  label: " Menu ", top: "70%", left: 0, width: "40%", height: "30%", border: { type: "line" }, keys: true, vi: true, mouse: true,
  items: ["Start Activity", "Stop Activity", "Set Config", "Clear Logs", "Refresh", "Exit"]
});

screen.append(header);
screen.append(statusBox);
screen.append(walletBox);
screen.append(logBox);
screen.append(menu);

menu.on("select", async (item, idx) => {
  const text = item.getText();
  if (text === "Start Activity") {
    if (activityRunning) addLog("Activity already running", "warn");
    else {
      updateStatus("Starting activity...");
      runDailyActivityLoop().catch(e => addLog(`Runner failed: ${e.message}`, "error"));
    }
  } else if (text === "Stop Activity") {
    if (!activityRunning) addLog("Activity not running", "info");
    else {
      shouldStop = true;
      updateStatus("Stopping...");
      addLog("Stop request issued, waiting for operations to finish...", "wait");
    }
  } else if (text === "Set Config") {
    promptSetConfig();
  } else if (text === "Clear Logs") {
    transactionLogs = [];
    updateLogs();
    addLog("Logs cleared", "success");
  } else if (text === "Refresh") {
    await refreshWalletList();
  } else if (text === "Exit") {
    process.exit(0);
  }
});

function updateStatus(text) {
  statusBox.setContent(`Status: ${text}`);
  screen.render();
}

function updateLogs() {
  logBox.setContent(transactionLogs.join("\n"));
  screen.render();
}

async function refreshWalletList() {
  const list = [];
  for (let i = 0; i < privateKeys.length; i++) {
    try {
      const pk = privateKeys[i];
      const proxyUrl = proxies[i % proxies.length] || null;
      const providerA = getProvider(RPC_A, CHAIN_ID_A, proxyUrl);
      const wallet = new ethers.Wallet(pk, providerA);
      const bal = await providerA.getBalance(wallet.address).catch(() => 0);
      const formatted = Number(ethers.formatUnits(bal, 18)).toFixed(4);
      list.push(`${i+1}. ${wallet.address} - ${formatted} ETH`);
    } catch (e) {
      list.push(`${i+1}. ERROR - ${e.message}`);
    }
  }
  walletBox.setItems(list.length ? list : ["No wallets loaded"]);
  screen.render();
}

function promptSetConfig() {
  const form = blessed.form({ parent: screen, keys: true, left: "center", top: "center", width: "50%", height: 12, border: { type: "line" }, label: " Set Config " });
  const bridgeInput = blessed.textbox({ parent: form, name: "bridge", top: 2, left: 2, width: "90%", height: 3, inputOnFocus: true, label: "Bridge Repetitions" });
  const swapInput = blessed.textbox({ parent: form, name: "swap", top: 6, left: 2, width: "90%", height: 3, inputOnFocus: true, label: "Swap Repetitions" });
  const submit = blessed.button({ parent: form, mouse: true, keys: true, shrink: true, padding: { left: 1, right: 1 }, left: "center", top: 9, content: "Save" });
  bridgeInput.setValue(String(dailyActivityConfig.bridgeRepetitions));
  swapInput.setValue(String(dailyActivityConfig.swapRepetitions));
  submit.on("press", () => {
    form.submit();
  });
  form.on("submit", (data) => {
    dailyActivityConfig.bridgeRepetitions = Number(data.bridge) || 1;
    dailyActivityConfig.swapRepetitions = Number(data.swap) || 1;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(dailyActivityConfig, null, 2));
    addLog("Config saved", "success");
    form.destroy();
    screen.render();
  });
  bridgeInput.focus();
  screen.render();
}

/* ===== Init ===== */

async function main() {
  await loadEnvironment();
  await refreshWalletList();
  updateLogs();
  updateStatus("Idle");
  screen.key(["C-c"], () => process.exit(0));
  screen.render();
}

main().catch(e => {
  addLog(`Startup error: ${e.message}`, "error");
});

// expose for debugging
export default {};
