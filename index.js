"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const pino = require("pino");

const PORT = Number(process.env.PORT || 8080);
const HOST = "0.0.0.0";

const AUTH_ROOT = path.join(process.cwd(), "sessions");

const logger = pino({
  level: "silent"
});

let makeWASocket;
let useMultiFileAuthState;
let DisconnectReason;
let Browsers;

const sessions = new Map();
const pairingLocks = new Map();

const BOT_NAME = "MayanahBot";

async function loadBaileys() {
  console.log("Loading Baileys...");

  const baileys = await import("@whiskeysockets/baileys");

  makeWASocket =
    baileys.default ||
    baileys.makeWASocket;

  useMultiFileAuthState =
    baileys.useMultiFileAuthState;

  DisconnectReason =
    baileys.DisconnectReason;

  Browsers =
    baileys.Browsers;

  if (!makeWASocket) {
    throw new Error("Baileys makeWASocket was not loaded.");
  }

  if (!useMultiFileAuthState) {
    throw new Error("useMultiFileAuthState was not loaded.");
  }

  console.log("Baileys loaded.");
}

function cleanPhone(value) {
  return String(value || "")
    .replace(/\D/g, "")
    .replace(/^0+/, "");
}

function sessionFolder(phone) {
  return path.join(AUTH_ROOT, phone);
}

function sessionExists(phone) {
  return fs.existsSync(sessionFolder(phone));
}

function jsonResponse(res, status, data) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });

  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;

      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON."));
      }
    });

    req.on("error", reject);
  });
}

function getSessionStatus(phone) {
  const session = sessions.get(phone);

  if (!session) {
    return {
      ok: true,
      exists: sessionExists(phone),
      number: phone,
      connected: false,
      registered: false,
      online: false,
      pairing: false,
      pairingCode: null
    };
  }

  const registered =
    Boolean(session.sock?.user);

  const connected =
    session.connection === "open";

  return {
    ok: true,
    exists: true,
    number: phone,
    connected,
    registered,
    online: connected && registered,
    pairing: Boolean(session.pairing),
    pairingCode:
      session.pairingCode || null,
    lastError:
      session.lastError || null
  };
}

async function connectSession(phone) {
  if (sessions.has(phone)) {
    const existing = sessions.get(phone);

    if (existing.sock) {
      return existing;
    }
  }

  fs.mkdirSync(AUTH_ROOT, {
    recursive: true
  });

  const folder =
    sessionFolder(phone);

  fs.mkdirSync(folder, {
    recursive: true
  });

  const {
    state,
    saveCreds
  } = await useMultiFileAuthState(folder);

  const session = {
    phone,
    sock: null,
    connection: "connecting",
    pairing: false,
    pairingCode: null,
    lastError: null
  };

  sessions.set(phone, session);

  const browser =
    Browsers?.macOS
      ? Browsers.macOS("Chrome")
      : ["MayanahBot", "Chrome", "1.0"];

  const sock = makeWASocket({
    auth: state,

    browser,

    printQRInTerminal: false,

    markOnlineOnConnect: false,

    syncFullHistory: false,

    generateHighQualityLinkPreview: false,

    connectTimeoutMs: 60000,

    defaultQueryTimeoutMs: 60000,

    keepAliveIntervalMs: 25000,

    logger
  });

  session.sock = sock;

  sock.ev.on(
    "creds.update",
    saveCreds
  );

  sock.ev.on(
    "connection.update",
    update => {
      const {
        connection,
        lastDisconnect
      } = update;

      if (connection) {
        session.connection =
          connection;

        console.log(
          `[${phone}] connection: ${connection}`
        );
      }

      if (connection === "open") {
        session.pairing = false;
        session.pairingCode = null;
        session.lastError = null;

        console.log(
          `[${phone}] WhatsApp connected.`
        );
      }

      if (connection === "close") {
        session.pairing = false;

        let statusCode = null;

        try {
          statusCode =
            lastDisconnect
              ?.error
              ?.output
              ?.statusCode;
        } catch {}

        if (
          statusCode ===
          DisconnectReason?.loggedOut
        ) {
          console.log(
            `[${phone}] Logged out.`
          );

          sessions.delete(phone);

        } else {

          console.log(
            `[${phone}] Connection closed.`
          );

          sessions.delete(phone);

          setTimeout(() => {
            connectSession(phone)
              .catch(error => {
                console.error(
                  `[${phone}] reconnect failed:`,
                  error.message
                );
              });
          }, 3000);
        }
      }
    }
  );

  return session;
}

async function requestPairing(phone) {
  if (pairingLocks.has(phone)) {
    throw new Error(
      "Pairing is already in progress for this number."
    );
  }

  pairingLocks.set(phone, true);

  try {
    const session =
      await connectSession(phone);

    if (
      session.sock?.user
    ) {
      throw new Error(
        "This WhatsApp account is already connected."
      );
    }

    session.pairing = true;
    session.lastError = null;

    console.log(
      `[${phone}] Requesting pairing code...`
    );

    const code =
      await session.sock.requestPairingCode(
        phone
      );

    session.pairingCode =
      code;

    console.log(
      `[${phone}] Pairing code generated: ${code}`
    );

    return code;

  } catch (error) {

    const session =
      sessions.get(phone);

    if (session) {
      session.pairing = false;
      session.lastError =
        error.message;
    }

    throw error;

  } finally {
    pairingLocks.delete(phone);
  }
}

async function disconnectSession(phone) {
  const session =
    sessions.get(phone);

  if (session?.sock) {
    try {
      await session.sock.logout();
    } catch {}
  }

  sessions.delete(phone);

  const folder =
    sessionFolder(phone);

  if (fs.existsSync(folder)) {
    fs.rmSync(folder, {
      recursive: true,
      force: true
    });
  }
}

async function handleRequest(req, res) {

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
    });

    res.end();
    return;
  }

  const url =
    new URL(
      req.url,
      `http://${req.headers.host || "localhost"}`
    );

  const pathname =
    url.pathname;

  /* SERVER HEALTH */

  if (
    req.method === "GET" &&
    pathname === "/"
  ) {
    jsonResponse(res, 200, {
      ok: true,
      service: BOT_NAME,
      engine: "baileys",
      status: "online",
      pairing: true,
      multiSession: true
    });

    return;
  }

  /* BOT STATUS */

  if (
    req.method === "GET" &&
    pathname === "/api/status"
  ) {

    const phone =
      cleanPhone(
        url.searchParams.get("number")
      );

    if (!phone) {
      jsonResponse(res, 400, {
        ok: false,
        error: "WhatsApp number is required."
      });

      return;
    }

    jsonResponse(
      res,
      200,
      getSessionStatus(phone)
    );

    return;
  }

  /* PAIR */

  if (
    req.method === "POST" &&
    pathname === "/api/pair"
  ) {

    try {

      const body =
        await readBody(req);

      const phone =
        cleanPhone(body.phone);

      if (phone.length < 8) {
        jsonResponse(res, 400, {
          ok: false,
          error: "Invalid WhatsApp number."
        });

        return;
      }

      const code =
        await requestPairing(phone);

      jsonResponse(res, 200, {
        ok: true,
        number: phone,
        pairingCode: code,
        status: "pairing"
      });

    } catch (error) {

      console.error(
        "Pairing error:",
        error
      );

      jsonResponse(res, 500, {
        ok: false,
        error:
          error.message ||
          "Pairing failed."
      });
    }

    return;
  }

  /* DISCONNECT */

  if (
    req.method === "POST" &&
    pathname === "/api/disconnect"
  ) {

    try {

      const body =
        await readBody(req);

      const phone =
        cleanPhone(body.number);

      if (!phone) {
        jsonResponse(res, 400, {
          ok: false,
          error: "WhatsApp number is required."
        });

        return;
      }

      await disconnectSession(phone);

      jsonResponse(res, 200, {
        ok: true,
        number: phone,
        status: "disconnected"
      });

    } catch (error) {

      jsonResponse(res, 500, {
        ok: false,
        error:
          error.message ||
          "Disconnect failed."
      });
    }

    return;
  }

  jsonResponse(res, 404, {
    ok: false,
    error: "Not found."
  });
}

async function start() {

  console.log("");
  console.log("================================");
  console.log("       MAYANAHBOT SERVER");
  console.log("================================");
  console.log("");

  await loadBaileys();

  fs.mkdirSync(
    AUTH_ROOT,
    {
      recursive: true
    }
  );

  const server =
    http.createServer(
      handleRequest
    );

  server.listen(
    PORT,
    HOST,
    () => {

      console.log(
        `Server running on ${HOST}:${PORT}`
      );

      console.log(
        "MayanahBot is ready."
      );

    }
  );
}

process.on(
  "SIGTERM",
  () => {
    console.log(
      "Shutting down..."
    );

    process.exit(0);
  }
);

process.on(
  "SIGINT",
  () => {
    console.log(
      "Shutting down..."
    );

    process.exit(0);
  }
);

start().catch(error => {

  console.error(
    "FATAL STARTUP ERROR:"
  );

  console.error(error);

  process.exit(1);
});