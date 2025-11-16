// monitor.js
require("dotenv").config();
const axios = require("axios");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

// ---------- env helpers ----------
const envNum = (k, def) => {
  const n = Number(process.env[k]);
  return Number.isFinite(n) ? n : def;
};

// ---------- config from .env ----------
let TCIN = process.env.TCIN || "94336414";
let QTY = envNum("QTY", 1); // still logged if you care, otherwise harmless
const POLL_MS = envNum("POLL_MS", 1000);

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || "";

// new knobs (for notifications, NOT ATC)
const REFIRE_COOLDOWN_MS = envNum("REFIRE_COOLDOWN_MS", 30000); // min gap between alert waves
const SUCCESS_COOLDOWN_MS = envNum(
  "SUCCESS_COOLDOWN_MS",
  300000
); // cooldown after an alert

const STORE_ID = String(process.env.STORE_ID || "2342");
const ZIP = process.env.ZIP || "78717";
const STATE = process.env.STATE || "TX";
const LATITUDE = String(process.env.LATITUDE || "30.491921540848487");
const LONGITUDE = String(process.env.LONGITUDE || "-97.77130849066667");

// logging knobs
const LOG_DIR = process.env.LOG_DIR || "./logs";
const EVENT_LOG = path.join(LOG_DIR, `events_${TCIN}.csv`);
const WINDOW_LOG = path.join(LOG_DIR, `windows_${TCIN}.csv`);

// ---------- endpoints ----------
const redskyUrl =
  "https://redsky.target.com/redsky_aggregations/v1/web/product_fulfillment_v1";

let PDP_LINK = `https://www.target.com/p/-/A-${TCIN}`;

// ---------- state ----------
let firedThisWave = false;
let lastSuccessTs = 0; // here "success" == last time we opened PDP + alerted
let nextArmAfterTs = 0;

// availability tracking for logging
let lastIsAvail = null; // null until first poll, then true/false
let currentWindowStartTs = null; // start time (ms) of current IN_STOCK window
let lastQtySeen = null; // last qty string we saw
let lastShippingSeen = null; // last shipping status

// ---------- utils ----------
function ensureLogs() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  if (!fs.existsSync(EVENT_LOG)) {
    fs.writeFileSync(
      EVENT_LOG,
      "iso_ts,local_ts,event,shipping,qty,tcin,store_id,zip,state\n",
      "utf8"
    );
  }
  if (!fs.existsSync(WINDOW_LOG)) {
    fs.writeFileSync(
      WINDOW_LOG,
      "start_iso,start_local,end_iso,end_local,duration_ms,duration_sec,shipping_last,qty_last,tcin,store_id,zip,state\n",
      "utf8"
    );
  }
}
function tsIso(ms = Date.now()) {
  return new Date(ms).toISOString();
}
function tsLocal(ms = Date.now()) {
  return new Date(ms).toLocaleString();
}
function appendCsv(fp, line) {
  try {
    fs.appendFileSync(fp, line, "utf8");
  } catch (e) {
    console.error("❌ log write error:", e.message);
  }
}
function logEvent(evt, shipping, qty) {
  const line =
    [
      tsIso(),
      `"${tsLocal().replace(/"/g, '""')}"`,
      evt,
      shipping ?? "",
      String(qty ?? "").replace(/,/g, ""),
      TCIN,
      STORE_ID,
      ZIP,
      STATE,
    ].join(",") + "\n";
  appendCsv(EVENT_LOG, line);
}
function msToSec(ms) {
  return Math.round(ms / 1000);
}
function logWindow(startMs, endMs, shippingLast, qtyLast) {
  const dur = Math.max(0, endMs - startMs);
  const line =
    [
      tsIso(startMs),
      `"${tsLocal(startMs).replace(/"/g, '""')}"`,
      tsIso(endMs),
      `"${tsLocal(endMs).replace(/"/g, '""')}"`,
      dur,
      msToSec(dur),
      shippingLast ?? "",
      String(qtyLast ?? "").replace(/,/g, ""),
      TCIN,
      STORE_ID,
      ZIP,
      STATE,
    ].join(",") + "\n";
  appendCsv(WINDOW_LOG, line);
}
function genVisitorId() {
  const b = Buffer.allocUnsafe(16);
  for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendDiscord(content) {
  if (!DISCORD_WEBHOOK || DISCORD_WEBHOOK.trim() === "") return;
  try {
    await axios.post(DISCORD_WEBHOOK, { content });
  } catch (e) {
    console.error("❌ Discord webhook error:", e.message);
  }
}

function computeAvailability({ shipping }) {
  return (
    !!shipping &&
    shipping !== "PRE_ORDER_UNSELLABLE" &&
    shipping !== "OUT_OF_STOCK" &&
    shipping !== "DISCONTINUED"
  );
}

// a little friendlier qty formatting
function formatQty({ shipping, qtyRaw }) {
  const n = Number(qtyRaw);
  const oos =
    shipping === "OUT_OF_STOCK" ||
    shipping === "PRE_ORDER_UNSELLABLE" ||
    shipping === "DISCONTINUED" ||
    shipping === "undefined";
  if (oos || Number.isNaN(n)) return qtyRaw;
  return n === 0 ? "0" : "1+";
}

// open PDP only — no cart, no checkout
function openPdp() {
  if (process.platform === "win32") return exec(`start "" "${PDP_LINK}"`);
  if (process.platform === "darwin") return exec(`open "${PDP_LINK}"`);
  exec(`xdg-open "${PDP_LINK}"`);
}

// ---------- redsky params/headers ----------
const params = {
  key: "9f36aeafbe60771e321a7cc95a78140772ab3e96",
  is_bot: "false",
  tcin: TCIN,
  store_id: STORE_ID,
  zip: ZIP,
  state: STATE,
  latitude: LATITUDE,
  longitude: LONGITUDE,
  scheduled_delivery_store_id: STORE_ID,
  paid_membership: "true",
  base_membership: "true",
  card_membership: "false",
  required_store_id: STORE_ID,
  pricing_store_id: STORE_ID,
  visitor_id: genVisitorId(),
  channel: "WEB",
  page: `/p/A-${TCIN}`,
};
const baseHeaders = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  Accept: "application/json",
  Origin: "https://www.target.com",
  Referer: PDP_LINK,
};

// ---------- monitor loop ----------
async function checkStock() {
  try {
    const res = await axios.get(redskyUrl, {
      params,
      headers: baseHeaders,
      validateStatus: () => true,
      timeout: 12000,
    });

    const shipping =
      res.data?.data?.product?.fulfillment?.shipping_options?.availability_status;
    const qtyRaw =
      res.data?.data?.product?.fulfillment?.shipping_options
        ?.available_to_promise_quantity;
    const qty = formatQty({ shipping, qtyRaw });
    const isAvail = computeAvailability({ shipping });

    // console display
    const ts = new Date().toLocaleString();
    console.log(`[${ts}] Shipping: ${shipping} | Qty: ${qty}`);

    // ----- transition logging -----
    if (lastIsAvail === null) {
      // first observation: log an initial event for baseline
      logEvent(isAvail ? "IN_STOCK" : "OUT_OF_STOCK", shipping, qty);
      if (isAvail) currentWindowStartTs = Date.now();
    } else if (isAvail !== lastIsAvail) {
      // state changed → log event
      if (isAvail) {
        // OUT -> IN
        logEvent("IN_STOCK", shipping, qty);
        currentWindowStartTs = Date.now();
      } else {
        // IN -> OUT
        logEvent("OUT_OF_STOCK", shipping, qty);
        if (currentWindowStartTs != null) {
          logWindow(currentWindowStartTs, Date.now(), lastShippingSeen, lastQtySeen);
          currentWindowStartTs = null;
        }
      }
    }
    // remember last seen for window close details
    lastIsAvail = isAvail;
    lastQtySeen = qty;
    lastShippingSeen = shipping;

    // ----- trigger flow (manual-only) -----
    if (
      isAvail &&
      !firedThisWave &&
      Date.now() >= nextArmAfterTs &&
      Date.now() - lastSuccessTs >= SUCCESS_COOLDOWN_MS
    ) {
      firedThisWave = true;
      lastSuccessTs = Date.now();
      nextArmAfterTs = Date.now() + REFIRE_COOLDOWN_MS;

      await sendDiscord(
        `🚨 **Available!** Status: ${shipping} | TCIN ${TCIN} | Qty: ${qty} | [PDP](${PDP_LINK})`
      );

      console.log("➡️  Opening PDP for manual checkout…");
      openPdp();
    }

    // When it goes out of stock, clear fired flag so we can re-arm next window
    if (!isAvail) {
      firedThisWave = false;
    }
  } catch (err) {
    console.error("❌ RedSky error:", err.message);
  }
}

// graceful shutdown → close any open window log
function setupShutdownHandlers() {
  const closeWindowIfOpen = () => {
    if (currentWindowStartTs != null) {
      logWindow(currentWindowStartTs, Date.now(), lastShippingSeen, lastQtySeen);
      currentWindowStartTs = null;
    }
  };
  process.on("SIGINT", () => {
    closeWindowIfOpen();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    closeWindowIfOpen();
    process.exit(0);
  });
  process.on("beforeExit", () => {
    closeWindowIfOpen();
  });
}

// init + start
ensureLogs();

if (!DISCORD_WEBHOOK || DISCORD_WEBHOOK.trim() === "") {
  console.log("ℹ️ No DISCORD_WEBHOOK set — Discord alerts disabled (PDP popup only).");
}

setupShutdownHandlers();
setInterval(checkStock, POLL_MS);
checkStock();
