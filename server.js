const express = require("express");
const http = require("http");
const pino = require("pino");
const QRCode = require("qrcode");
const { Pool } = require("pg");

const {
  default: makeWASocket,
  DisconnectReason,
  initAuthCreds,
  BufferJSON,
  proto,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;

const logger = pino({ level: "warn" });

if (!DATABASE_URL) {
  console.error(
    "DATABASE_URL Render Environment keessatti hin argamne."
  );
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  family: 4,
  connectionTimeoutMillis: 20000,
  idleTimeoutMillis: 30000
});

let sock = null;
let currentQR = null;
let connected = false;
let starting = false;
let stopping = false;
let reconnectTimer = null;
let reconnectDelay = 5000;
let lastConnectionUpdate = null;
let lastError = null;
let lastDisconnectCode = null;
let messageCount = 0;
let databaseReady = false;

const userMenus = new Map();

/* =========================
   DATABASE
========================= */

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_auth_creds (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_auth_keys (
      key_type TEXT NOT NULL,
      key_id TEXT NOT NULL,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (key_type, key_id)
    )
  `);

  databaseReady = true;

  console.log("Database qophaa'eera.");
}

function encodeJSON(value) {
  return JSON.stringify(value, BufferJSON.replacer);
}

function decodeJSON(value) {
  const raw =
    typeof value === "string"
      ? value
      : JSON.stringify(value);

  return JSON.parse(raw, BufferJSON.reviver);
}

/* =========================
   WHATSAPP AUTH STATE
========================= */

async function createDatabaseAuthState() {
  const result = await pool.query(
    "SELECT data FROM whatsapp_auth_creds WHERE id = $1",
    ["main"]
  );

  let creds;

  if (result.rows.length > 0) {
    creds = decodeJSON(result.rows[0].data);

    console.log(
      "WhatsApp session database irraa fe'ame."
    );
  } else {
    creds = initAuthCreds();

    await pool.query(
      `INSERT INTO whatsapp_auth_creds (id, data)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      ["main", encodeJSON(creds)]
    );

    console.log("WhatsApp session haaraan uumame.");
  }

  const keys = {
    async get(type, ids) {
      if (!ids || ids.length === 0) {
        return {};
      }

      const result = await pool.query(
        `SELECT key_id, data
         FROM whatsapp_auth_keys
         WHERE key_type = $1
           AND key_id = ANY($2::text[])`,
        [type, ids]
      );

      const output = {};

      for (const row of result.rows) {
        let value = decodeJSON(row.data);

        if (
          type === "app-state-sync-key" &&
          value
        ) {
          value =
            proto.Message.AppStateSyncKeyData.fromObject(
              value
            );
        }

        output[row.key_id] = value;
      }

      return output;
    },

    async set(data) {
      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        for (const [type, entries] of Object.entries(data)) {
          for (const [id, value] of Object.entries(entries)) {
            if (value === null || value === undefined) {
              await client.query(
                `DELETE FROM whatsapp_auth_keys
                 WHERE key_type = $1
                   AND key_id = $2`,
                [type, id]
              );
            } else {
              await client.query(
                `INSERT INTO whatsapp_auth_keys
                   (key_type, key_id, data, updated_at)
                 VALUES ($1, $2, $3::jsonb, NOW())
                 ON CONFLICT (key_type, key_id)
                 DO UPDATE SET
                   data = EXCLUDED.data,
                   updated_at = NOW()`,
                [type, id, encodeJSON(value)]
              );
            }
          }
        }

        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  };

  return {
    state: {
      creds,
      keys
    },

    async saveCreds() {
      await pool.query(
        `INSERT INTO whatsapp_auth_creds
           (id, data, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (id)
         DO UPDATE SET
           data = EXCLUDED.data,
           updated_at = NOW()`,
        ["main", encodeJSON(creds)]
      );
    }
  };
}

/* =========================
   SEENAA NABIYYOOTAA
========================= */

const SEENAA_NABIYYII = {
  "1": {
    title: "Nabii Aadam (AS)",
    text:
      "Nabii Aadam (AS) nama jalqabaa fi nabii jalqabaa ture. " +
      "Rabbiin isa uume, beekumsa isa barsiise. " +
      "Seenaa isaa irraa tawbaa fi ajaja Rabbii hordofuu baranna."
  },

  "2": {
    title: "Nabii Nuuh (AS)",
    text:
      "Nabii Nuuh (AS) ummata isaa gara ibaadaa Rabbii qofaatti waame. " +
      "Yeroo dheeraa isaan gorse. " +
      "Seenaa isaa irraa obsa fi Rabbitti hirkachuu baranna."
  },

  "3": {
    title: "Nabii Ibraahiim (AS)",
    text:
      "Nabii Ibraahiim (AS) tawhiidaaf dhaabbataa ture. " +
      "Qormaata keessatti obsa agarsiise. " +
      "Seenaa isaa irraa amantii fi Rabbitti hirkachuu baranna."
  }
};

/* =========================
   SEENAA SAHABOOTAA
========================= */

const SEENAA_SAHABOOTAA = {
  "1": {
    title: "Abuu Bakr As-Siddiiq (RA)",
    text:
      "Abuu Bakr (RA) sahaabaa guddaa fi khalifaa jalqabaa ture. " +
      "Amanamummaa, arjummaa fi Nabiyyii Muhammad (SAW) deeggaruun beekama."
  },

  "2": {
    title: "Umar ibn Al-Khattaab (RA)",
    text:
      "Umar (RA) khalifaa lammaffaa ture. " +
      "Haqa eeguu fi haq-qabeessummaa irratti beekama."
  },

  "3": {
    title: "Uthmaan ibn Affaan (RA)",
    text:
      "Uthmaan (RA) khalifaa sadaffaa ture. " +
      "Arjummaa fi tajaajila Islaamaa keessatti gahee guddaa qaba."
  },

  "4": {
    title: "Ali ibn Abii Taalib (RA)",
    text:
      "Ali (RA) khalifaa afraffaa ture. " +
      "Beekumsa, gootummaa fi Nabiyyii Muhammad (SAW) waliin dhiyeenya qabaachuun beekama."
  }
};

/* =========================
   MENUS
========================= */

function mainMenu() {
  return (
    "🌿 HIDAAYATUL-BAYAAN\n\n" +
    "Baga nagaan dhuftan!\n\n" +
    "Maal barachuu barbaaddu?\n\n" +
    "1️⃣ Seenaa Nabiyyootaa\n" +
    "2️⃣ Seenaa Sahabootaa\n" +
    "0️⃣ Gara menu jalqabaatti deebi'i\n\n" +
    "📚 Barnoonni ifsaadha!"
  );
}

function prophetMenu() {
  return (
    "📖 SEENAA NABIYYOOTAA\n\n" +
    "Lakkoofsa filadhaa:\n\n" +
    "1️⃣ Nabii Aadam (AS)\n" +
    "2️⃣ Nabii Nuuh (AS)\n" +
    "3️⃣ Nabii Ibraahiim (AS)\n\n" +
    "0️⃣ Gara menu jalqabaatti deebi'i"
  );
}

function sahabaMenu() {
  return (
    "🌟 SEENAA SAHABOOTAA\n\n" +
    "Lakkoofsa filadhaa:\n\n" +
    "1️⃣ Abuu Bakr As-Siddiiq (RA)\n" +
    "2️⃣ Umar ibn Al-Khattaab (RA)\n" +
    "3️⃣ Uthmaan ibn Affaan (RA)\n" +
    "4️⃣ Ali ibn Abii Taalib (RA)\n\n" +
    "0️⃣ Gara menu jalqabaatti deebi'i"
  );
}

/* =========================
   MESSAGE TEXT
========================= */

function extractMessageText(message) {
  const content = message.message;

  if (!content) {
    return "";
  }

  if (content.conversation) {
    return content.conversation;
  }

  if (content.extendedTextMessage?.text) {
    return content.extendedTextMessage.text;
  }

  if (content.imageMessage?.caption) {
    return content.imageMessage.caption;
  }

  if (content.videoMessage?.caption) {
    return content.videoMessage.caption;
  }

  if (content.buttonsResponseMessage?.selectedButtonId) {
    return content.buttonsResponseMessage.selectedButtonId;
  }

  if (content.listResponseMessage?.singleSelectReply?.selectedRowId) {
    return content.listResponseMessage.singleSelectReply.selectedRowId;
  }

  return "";
}

/* =========================
   INCOMING MESSAGE HANDLER
========================= */

async function handleIncomingMessage(message) {
  if (
    !message ||
    !message.message ||
    message.key?.fromMe
  ) {
    return;
  }

  const jid = message.key?.remoteJid;

  if (
    !jid ||
    jid.endsWith("@g.us") ||
    jid === "status@broadcast" ||
    jid.endsWith("@broadcast")
  ) {
    return;
  }

  const body = extractMessageText(message);
  const text = String(body || "").trim();

  if (!text) {
    return;
  }

  messageCount++;

  const input = text.toLowerCase();
  const currentMenu = userMenus.get(jid) || "main";

  let reply;

  const greetings = [
    "hi",
    "hello",
    "salaam",
    "salam",
    "assalaamu alaykum",
    "assalamu alaikum",
    "السلام عليكم",
    "akkam",
    "jalqaba",
    "menu"
  ];

  if (greetings.includes(input)) {
    userMenus.set(jid, "main");
    reply = mainMenu();
  } else if (text === "0") {
    userMenus.set(jid, "main");
    reply = mainMenu();
  } else if (
    text === "1" &&
    currentMenu === "main"
  ) {
    userMenus.set(jid, "prophets");
    reply = prophetMenu();
  } else if (
    text === "2" &&
    currentMenu === "main"
  ) {
    userMenus.set(jid, "sahaba");
    reply = sahabaMenu();
  } else if (
    currentMenu === "prophets" &&
    SEENAA_NABIYYII[text]
  ) {
    const story = SEENAA_NABIYYII[text];

    reply =
      `📖 *${story.title}*\n\n` +
      `${story.text}\n\n` +
      "0️⃣ Gara menu jalqabaatti deebi'i";
  } else if (
    currentMenu === "sahaba" &&
    SEENAA_SAHABOOTAA[text]
  ) {
    const story = SEENAA_SAHABOOTAA[text];

    reply =
      `🌟 *${story.title}*\n\n` +
      `${story.text}\n\n` +
      "0️⃣ Gara menu jalqabaatti deebi'i";
  } else {
    reply =
      "Filannoon kee naaf hin galle.\n\n" +
      "Menu jalqabaaf 0 barreessi.\n" +
      "Menu argachuuf hi ergi.";
  }

  if (!sock || !connected) {
    console.log(
      "Ergaa argameef deebii erguun hin danda'amne: WhatsApp hin walqabanne."
    );
    return;
  }

  await sock.sendMessage(jid, {
    text: reply
  });
}

/* =========================
   RECONNECT
========================= */

function scheduleReconnect() {
  if (stopping || reconnectTimer) {
    return;
  }

  const delay = reconnectDelay;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;

    startWhatsApp().catch((error) => {
      lastError = error.message;

      console.error(
        "Reconnect error:",
        error.stack || error.message
      );
    });
  }, delay);

  reconnectDelay = Math.min(
    reconnectDelay * 2,
    60000
  );

  console.log(
    "WhatsApp yeroo " +
      delay / 1000 +
      " sekondii booda irra deebi'a."
  );
}

/* =========================
   WHATSAPP CONNECTION
========================= */

async function startWhatsApp() {
  if (starting || stopping) {
    return;
  }

  starting = true;

  try {
    console.log(
      "WhatsApp walqabsiisuuf yaalaa jira..."
    );

    const auth = await createDatabaseAuthState();

    let version;

    /*
      Version Baileys yeroo ammaa argachuuf yaala.
      Yoo endpoint version hin hojjenne, Baileys
      version isaa keessaa jiru fayyadamuuf itti fufa.
    */

    if (typeof fetchLatestBaileysVersion === "function") {
      try {
        const versionInfo =
          await fetchLatestBaileysVersion();

        if (
          versionInfo &&
          Array.isArray(versionInfo.version)
        ) {
          version = versionInfo.version;

          console.log(
            "Baileys version argame:",
            version.join(".")
          );
        }
      } catch (versionError) {
        console.error(
          "Version haaraa argachuun hin danda'amne; version keessaa jiru fayyadama:",
          versionError.message
        );
      }
    } else {
      console.log(
        "Version checker hin argamne; version keessaa jiru fayyadama."
      );
    }

    const socket = makeWASocket({
      ...(version ? { version } : {}),

      auth: auth.state,
      logger,

      printQRInTerminal: false,

      browser: [
        "Hidaayatul-Bayaan",
        "Chrome",
        "1.0.0"
      ],

      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,

      markOnlineOnConnect: false,
      syncFullHistory: false,
      emitOwnEvents: false
    });

    sock = socket;

    socket.ev.on("creds.update", async () => {
      try {
        await auth.saveCreds();
      } catch (error) {
        lastError = error.message;

        console.error(
          "Session kuusuu hin dandeenye:",
          error.message
        );
      }
    });

    socket.ev.on(
      "connection.update",
      async (update) => {
        const {
          connection,
          lastDisconnect,
          qr
        } = update;

        lastConnectionUpdate =
          new Date().toISOString();

        if (qr) {
          try {
            currentQR = await QRCode.toDataURL(qr);
            connected = false;

            console.log("QR Code qophaa'e.");
          } catch (error) {
            lastError = error.message;

            console.error(
              "QR Code uumuu hin dandeenye:",
              error.message
            );
          }
        }

        if (connection === "connecting") {
          console.log(
            "WhatsApp connection jalqabaa jira..."
          );
        }

        if (connection === "open") {
          connected = true;
          currentQR = null;
          reconnectDelay = 5000;
          lastError = null;
          lastDisconnectCode = null;

          console.log(
            "WhatsApp milkaa'inaan walqabate."
          );
        }

        if (connection === "close") {
          connected = false;
          currentQR = null;

          if (sock === socket) {
            sock = null;
          }

          const statusCode =
            lastDisconnect?.error?.output?.statusCode ??
            lastDisconnect?.error?.statusCode ??
            null;

          const errorMessage =
            lastDisconnect?.error?.message ||
            "Sababni connection cufame ifatti hin beekamu.";

          const errorName =
            lastDisconnect?.error?.name || null;

          const errorData =
            lastDisconnect?.error?.output?.payload ||
            null;

          lastDisconnectCode = statusCode;
          lastError = errorMessage;

          console.error(
            "WhatsApp connection close details:",
            JSON.stringify(
              {
                statusCode,
                errorName,
                errorMessage,
                errorData
              },
              null,
              2
            )
          );

          if (
            statusCode === DisconnectReason.loggedOut
          ) {
            lastError =
              "WhatsApp logout ta'e. QR Code haaraa scan gochuun barbaachisa.";

            console.error(lastError);
            return;
          }

          if (
            statusCode ===
            DisconnectReason.connectionReplaced
          ) {
            lastError =
              "WhatsApp connection biraan bakka bu'e. Instance biraa hojjechaa jiraachuu isaa mirkaneessi.";

            console.error(lastError);
          }

          if (
            statusCode ===
            DisconnectReason.restartRequired
          ) {
            console.log(
              "WhatsApp restart barbaada; irra deebi'ee jalqaba."
            );
          }

          if (!stopping) {
            scheduleReconnect();
          }
        }
      }
    );

    socket.ev.on(
      "messages.upsert",
      async ({ messages, type }) => {
        if (type !== "notify") {
          return;
        }

        for (const message of messages) {
          try {
            await handleIncomingMessage(message);
          } catch (error) {
            lastError = error.message;

            console.error(
              "Message handler error:",
              error.stack || error.message
            );
          }
        }
      }
    );
  } catch (error) {
    lastError = error.message;

    console.error(
      "WhatsApp start error:",
      error.stack || error.message
    );

    if (!stopping) {
      scheduleReconnect();
    }
  } finally {
    starting = false;
  }
}

/* =========================
   WEBSITE
========================= */

app.get("/", (req, res) => {
  res.set("Cache-Control", "no-store");

  res.type("html").send(`<!DOCTYPE html>
<html lang="om">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#087443">

<title>Hidaayatul-Bayaan</title>

<style>
*{box-sizing:border-box}

body{
  font-family:Arial,sans-serif;
  background:#f0f7f2;
  margin:0;
  padding:18px;
  color:#173b29
}

.card{
  max-width:520px;
  margin:25px auto;
  background:white;
  padding:24px;
  border-radius:16px;
  box-shadow:0 4px 20px #0001;
  text-align:center
}

h1{color:#087443}

button{
  background:#087443;
  color:white;
  border:0;
  padding:12px 18px;
  border-radius:8px;
  font-size:16px;
  cursor:pointer
}

button:disabled{
  opacity:.6
}

#qr{
  max-width:280px;
  width:100%;
  margin:15px auto;
  display:block
}

.status{
  padding:12px;
  background:#eef7ef;
  border-radius:8px;
  overflow-wrap:anywhere;
  line-height:1.8;
  text-align:left
}

.small{
  font-size:13px;
  color:#555
}

.warning{
  padding:12px;
  border-radius:8px;
  background:#fff3cd;
  color:#674d03;
  font-size:13px;
  line-height:1.6
}
</style>
</head>

<body>
<div class="card">
  <h1>🌿 Hidaayatul-Bayaan</h1>

  <p>WhatsApp Barnoota Islaamaa</p>

  <div class="status" id="status">
    Server ilaalaa jira...
  </div>

  <div id="qrbox">
    <p>QR Code qopheessaa jira...</p>
  </div>

  <button id="refreshButton" onclick="refreshStatus()">
    Haaromsi
  </button>

  <p class="warning">
    QR Code kee nama biraatti hin qoodin.
    QR Code kana WhatsApp kee waliin walqabsiisuuf
    qofa fayyadami. Namni website kana argate QR
    Code kee arguu danda'a.
  </p>

  <p class="small">📚 Barnoonni ifsaadha!</p>
</div>

<script>
function escapeHTML(value){
  return String(value ?? '').replace(/[&<>"']/g,function(c){
    return {
      '&':'&amp;',
      '<':'&lt;',
      '>':'&gt;',
      '"':'&quot;',
      "'":'&#39;'
    }[c];
  });
}

let refreshing = false;

async function refreshStatus(){
  if(refreshing) return;

  refreshing = true;

  const button = document.getElementById('refreshButton');
  button.disabled = true;

  try{
    const response = await fetch('/api/status', {
      cache: 'no-store'
    });

    if(!response.ok){
      throw new Error('Status API hin hojjenne.');
    }

    const data = await response.json();

    const statusElement = document.getElementById('status');

    statusElement.innerHTML =
      'WhatsApp: <b>' +
      (data.connected ? 'Walqabateera ✅' : 'Hin walqabanne') +
      '</b><br>' +
      'Database: ' +
      (data.database ? 'Hojjechaa jira ✅' : 'Rakkoo qaba ❌') +
      '<br>Ergaa fudhatame: ' +
      escapeHTML(data.messages) +
      (data.lastDisconnectCode
        ? '<br>Disconnect code: ' +
          escapeHTML(data.lastDisconnectCode)
        : '') +
      (data.lastError
        ? '<br>Dogoggora: ' +
          escapeHTML(data.lastError)
        : '');

    const qrResponse = await fetch('/api/whatsapp/qr', {
      cache: 'no-store'
    });

    if(!qrResponse.ok){
      throw new Error('QR API hin hojjenne.');
    }

    const qrData = await qrResponse.json();
    const qrbox = document.getElementById('qrbox');

    if(data.connected){
      qrbox.innerHTML =
        '<h3>WhatsApp walqabateera! ✅</h3>' +
        '<p>Bot kee ergaa fudhachuuf qophaa’eera.</p>';
    } else if(qrData.qr){
      const image = document.createElement('img');

      image.id = 'qr';
      image.alt = 'WhatsApp QR Code';
      image.src = qrData.qr;

      qrbox.replaceChildren();

      const heading = document.createElement('h3');
      heading.textContent = '📱 QR Code WhatsApp';

      const instruction = document.createElement('p');
      instruction.textContent =
        'WhatsApp kee irraa QR kana scan godhi.';

      const note = document.createElement('p');
      note.textContent =
        'Yoo QR hin hojjanne, button Haaromsi jedhu tuqi.';

      qrbox.append(heading, instruction, image, note);
    } else {
      qrbox.innerHTML =
        '<p>QR Code qophaa’aa jira. ' +
        'Muraasa eegiitii haaromsi.</p>';
    }
  } catch(error) {
    document.getElementById('status').textContent =
      'Server bira ga’uu hin dandeenye. ' +
      'Daqiiqaa muraasa booda irra deebi’i.';

    console.error(error);
  } finally {
    refreshing = false;
    button.disabled = false;
  }
}

refreshStatus();
setInterval(refreshStatus, 5000);
</script>
</body>
</html>`);
});

/* =========================
   HEALTH
========================= */

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      app: "Hidaayatul-Bayaan",
      database: true,
      connected,
      databaseReady
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      app: "Hidaayatul-Bayaan",
      database: false,
      error: error.message
    });
  }
});

/* =========================
   STATUS API
========================= */

app.get("/api/status", async (req, res) => {
  let database = false;

  try {
    await pool.query("SELECT 1");
    database = true;
  } catch (error) {
    console.error(
      "Database status error:",
      error.message
    );
  }

  res.set("Cache-Control", "no-store");

  res.json({
    app: "Hidaayatul-Bayaan",
    connected,
    database,
    databaseReady,
    messages: messageCount,
    lastConnectionUpdate,
    lastDisconnectCode,
    lastError
  });
});

/* =========================
   QR CODE API
========================= */

/*
  Hubachiisa nageenyaa:
  Endpoint kun token hin gaafatu.
  Kanaaf namni website kana bane QR Code arguu danda'a.
  QR Code kee nama biraatti hin qoodin.
*/

app.get("/api/whatsapp/qr", (req, res) => {
  res.set("Cache-Control", "no-store");

  res.json({
    connected,
    qr: connected ? null : currentQR
  });
});

/* =========================
   NOT FOUND
========================= */

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Endpoint hin argamne."
  });
});

/* =========================
   ERROR HANDLER
========================= */

app.use((error, req, res, next) => {
  console.error(
    "Express error:",
    error.stack || error.message
  );

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    ok: false,
    error: "Dogoggora server."
  });
});

/* =========================
   SHUTDOWN
========================= */

async function shutdown() {
  if (stopping) {
    return;
  }

  stopping = true;

  console.log("Server cufamaa jira...");

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    if (sock) {
      sock.end(undefined);
      sock = null;
    }
  } catch (error) {
    console.error(
      "WhatsApp shutdown warning:",
      error.message
    );
  }

  await new Promise((resolve) => {
    server.close(() => resolve());
  }).catch(() => {});

  try {
    await pool.end();
  } catch (error) {
    console.error(
      "Database shutdown warning:",
      error.message
    );
  }

  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

/* =========================
   START SERVER
========================= */

async function main() {
  await initializeDatabase();

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };

    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);

    server.listen(PORT, "0.0.0.0");
  });

  console.log(
    "Hidaayatul-Bayaan port " +
      PORT +
      " irratti hojjachaa jira."
  );

  startWhatsApp().catch((error) => {
    lastError = error.message;

    console.error(
      "WhatsApp initialization error:",
      error.stack || error.message
    );

    scheduleReconnect();
  });
}

main().catch((error) => {
  console.error(
    "Server initialization failed:",
    error.stack || error.message
  );

  process.exit(1);
});
