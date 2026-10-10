const express = require("express");
const http = require("http");
const pino = require("pino");
const QRCode = require("qrcode");
const { Pool } = require("pg");
const {
default: makeWASocket,
DisconnectReason,
initAuthCreds,
BufferJSON
} = require("@whiskeysockets/baileys");

const app = express();
const server = http.createServer(app);

app.use(express.json());

const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

if (!DATABASE_URL) {
console.error("DATABASE_URL hin argamne. Render Environment ilaali.");
process.exit(1);
}

const pool = new Pool({
connectionString: DATABASE_URL,
ssl: { rejectUnauthorized: false },
family: 4,
connectionTimeoutMillis: 15000,
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
let messageCount = 0;

const logger = pino({ level: "warn" });

async function initializeDatabase() {
await pool.query("CREATE TABLE IF NOT EXISTS whatsapp_auth_creds ( id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW() )");

await pool.query("CREATE TABLE IF NOT EXISTS whatsapp_auth_keys ( key_type TEXT NOT NULL, key_id TEXT NOT NULL, data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (key_type, key_id) )");

console.log("Neon database: tables qophaa'aniiru.");
}

function encodeJSON(value) {
return JSON.stringify(value, BufferJSON.replacer);
}

function decodeJSON(value) {
if (typeof value === "string") {
return JSON.parse(value, BufferJSON.reviver);
}

return JSON.parse(JSON.stringify(value), BufferJSON.reviver);
}

async function createDatabaseAuthState() {
const result = await pool.query(
"SELECT data FROM whatsapp_auth_creds WHERE id = $1",
["main"]
);

let creds;

if (result.rows.length > 0) {
creds = decodeJSON(result.rows[0].data);
console.log("WhatsApp session database irraa fe'ame.");
} else {
creds = initAuthCreds();
await pool.query(
"INSERT INTO whatsapp_auth_creds (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING",
["main", encodeJSON(creds)]
);
console.log("Session WhatsApp haaraan qophaa'e.");
}

const keys = {
async get(type, ids) {
if (!ids || ids.length === 0) return {};

  const result = await pool.query(
    `SELECT key_id, data
     FROM whatsapp_auth_keys
     WHERE key_type = $1 AND key_id = ANY($2::text[])`,
    [type, ids]
  );

  const output = {};

  for (const row of result.rows) {
    output[row.key_id] = decodeJSON(row.data);
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
             WHERE key_type = $1 AND key_id = $2`,
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
state: { creds, keys },
saveCreds: async () => {
await pool.query(
"INSERT INTO whatsapp_auth_creds (id, data, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()",
["main", encodeJSON(creds)]
);
}
};
}

const SEENAA_NABIYYII = {
"1": {
title: "Nabii Aadam (AS)",
text: "Nabii Aadam (AS) nama jalqabaa fi nabii jalqabaa ture. Rabbiin isa dhoqqee irraa uumee, waan baay'ee barsiise. Seenaa isaa irraa tawbaa fi ajaja Rabbii hordofuu baranna."
},
"2": {
title: "Nabii Nuuh (AS)",
text: "Nabii Nuuh (AS) ummata isaa gara ibaadaa Rabbii qofaatti waame. Yeroo dheeraa isaan gorse. Seenaa isaa irraa obsaa fi Rabbitti hirkachuu baranna."
},
"3": {
title: "Nabii Ibraahiim (AS)",
text: "Nabii Ibraahiim (AS) tawhiidaaf dhaabbataa ture. Waan Rabbii ajaje fudhatee, qormaata keessatti obsa agarsiise."
}
};

const SEENAA_SAHABOOTAA = {
"1": {
title: "Abuu Bakr As-Siddiiq (RA)",
text: "Abuu Bakr (RA) sahaabaa guddaa fi khalifaa jalqabaa Muslimootaa ture. Amanamummaa, arjummaa fi Nabiyyii Muhammad (SAW) deeggaruun beekama."
},
"2": {
title: "Umar ibn Al-Khattaab (RA)",
text: "Umar (RA) khalifaa lammaffaa ture. Haqa, haq-qabeessummaa fi murtii sirrii irratti beekama."
},
"3": {
title: "Uthmaan ibn Affaan (RA)",
text: "Uthmaan (RA) khalifaa sadaffaa ture. Arjummaa fi Qur'aana tiksuu keessatti gahee guddaa qaba."
},
"4": {
title: "Ali ibn Abii Taalib (RA)",
text: "Ali (RA) khalifaa afraffaa ture. Beekumsa, gootummaa fi Nabiyyii Muhammad (SAW) waliin dhiyeenya qabaachuun beekama."
}
};

function mainMenu() {
return (
"🌿 HIDAAYATUL-BAYAAN\n\n" +
"Baga nagaan dhuftan!\n\n" +
"Mee lakkoofsa filannoo keessanii ergaa:\n\n" +
"1️⃣ Seenaa Nabiyyootaa\n" +
"2️⃣ Seenaa Sahabootaa\n" +
"0️⃣ Gara jalqabaatti deebi'i\n\n" +
"📚 Barnoota Islaamaa baradhaa, hojii keessan itti fufaa."
);
}

function prophetMenu() {
return (
"📖 SEENAA NABIIYYOOTAA\n\n" +
"Lakkoofsa filadhaa:\n\n" +
"1️⃣ Nabii Aadam (AS)\n" +
"2️⃣ Nabii Nuuh (AS)\n" +
"3️⃣ Nabii Ibraahiim (AS)\n\n" +
"0️⃣ Gara menu jalqabaatti deebi'i"
);
}

function sahabaMenu() {
return (
"🌟 SEENAA SAHABOOTA NABII (SAW)\n\n" +
"Lakkoofsa filadhaa:\n\n" +
"1️⃣ Abuu Bakr As-Siddiiq (RA)\n" +
"2️⃣ Umar ibn Al-Khattaab (RA)\n" +
"3️⃣ Uthmaan ibn Affaan (RA)\n" +
"4️⃣ Ali ibn Abii Taalib (RA)\n\n" +
"0️⃣ Gara menu jalqabaatti deebi'i"
);
}

const userMenus = new Map();

async function handleIncomingMessage(message) {
if (!message.message || message.key.fromMe) return;

const jid = message.key.remoteJid;

if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast") return;

const messageType = Object.keys(message.message)[0];

let body = "";

if (messageType === "conversation") {
body = message.message.conversation;
} else if (messageType === "extendedTextMessage") {
body = message.message.extendedTextMessage.text;
} else if (messageType === "imageMessage") {
body = message.message.imageMessage.caption || "";
} else {
return;
}

const text = body.trim();
if (!text) return;

messageCount++;

const input = text.toLowerCase();
let reply;

if (
input === "hi" ||
input === "hello" ||
input === "salaam" ||
input === "salam" ||
input === "assalaamu alaykum" ||
input === "السلام عليكم" ||
input === "akkam" ||
input === "jalqaba"
) {
userMenus.set(jid, "main");
reply = mainMenu();
} else if (text === "0") {
userMenus.set(jid, "main");
reply = mainMenu();
} else if (text === "1" && (!userMenus.has(jid) || userMenus.get(jid) === "main")) {
userMenus.set(jid, "prophets");
reply = prophetMenu();
} else if (text === "2" && (!userMenus.has(jid) || userMenus.get(jid) === "main")) {
userMenus.set(jid, "sahaba");
reply = sahabaMenu();
} else if (userMenus.get(jid) === "prophets" && SEENAA_NABIYYII[text]) {
const story = SEENAA_NABIYYII[text];
reply = "📖 *${story.title}*\n\n${story.text}\n\n0️⃣ Gara menu jalqabaatti deebi'i";
} else if (userMenus.get(jid) === "sahaba" && SEENAA_SAHABOOTAA[text]) {
const story = SEENAA_SAHABOOTAA[text];
reply = "🌟 *${story.title}*\n\n${story.text}\n\n0️⃣ Gara menu jalqabaatti deebi'i";
} else {
reply =
"Filannoon kee naaf hin galle.\n\n" +
"Menu jalqabaaf 0 barreessi; menu argachuuf hi ergi.";
}

if (!sock || !connected) {
console.log("Ergaa deebisuuf WhatsApp hin walqabanne.");
return;
}

await sock.sendMessage(jid, { text: reply });
}

async function startWhatsApp() {
if (starting || stopping) return;

starting = true;

try {
console.log("WhatsApp walqabsiisuuf yaalaa jira...");

const auth = await createDatabaseAuthState();

const socket = makeWASocket({
  auth: auth.state,
  logger,
  printQRInTerminal: false,
  browser: ["Hidaayatul-Bayaan", "Chrome", "1.0.0"],
  connectTimeoutMs: 60000,
  defaultQueryTimeoutMs: 60000,
  keepAliveIntervalMs: 25000,
  markOnlineOnConnect: false,
  syncFullHistory: false
});

sock = socket;

socket.ev.on("creds.update", async () => {
  try {
    await auth.saveCreds();
  } catch (error) {
    lastError = error.message;
    console.error("Session database keessatti kuusuu hin dandeenye:", error.message);
  }
});

socket.ev.on("connection.update", async (update) => {
  const { connection, lastDisconnect, qr } = update;

  lastConnectionUpdate = new Date().toISOString();

  if (qr) {
    currentQR = await QRCode.toDataURL(qr);
    connected = false;
    console.log("QR code haaraan qophaa'e. /api/whatsapp/qr ilaali.");
  }

  if (connection === "open") {
    connected = true;
    currentQR = null;
    reconnectDelay = 5000;
    lastError = null;
    console.log("WhatsApp milkaa'inaan walqabate.");
  }

  if (connection === "close") {
    connected = false;
    currentQR = null;

    const statusCode =
      lastDisconnect?.error?.output?.statusCode;

    console.error("WhatsApp connection cufame. Status:", statusCode);

    if (statusCode === DisconnectReason.loggedOut) {
      console.error(
        "WhatsApp logout ta'e. QR code haaraa scan gochuun barbaachisa."
      );
      return;
    }

    if (!stopping) {
      if (reconnectTimer) clearTimeout(reconnectTimer);

      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        startWhatsApp().catch((error) => {
          lastError = error.message;
          console.error("Reconnect error:", error.message);
        });
      }, reconnectDelay);

      reconnectDelay = Math.min(reconnectDelay * 2, 60000);
    }
  }
});

socket.ev.on("messages.upsert", async ({ messages, type }) => {
  if (type !== "notify") return;

  for (const message of messages) {
    try {
      await handleIncomingMessage(message);
    } catch (error) {
      lastError = error.message;
      console.error("Message handler error:", error.message);
    }
  }
});

} catch (error) {
lastError = error.message;
console.error("WhatsApp start error:", error.message);

if (!stopping && !reconnectTimer) {
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startWhatsApp().catch((err) => {
      lastError = err.message;
      console.error("Restart error:", err.message);
    });
  }, reconnectDelay);

  reconnectDelay = Math.min(reconnectDelay * 2, 60000);
}

} finally {
starting = false;
}
}

function checkAdmin(req, res, next) {
if (!ADMIN_TOKEN) {
return next();
}

const provided = req.get("x-admin-token");

if (provided !== ADMIN_TOKEN) {
return res.status(401).json({ error: "Token hin sirrii taane." });
}

next();
}

app.get("/", (req, res) => {
res.send(`<!DOCTYPE html>

<html lang="om">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#087443">
<title>Hidaayatul-Bayaan</title>
<style>
body{font-family:Arial,sans-serif;background:#f0f7f2;margin:0;padding:20px;color:#173b29}
.card{max-width:520px;margin:30px auto;background:white;padding:24px;border-radius:16px;box-shadow:0 4px 20px #0001;text-align:center}
h1{color:#087443}
button{background:#087443;color:white;border:0;padding:12px 18px;border-radius:8px;font-size:16px}
#qr{max-width:280px;width:100%;margin:15px auto}
.status{padding:12px;background:#eef7ef;border-radius:8px;overflow-wrap:anywhere}
</style>
</head>
<body>
<div class="card">
<h1>🌿 Hidaayatul-Bayaan</h1>
<p>WhatsApp Barnoota Islaamaa</p>
<div class="status" id="status">Status ilaalaa jira...</div>
<div id="qrbox"></div>
<button onclick="refreshStatus()">Haaromsi</button>
<p><small>QR code kee nama biraatti hin qoodin.</small></p>
</div>
<script>
async function refreshStatus(){
 try{
  const r=await fetch('/api/status');
  const d=await r.json();
  document.getElementById('status').innerHTML =
    'WhatsApp: <b>'+ (d.connected?'Walqabate':'Hin walqabanne') +
    '</b><br>Database: '+(d.database?'Hojjechaa jira':'Rakkoo qaba')+
    '<br>Ergaa fudhatame: '+d.messages+
    (d.lastError?'<br>Dogoggora: '+d.lastError:'');
  const qr=await fetch('/api/whatsapp/qr');
  const q=await qr.json();
  document.getElementById('qrbox').innerHTML =
    q.qr ? '<p>QR code kana WhatsApp kee irraa scan godhi.</p><img id="qr" src="'+q.qr+'">' :
    (d.connected?'<p>WhatsApp walqabateera.</p>':'<p>QR code qophaa’aa jira; daqiiqaa muraasa booda haaromsi.</p>');
 }catch(e){
  document.getElementById('status').textContent='Server bira ga’uu hin dandeenye.';
 }
}
refreshStatus();
setInterval(refreshStatus,5000);
</script>
</body>
</html>`);
});app.get("/health", async (req, res) => {
try {
await pool.query("SELECT 1");
res.json({ ok: true, app: "Hidaayatul-Bayaan", database: true });
} catch (error) {
res.status(503).json({ ok: false, database: false });
}
});

app.get("/api/status", async (req, res) => {
let database = false;

try {
await pool.query("SELECT 1");
database = true;
} catch (_) {}

res.json({
app: "Hidaayatul-Bayaan",
connected,
database,
messages: messageCount,
lastConnectionUpdate,
lastError
});
});

app.get("/api/whatsapp/qr", checkAdmin, (req, res) => {
res.set("Cache-Control", "no-store");

res.json({
connected,
qr: currentQR
});
});

async function shutdown() {
if (stopping) return;
stopping = true;

if (reconnectTimer) clearTimeout(reconnectTimer);

try {
if (sock) {
sock.end(undefined);
}
} catch (_) {}

try {
await pool.end();
} catch (_) {}

server.close(() => process.exit(0));

setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

async function main() {
await initializeDatabase();

server.listen(PORT, "0.0.0.0", () => {
console.log("Hidaayatul-Bayaan server port " + PORT irratti hojjachaa jira.");
});

startWhatsApp().catch((error) => {
lastError = error.message;
console.error("WhatsApp initialization error:", error.message);
});
}

main().catch((error) => {
console.error("Server initialization failed:", error);
process.exit(1);
});
