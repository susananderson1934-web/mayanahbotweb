const http = require("http");
const fs = require("fs");
const path = require("path");
const pino = require("pino");

const PORT = process.env.PORT || 8080;
const HOST = "0.0.0.0";

const sessions = new Map();
const pairingLocks = new Map();

const SESSIONS_DIR = path.join(__dirname, "sessions");

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

const logger = pino({
  level: "silent"
});

let baileys = null;

/* -------------------------------------------------------
   BAILEYS
------------------------------------------------------- */

async function loadBaileys() {
  if (!baileys) {
    console.log("Loading Baileys...");

    baileys = await import("@whiskeysockets/baileys");

    console.log("Baileys loaded.");
  }

  return baileys;
}

/* -------------------------------------------------------
   PHONE NUMBER
------------------------------------------------------- */

function normalizePhone(value) {
  if (typeof value !== "string") {
    return null;
  }

  let phone = value.trim();

  // Remove spaces, +, -, brackets and any other
  // non-numeric characters.
  phone = phone.replace(/\D/g, "");

  // Nigerian local format:
  // 08012345678 -> 2348012345678
  if (phone.startsWith("0") && phone.length === 11) {
    phone = "234" + phone.slice(1);
  }

  // Remove accidental leading 00:
  // 002348012345678 -> 2348012345678
  if (phone.startsWith("00")) {
    phone = phone.slice(2);
  }

  // WhatsApp international numbers should normally
  // contain a country code and be within this range.
  if (!/^[1-9]\d{9,14}$/.test(phone)) {
    return null;
  }

  return phone;
}

/* -------------------------------------------------------
   SESSION DIRECTORY
------------------------------------------------------- */

function sessionDirectory(phone) {
  return path.join(SESSIONS_DIR, phone);
}

/* -------------------------------------------------------
   JSON RESPONSE
------------------------------------------------------- */

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);

  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods":
      "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type",
    "Cache-Control":
      "no-store"
  });

  res.end(body);
}

/* -------------------------------------------------------
   REQUEST BODY
------------------------------------------------------- */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk.toString();

      if (body.length > 1024 * 1024) {
        reject(
          new Error("Request body too large.")
        );

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
        reject(
          new Error("Invalid JSON.")
        );
      }
    });

    req.on("error", reject);
  });
}

/* -------------------------------------------------------
   PAIRING LOCK
------------------------------------------------------- */

async function acquirePairingLock(phone) {
  const existing = pairingLocks.get(phone);

  if (existing) {
    await existing;
  }

  let release;

  const lock = new Promise(resolve => {
    release = resolve;
  });

  pairingLocks.set(phone, lock);

  return () => {
    if (pairingLocks.get(phone) === lock) {
      pairingLocks.delete(phone);
    }

    release();
  };
}

/* -------------------------------------------------------
   CREATE WHATSAPP SESSION
------------------------------------------------------- */

async function createSession(phone) {
  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
  } = await loadBaileys();

  const sessionPath =
    sessionDirectory(phone);

  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, {
      recursive: true
    });
  }

  const {
    state,
    saveCreds
  } = await useMultiFileAuthState(
    sessionPath
  );

  let version;

  try {
    const latest =
      await fetchLatestBaileysVersion();

    version = latest.version;

    console.log(
      `[${phone}] WhatsApp version: ${version.join(".")}`
    );
  } catch (error) {
    console.log(
      `[${phone}] Could not fetch latest WhatsApp version. Using Baileys default.`
    );
  }

  const socketOptions = {
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(
        state.keys,
        logger
      )
    },

    logger,

    printQRInTerminal: false,

    markOnlineOnConnect: false,

    syncFullHistory: false,

    connectTimeoutMs: 60000,

    defaultQueryTimeoutMs: 60000,

    keepAliveIntervalMs: 30000
  };

  if (version) {
    socketOptions.version = version;
  }

  const sock =
    makeWASocket(socketOptions);

  const session = {
    phone,
    sock,
    state,
    saveCreds,
    connected: false,
    pairing: false,
    createdAt: Date.now(),
    lastUpdate: Date.now()
  };

  sessions.set(phone, session);

  /* ---------------------------------------------------
     CREDENTIAL UPDATES
  --------------------------------------------------- */

  sock.ev.on(
    "creds.update",
    saveCreds
  );

  /* ---------------------------------------------------
     CONNECTION EVENTS
  --------------------------------------------------- */

  sock.ev.on(
    "connection.update",
    async update => {
      const {
        connection,
        lastDisconnect
      } = update;

      session.lastUpdate = Date.now();

      if (connection === "open") {
        session.connected = true;
        session.pairing = false;

        console.log(
          `[${phone}] WhatsApp connected.`
        );
      }

      if (connection === "close") {
        session.connected = false;

        let statusCode = null;

        try {
          statusCode =
            lastDisconnect
              ?.error
              ?.output
              ?.statusCode;
        } catch {}

        const loggedOut =
          statusCode ===
          DisconnectReason.loggedOut;

        console.log(
          `[${phone}] WhatsApp connection closed. Status: ${statusCode || "unknown"}`
        );

        if (loggedOut) {
          session.pairing = false;

          sessions.delete(phone);

          try {
            await sock.end(
              new Error("Logged out")
            );
          } catch {}

          console.log(
            `[${phone}] Session logged out.`
          );

          return;
        }

        /*
         * Reconnect after temporary connection
         * failures.
         */
        setTimeout(async () => {
          const current =
            sessions.get(phone);

          if (
            current &&
            current.sock === sock
          ) {
            try {
              await createSession(phone);
            } catch (error) {
              console.error(
                `[${phone}] Reconnect failed:`,
                error.message
              );
            }
          }
        }, 3000);
      }
    }
  );

  return session;
}

/* -------------------------------------------------------
   GET OR CREATE SESSION
------------------------------------------------------- */

async function getOrCreateSession(phone) {
  const existing =
    sessions.get(phone);

  if (
    existing &&
    existing.sock
  ) {
    return existing;
  }

  return createSession(phone);
}

/* -------------------------------------------------------
   PAIR NUMBER
------------------------------------------------------- */

async function pairNumber(phone) {
  const release =
    await acquirePairingLock(phone);

  try {
    let session =
      sessions.get(phone);

    if (
      session &&
      session.state &&
      session.state.creds &&
      session.state.creds.registered
    ) {
      return {
        ok: true,
        alreadyConnected: true,
        connected: session.connected
      };
    }

    if (!session) {
      session =
        await createSession(phone);
    }

    /*
     * Give the socket a short moment to establish
     * its initial connection before requesting
     * the pairing code.
     */
    await new Promise(resolve =>
      setTimeout(resolve, 1500)
    );

    session.pairing = true;

    console.log(
      `[${phone}] Requesting pairing code...`
    );

    const code =
      await session.sock.requestPairingCode(
        phone
      );

    console.log(
      `[${phone}] Pairing code generated.`
    );

    return {
      ok: true,
      code,
      number: phone
    };

  } finally {
    release();
  }
}

/* -------------------------------------------------------
   DISCONNECT
------------------------------------------------------- */

async function disconnectNumber(phone) {
  const session =
    sessions.get(phone);

  if (!session) {
    return {
      ok: true,
      disconnected: true
    };
  }

  try {
    await session.sock.logout();
  } catch (error) {
    console.log(
      `[${phone}] Logout error: ${error.message}`
    );

    try {
      session.sock.end(
        new Error("Disconnected")
      );
    } catch {}
  }

  sessions.delete(phone);

  return {
    ok: true,
    disconnected: true
  };
}

/* -------------------------------------------------------
   STATUS
------------------------------------------------------- */

function getNumberStatus(phone) {
  const session =
    sessions.get(phone);

  if (!session) {
    return {
      ok: true,
      number: phone,
      connected: false,
      pairing: false,
      status: "not_connected"
    };
  }

  return {
    ok: true,
    number: phone,
    connected:
      session.connected === true,
    pairing:
      session.pairing === true,
    registered:
      session.state?.creds?.registered === true,
    status:
      session.connected
        ? "connected"
        : session.pairing
          ? "pairing"
          : "connecting"
  };
}

/* -------------------------------------------------------
   HTTP SERVER
------------------------------------------------------- */

const server =
  http.createServer(
    async (req, res) => {

      /*
       * CORS preflight
       */
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods":
            "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type"
        });

        res.end();

        return;
      }

      const url =
        new URL(
          req.url,
          `http://${req.headers.host}`
        );

      const pathname =
        url.pathname;

      /* ---------------------------------------------
         HEALTH
      --------------------------------------------- */

      if (
        req.method === "GET" &&
        pathname === "/"
      ) {
        sendJson(res, 200, {
          ok: true,
          service: "MayanahBot",
          engine: "baileys",
          status: "online",
          pairing: true,
          multiSession: true
        });

        return;
      }

      /* ---------------------------------------------
         API STATUS
      --------------------------------------------- */

      if (
        req.method === "GET" &&
        pathname === "/api/status"
      ) {
        const rawNumber =
          url.searchParams.get(
            "number"
          );

        const phone =
          normalizePhone(
            rawNumber || ""
          );

        if (!phone) {
          sendJson(res, 400, {
            ok: false,
            error:
              "Invalid WhatsApp number."
          });

          return;
        }

        sendJson(
          res,
          200,
          getNumberStatus(phone)
        );

        return;
      }

      /* ---------------------------------------------
         API PAIR
      --------------------------------------------- */

      if (
        req.method === "POST" &&
        pathname === "/api/pair"
      ) {
        try {
          const body =
            await readBody(req);

          const phone =
            normalizePhone(
              body.number || ""
            );

          if (!phone) {
            sendJson(res, 400, {
              ok: false,
              error:
                "Invalid WhatsApp number."
            });

            return;
          }

          /*
           * Do not allow two pairing-code requests
           * for the same number at once.
           */
          const result =
            await pairNumber(phone);

          sendJson(
            res,
            200,
            result
          );

        } catch (error) {
          console.error(
            "Pairing error:",
            error
          );

          sendJson(res, 500, {
            ok: false,
            error:
              error?.message ||
              "Unable to generate pairing code."
          });
        }

        return;
      }

      /* ---------------------------------------------
         API DISCONNECT
      --------------------------------------------- */

      if (
        req.method === "POST" &&
        pathname === "/api/disconnect"
      ) {
        try {
          const body =
            await readBody(req);

          const phone =
            normalizePhone(
              body.number || ""
            );

          if (!phone) {
            sendJson(res, 400, {
              ok: false,
              error:
                "Invalid WhatsApp number."
            });

            return;
          }

          const result =
            await disconnectNumber(
              phone
            );

          sendJson(
            res,
            200,
            result
          );

        } catch (error) {
          console.error(
            "Disconnect error:",
            error
          );

          sendJson(res, 500, {
            ok: false,
            error:
              error?.message ||
              "Unable to disconnect."
          });
        }

        return;
      }

      /* ---------------------------------------------
         NOT FOUND
      --------------------------------------------- */

      sendJson(res, 404, {
        ok: false,
        error: "Not found."
      });
    }
  );

/* -------------------------------------------------------
   SERVER START
------------------------------------------------------- */

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

/* -------------------------------------------------------
   PROCESS SAFETY
------------------------------------------------------- */

process.on(
  "uncaughtException",
  error => {
    console.error(
      "Uncaught exception:",
      error
    );
  }
);

process.on(
  "unhandledRejection",
  error => {
    console.error(
      "Unhandled rejection:",
      error
    );
  }
);
