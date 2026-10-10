const express = require("express");
const { Pool } = require("pg");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");
const P = require("pino");

const app = express();

app.use(express.json({ limit: "1mb" }));

// ========================================
// 1. CONFIGURATION
// ========================================

const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_CODE = process.env.ADMIN_CODE || "";

const AUTH_DIR =
  process.env.AUTH_DIR ||
  path.join("/tmp", "hidaayatul-bayaan-auth");

if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL hin argamne!");
  process.exit(1);
}

// ========================================
// 2. DATABASE CONNECTION
// ========================================

const pool = new Pool({
  connectionString: DATABASE_URL,

  ssl:
    process.env.DATABASE_SSL === "false"
      ? false
      : { rejectUnauthorized: false },

  family: 4,
  connectionTimeoutMillis: 15000,
  idleTimeoutMillis: 30000
});

pool.on("error", (error) => {
  console.error("DATABASE POOL ERROR:", error.message);
});

// ========================================
// 3. WHATSAPP VARIABLES
// ========================================

let sock = null;
let latestQR = null;
let connected = false;
let starting = false;
let loggedOut = false;
let reconnectTimer = null;
let shuttingDown = false;

const seenMessages = new Set();
const MAX_SEEN_MESSAGES = 2000;

// ========================================
// 4. DATABASE INITIALIZATION
// ========================================

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_users (
      id BIGSERIAL PRIMARY KEY,
      phone TEXT UNIQUE NOT NULL,
      name TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS bot_exams (
      id BIGSERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      subject TEXT DEFAULT 'Islaamaa',
      teacher_phone TEXT NOT NULL,
      questions JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS bot_results (
      id BIGSERIAL PRIMARY KEY,
      exam_code TEXT NOT NULL,
      student_phone TEXT NOT NULL,
      student_name TEXT DEFAULT '',
      score INTEGER NOT NULL,
      total INTEGER NOT NULL,
      answers JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(exam_code, student_phone)
    );
  `);

  console.log("Database tables qophaa'aniiru.");
}

// ========================================
// 5. HELPER FUNCTIONS
// ========================================

function normalizePhone(jid) {
  if (!jid) return "";

  return String(jid)
    .split("@")[0]
    .split(":")[0]
    .replace(/\D/g, "");
}

function randomCode() {
  return (
    "HB" +
    Math.random()
      .toString(36)
      .slice(2, 8)
      .toUpperCase()
  );
}

function rememberMessage(id) {
  if (!id) return false;

  if (seenMessages.has(id)) {
    return true;
  }

  seenMessages.add(id);

  if (seenMessages.size > MAX_SEEN_MESSAGES) {
    const first = seenMessages.values().next().value;
    seenMessages.delete(first);
  }

  return false;
}

// ========================================
// 6. WHATSAPP MESSAGE TEXT EXTRACTOR
// ========================================

function extractMessageText(message) {
  if (!message) return "";

  let msg = message;

  // Ergaa WhatsApp marfame hiikuu
  for (let i = 0; i < 5; i++) {
    if (msg.ephemeralMessage?.message) {
      msg = msg.ephemeralMessage.message;
      continue;
    }

    if (msg.viewOnceMessage?.message) {
      msg = msg.viewOnceMessage.message;
      continue;
    }

    if (msg.viewOnceMessageV2?.message) {
      msg = msg.viewOnceMessageV2.message;
      continue;
    }

    if (msg.documentWithCaptionMessage?.message) {
      msg = msg.documentWithCaptionMessage.message;
      continue;
    }

    break;
  }

  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    msg.buttonsResponseMessage?.selectedButtonId ||
    msg.listResponseMessage?.singleSelectReply?.selectedRowId ||
    msg.templateButtonReplyMessage?.selectedId ||
    ""
  ).trim();
}

// ========================================
// 7. MAIN MENU
// ========================================

function menu() {
  return `📚 *HIDAAYATUL-BAYAAN*

Assalaamu'alaykum warahmatullaahi wabarakaatuh!

Barnoota Islaamaa argachuuf filadhu:

1️⃣ Barnoota Islaamaa
2️⃣ Seenaa Nabiyyii Muhammad ﷺ
3️⃣ Seenaa Sahabootaa
4️⃣ Gaaffii fi Deebii
5️⃣ Qormaata Fudhadhu
6️⃣ Qabxii Koo
7️⃣ Qajeelfama Barsiisaa

Lakkoofsa filannoo ergi.

Fakkeenya:
1
2
3
4
5 HB123ABC

Gaaffii barnootaa yoo qabaatte,
gaaffii kee guutuu barreessi.`;
}

// ========================================
// 8. ISLAMIC LESSONS
// ========================================

const lessons = {
  "1": `📚 *BARNOOTA ISLAAMAA*

Islaamni amantii Rabbiin Nabiyyii Muhammad ﷺ irratti buusee dha.

*Utubaalee Islaamaa shan:*

1. Shahadaa
2. Salaata
3. Zakaa
4. Sawmii Ramadaanaa
5. Hajjii nama danda'uuf.

*Utubaalee Iimaanaa jahan:*

1. Rabbiitti amanuu
2. Malaayikootaatti amanuu
3. Kitaabota Rabbiitti amanuu
4. Ergamtoota Rabbiitti amanuu
5. Guyyaa Qiyaamaatti amanuu
6. Qadaraatti amanuu.

Barnoota biraa argachuuf MENU ergi.`,

  "2": `🌙 *SEENAA NABII MUHAMMAD ﷺ*

Nabiyyiin Muhammad ﷺ Makkah keessatti bara Filaa keessatti dhalatan.

Abbaan isaanii Abdullah, haati isaanii Aamina bint Wahb turan.

Abbaan isaanii osoo isaan hin dhalatin dura du'an. Haati isaanii yeroo ijoollummaa isaanii duute.

Jalqaba akaakayyuun isaanii Abdul-Muxxalib, sana booda abbeeraan isaanii Abu Xaalib isaan kunuunsan.

Waggaa 40tti wahyiin isaanitti jalqabe.

Malaaykaan Jibriil عليه السلام Qur'aana irraa aayata jalqabaa Suuraa Al-Alaq isaanitti fide.

Islaamatti namoota waaman. Makkah keessatti rakkina hedduu obsan.

Bara 622 Miilaaditti gara Madiinaa hijraa godhan.

Madiinaa keessatti hawaasa Islaamaa ijaaranii ummata barsiisan.

Bara 632 Miilaaditti Madiinaa keessatti du'an ﷺ.

Seenaa biraa argachuuf MENU ergi.`,

  "3": `🕌 *SEENAA SAHABOOTAA*

Sahaboonni Nabiyyii Muhammad ﷺ arganii, isaanitti amananii fi Islaama irratti du'aniidha.

1. Abu Bakr As-Siddiiq رضي الله عنه
   Khaliifaa jalqabaa.

2. Umar ibn Al-Khaxxaab رضي الله عنه
   Khaliifaa lammaffaa.

3. Uthmaan ibn Affaan رضي الله عنه
   Khaliifaa sadaffaa.

4. Ali ibn Abi Xaalib رضي الله عنه
   Khaliifaa afraffaa.

5. Bilaal ibn Rabaah رضي الله عنه
   Mu'azzina beekamaa.

6. Khadiija bint Khuwaylid رضي الله عنها
   Haadha warraa Nabiyyii ﷺ isa jalqabaa fi namoota jalqabaa amanan keessaa tokko.

Sahaboota biroo barachuuf MENU ergi.`,

  "4": `❓ *GAAFFII FI DEEBII*

Gaaffii kee ergaa itti aanutti barreessi.

Fakkeenya:

- Utubaaleen Islaamaa meeqa?
- Nabiyyiin Muhammad ﷺ eessatti dhalatan?
- Malaaykaan wahyii fidu eenyu?
- Utubaaleen Iimaanaa meeqa?

Deebiin ani kennu odeeffannoo barnootaa dursee qophaa'e irratti hundaa'a.

Gaaffii fatwaa murteessaa irratti hayyuu amanamaa gaafadhu.`
};

// ========================================
// 9. SAVE USER
// ========================================

async function saveUser(phone, name) {
  if (!phone) return;

  await pool.query(
    `
    INSERT INTO bot_users(phone, name)
    VALUES($1, $2)

    ON CONFLICT(phone)
    DO UPDATE SET
      name = CASE
        WHEN EXCLUDED.name <> ''
        THEN EXCLUDED.name
        ELSE bot_users.name
      END
    `,
    [phone, name || ""]
  );
}

// ========================================
// 10. SEND WHATSAPP MESSAGE
// ========================================

async function sendText(jid, text) {
  if (!sock || !connected) {
    console.error(
      "SEND ERROR: WhatsApp hin walqabanne.",
      jid
    );

    return false;
  }

  try {
    await sock.sendMessage(jid, {
      text: String(text)
    });

    console.log("SEND SUCCESS:", jid);

    return true;
  } catch (error) {
    console.error(
      "SEND MESSAGE ERROR:",
      error.stack || error
    );

    return false;
  }
}

// ========================================
// 11. GET EXAM
// ========================================

async function getExam(code) {
  const result = await pool.query(
    `
    SELECT *
    FROM bot_exams
    WHERE code = $1
    `,
    [String(code).toUpperCase()]
  );

  return result.rows[0];
}

// ========================================
// 12. HANDLE INCOMING MESSAGES
// ========================================

async function handleMessage(msg) {
  try {
    if (!msg || !msg.message || msg.key?.fromMe) {
      return;
    }

    const jid = msg.key?.remoteJid || "";

    if (!jid) return;

    if (jid === "status@broadcast") return;

    if (jid.endsWith("@g.us")) return;

    if (jid.endsWith("@broadcast")) return;

    const phone = normalizePhone(jid);

    if (!phone) return;

    const messageId = msg.key?.id;

    if (rememberMessage(messageId)) {
      console.log("Ergaa irra deddeebi'ame dhiifame.");
      return;
    }

    const text = extractMessageText(msg.message);

    if (!text) {
      console.log("Ergaa barruu hin qabne irraa dhufe:", jid);
      return;
    }

    const pushName = msg.pushName || "";

    console.log("ERGAAN HAARAA:", {
      from: jid,
      text: text.slice(0, 100)
    });

    await saveUser(phone, pushName);

    const normalized = text
      .toLowerCase()
      .trim()
      .replace(/\s+/g, " ");

    // ====================================
    // GREETING AND MENU
    // ====================================

    if (
      [
        "menu",
        "start",
        "hi",
        "hello",
        "salaam",
        "assalaamu alaykum",
        "assalamu alaikum",
        "as salaamu alaykum",
        "akkam",
        "akkam jirtu",
        "akkam jirta"
      ].includes(normalized)
    ) {
      await sendText(jid, menu());
      return;
    }

    // ====================================
    // ISLAMIC LESSONS
    // ====================================

    if (lessons[text.trim()]) {
      await sendText(jid, lessons[text.trim()]);
      return;
    }

    // ====================================
    // TEACHER INSTRUCTIONS
    // ====================================

    if (normalized === "7") {
      await sendText(
        jid,
        `👨‍🏫 *QAJEELFAMA BARSIISAA*

Barsiisaan qormaata karaa API uumuun ni danda'a.

Endpoint:

POST /api/exams

Headers:

x-admin-code: KOOODA_ICCITII

Body JSON keessatti:

- title
- subject
- teacher_phone
- questions

galchuu qaba.

Gaaffiin tokkoon tokkoon isaa:
- question
- options 4
- answer (A, B, C ykn D)

qabaachuu qaba.

Qormaata erga uume booda koodii qormaataa argata.

Barattoonni WhatsApp irratti:

5 KOOODA_QORMAATA

erga jedhuun qormaata fudhachuu danda'u.`
      );

      return;
    }

    // ====================================
    // TAKE EXAM MENU
    // ====================================

    if (normalized === "5") {
      await sendText(
        jid,
        `📝 *QORMAATA FUDHADHU*

Koodii qormaataa barsiisaa irraa argadhu.

Achiin booda akkana ergi:

5 HB123ABC

HB123ABC bakka koodii qormaataa keetiin jijjiiri.`
      );

      return;
    }

    // ====================================
    // REQUEST EXAM
    // ====================================

    const examMatch = text.match(
      /^5\s+([A-Za-z0-9_-]+)$/i
    );

    if (examMatch) {
      const code = examMatch[1].toUpperCase();

      const exam = await getExam(code);

      if (!exam) {
        await sendText(
          jid,
          "❌ Koodiin qormaataa hin argamne. Maaloo koodii sirrii ta'e mirkaneessi."
        );

        return;
      }

      const questions = exam.questions;

      if (
        !Array.isArray(questions) ||
        questions.length === 0
      ) {
        await sendText(
          jid,
          "❌ Qormaata kana keessatti gaaffiin hin jiru."
        );

        return;
      }

      let output = `📝 *${exam.title}*\n\n`;

      output += `Mata-duree: ${exam.subject}\n`;
      output += `Koodii: ${exam.code}\n`;
      output += `Gaaffilee: ${questions.length}\n\n`;

      questions.forEach((q, index) => {
        output += `${index + 1}. ${q.question}\n`;

        (q.options || []).forEach((option, i) => {
          output += `${String.fromCharCode(65 + i)}. ${option}\n`;
        });

        output += "\n";
      });

      output += "Deebii kee akkana ergi:\n";
      output += `${exam.code} A,B,C,A\n\n`;
      output += "Deebiiwwan gaaffilee hunda sirriitti galchi.";

      await sendText(jid, output);
      return;
    }

    // ====================================
    // SUBMIT EXAM ANSWERS
    // ====================================

    const answerMatch = text.match(
      /^([A-Za-z0-9_-]+)\s+([A-Da-d](?:\s*[, ]\s*[A-Da-d])*)$/
    );

    if (answerMatch) {
      const code = answerMatch[1].toUpperCase();

      const answers = answerMatch[2]
        .split(/[, ]+/)
        .filter(Boolean)
        .map((answer) => answer.toUpperCase());

      const exam = await getExam(code);

      if (!exam) {
        await sendText(
          jid,
          "❌ Koodiin qormaataa hin argamne."
        );

        return;
      }

      const questions = exam.questions;

      if (
        !Array.isArray(questions) ||
        questions.length === 0
      ) {
        await sendText(
          jid,
          "❌ Qormaata kana keessatti gaaffiin hin jiru."
        );

        return;
      }

      if (answers.length !== questions.length) {
        await sendText(
          jid,
          `❌ Gaaffilee ${questions.length} jiru.

Ati deebii ${answers.length} qofa ergite.

Maaloo deebii gaaffilee hunda ergi.

Fakkeenya:
${code} A,B,C,D`
        );

        return;
      }

      let score = 0;
      const details = [];

      questions.forEach((q, index) => {
        const given = answers[index];

        const correct = String(q.answer || "")
          .toUpperCase();

        const isCorrect = given === correct;

        if (isCorrect) {
          score++;
        }

        details.push({
          question: q.question,
          answer: given,
          correct,
          isCorrect
        });
      });

      const total = questions.length;

      await pool.query(
        `
        INSERT INTO bot_results (
          exam_code,
          student_phone,
          student_name,
          score,
          total,
          answers
        )
        VALUES($1, $2, $3, $4, $5, $6)

        ON CONFLICT(exam_code, student_phone)
        DO UPDATE SET
          student_name = EXCLUDED.student_name,
          score = EXCLUDED.score,
          total = EXCLUDED.total,
          answers = EXCLUDED.answers,
          created_at = NOW()
        `,
        [
          code,
          phone,
          pushName,
          score,
          total,
          JSON.stringify(details)
        ]
      );

      const percentage = Math.round(
        (score / total) * 100
      );

      let resultMessage = `🎓 *BU'AA QORMAATA KEE*\n\n`;

      resultMessage += `Qormaata: ${exam.title}\n`;
      resultMessage += `Maqaa: ${pushName || "Barataa"}\n`;
      resultMessage += `Qabxii: ${score}/${total}\n`;
      resultMessage += `Dhibbeentaa: ${percentage}%\n\n`;

      resultMessage += "📋 *DEEBIIWWAN KEE*\n\n";

      details.forEach((detail, index) => {
        resultMessage += `${index + 1}. `;

        resultMessage += detail.isCorrect
          ? "✅ Sirrii\n"
          : "❌ Dogoggora\n";
      });

      resultMessage += "\nJabaadhu! Barnoota kee itti fufi.\n\n";
      resultMessage += "Qabxiiwwan kee ilaaluuf 6 ergi.";

      await sendText(jid, resultMessage);
      return;
    }

    // ====================================
    // STUDENT RESULTS
    // ====================================

    if (normalized === "6") {
      const result = await pool.query(
        `
        SELECT
          exam_code,
          student_name,
          score,
          total,
          created_at
        FROM bot_results
        WHERE student_phone = $1
        ORDER BY created_at DESC
        LIMIT 10
        `,
        [phone]
      );

      if (result.rows.length === 0) {
        await sendText(
          jid,
          "📊 Qabxiin hin argamne. Dura qormaata fudhadhu."
        );

        return;
      }

      let output = "📊 *QABXII KEE*\n\n";

      result.rows.forEach((r, index) => {
        const percentage =
          r.total > 0
            ? Math.round((r.score / r.total) * 100)
            : 0;

        output += `${index + 1}. ${r.exam_code}\n`;
        output += `Qabxii: ${r.score}/${r.total}\n`;
        output += `Dhibbeentaa: ${percentage}%\n`;
        output +=
          `Guyyaa: ${new Date(r.created_at).toLocaleDateString("en-GB")}\n\n`;
      });

      await sendText(jid, output);
      return;
    }

    // ====================================
    // DEFAULT RESPONSE
    // ====================================

    await sendText(
      jid,
      `Ergaa kee sirriitti hin hubanne.

${menu()}

Gaaffii barnootaa kee guutuu barreessuu dandeessa.`
    );

  } catch (error) {
    console.error(
      "MESSAGE ERROR:",
      error.stack || error
    );

    const jid = msg?.key?.remoteJid;

    if (jid && connected) {
      await sendText(
        jid,
        "Rakkoon uumameera. Mee yeroo muraasa booda irra deebi'i."
      );
    }
  }
}

// ========================================
// 13. WHATSAPP RECONNECT
// ========================================

function scheduleReconnect(delay = 5000) {
  if (shuttingDown || loggedOut) return;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;

    startWhatsApp().catch((error) => {
      console.error(
        "RECONNECT ERROR:",
        error.stack || error
      );
    });
  }, delay);
}

// ========================================
// 14. START WHATSAPP
// ========================================

async function startWhatsApp() {
  if (starting || shuttingDown || loggedOut) {
    return;
  }

  starting = true;

  try {
    fs.mkdirSync(AUTH_DIR, {
      recursive: true
    });

    console.log("WhatsApp auth directory:", AUTH_DIR);

    const {
      state,
      saveCreds
    } = await useMultiFileAuthState(AUTH_DIR);

    let version;

    try {
      const latest = await fetchLatestBaileysVersion();

      version = latest.version;

      console.log(
        "WhatsApp version:",
        version.join(".")
      );

    } catch (error) {
      console.log(
        "WhatsApp version haaraa argachuu hin dandeenye."
      );
    }

    const newSock = makeWASocket({
      auth: state,

      ...(version ? { version } : {}),

      logger: P({
        level: "silent"
      }),

      printQRInTerminal: false,

      browser: [
        "Hidaayatul-Bayaan",
        "Chrome",
        "1.0.0"
      ],

      syncFullHistory: false,

      markOnlineOnConnect: false
    });

    sock = newSock;

    newSock.ev.on("creds.update", saveCreds);

    // ==================================
    // CONNECTION EVENTS
    // ==================================

    newSock.ev.on(
      "connection.update",
      async (update) => {
        // Socket durii irraa event yoo dhufe
        // socket haaraa irratti hin hojjennu.
        if (sock !== newSock) return;

        const {
          connection,
          lastDisconnect,
          qr
        } = update;

        console.log(
          "WHATSAPP CONNECTION:",
          connection || "update"
        );

        // QR CODE

        if (qr) {
          try {
            latestQR = await QRCode.toDataURL(qr);

            connected = false;

            console.log(
              "QR Code qophaa'e. Fuula appii irratti bani."
            );

          } catch (error) {
            console.error(
              "QR ERROR:",
              error.message
            );
          }
        }

        // CONNECTED

        if (connection === "open") {
          connected = true;
          latestQR = null;
          starting = false;
          loggedOut = false;

          console.log(
            "WhatsApp wal qabateera!"
          );
        }

        // DISCONNECTED

        if (connection === "close") {
          connected = false;
          latestQR = null;
          starting = false;

          const status =
            lastDisconnect?.error?.output?.statusCode;

          console.error(
            "WhatsApp irraa citeera. Status:",
            status || "hin beekamne"
          );

          if (status === DisconnectReason.loggedOut) {
            loggedOut = true;

            console.error(
              "WhatsApp logout ta'e. QR haaraa scan gochuun barbaachisaa ta'uu danda'a."
            );

            return;
          }

          scheduleReconnect(5000);
        }
      }
    );

    // ==================================
    // INCOMING MESSAGES
    // ==================================

    newSock.ev.on(
      "messages.upsert",
      async ({ messages, type }) => {
        if (sock !== newSock) return;

        console.log(
          "MESSAGE EVENT:",
          type,
          "Count:",
          messages?.length || 0
        );

        // notify fi append irraa ergaa fudhanna.
        // seenMessages ergaa irra deddeebi'ame ittisa.
        if (!["notify", "append"].includes(type)) {
          return;
        }

        for (const msg of messages || []) {
          try {
            await handleMessage(msg);
          } catch (error) {
            console.error(
              "MESSAGE HANDLER ERROR:",
              error.stack || error
            );
          }
        }
      }
    );

    console.log(
      "WhatsApp connection jalqabsiifame."
    );

  } catch (error) {
    console.error(
      "WHATSAPP START ERROR:",
      error.stack || error
    );

    connected = false;
    latestQR = null;
    starting = false;

    scheduleReconnect(10000);
  }
}

// ========================================
// 15. HOME PAGE
// ========================================

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="om">
<head>
  <meta charset="UTF-8">

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  >

  <meta
    name="theme-color"
    content="#087443"
  >

  <title>Hidaayatul-Bayaan</title>

  <style>
    * {
      box-sizing: border-box;
    }

    body {
      font-family: Arial, sans-serif;
      background: #f0f7f2;
      color: #173c29;
      text-align: center;
      padding: 20px;
      margin: 0;
    }

    .card {
      max-width: 480px;
      margin: 25px auto;
      background: white;
      border-radius: 16px;
      padding: 24px;
      box-shadow: 0 3px 15px #0001;
    }

    h1 {
      color: #087443;
    }

    button {
      border: 0;
      border-radius: 8px;
      padding: 12px 18px;
      background: #087443;
      color: white;
      font-size: 16px;
      cursor: pointer;
    }

    img {
      width: 100%;
      max-width: 320px;
      margin-top: 15px;
    }

    .status {
      padding: 12px;
      border-radius: 8px;
      background: #eef8f0;
      margin: 15px 0;
    }

    .small {
      font-size: 13px;
      color: #555;
      line-height: 1.6;
    }
  </style>
</head>

<body>
  <div class="card">
    <h1>📚 Hidaayatul-Bayaan</h1>

    <p>Barnoota Islaamaa fi Qormaata</p>

    <div class="status">
      <p id="status">Haala WhatsApp ilaalaa...</p>
    </div>

    <img
      id="qr"
      style="display:none"
      alt="WhatsApp QR Code"
    >

    <p id="message"></p>

    <button onclick="loadStatus()">
      Haaromsi
    </button>

    <p class="small">
      QR code yoo mul'ate, WhatsApp bilbila kee bani.
      Linked devices → Link a device filadhu.
      Achiin QR code kana scan godhi.
    </p>

    <p class="small">
      QR code kee nama biraatti hin qoodin.
    </p>
  </div>

  <script>
    async function loadStatus() {
      try {
        const response = await fetch("/api/status");
        const data = await response.json();

        const status = document.getElementById("status");
        const qr = document.getElementById("qr");
        const message = document.getElementById("message");

        if (data.connected) {
          status.textContent = "✅ WhatsApp wal qabateera";
          qr.style.display = "none";

          message.textContent =
            "Botichi hojii irra jira.";

        } else {
          status.textContent =
            "⏳ WhatsApp wal qunnamsiisaa jira";

          if (data.qr) {
            qr.src = data.qr;
            qr.style.display = "block";

            message.textContent =
              "WhatsApp bilbila kee irratti bani; Linked devices > Link a device filadhu; QR kana scan godhi.";

          } else {
            qr.style.display = "none";

            message.textContent =
              "QR code qophaa'aa jira. Daqiiqaa muraasa eegii haaromsi.";
          }
        }

      } catch (error) {
        document.getElementById("status").textContent =
          "Rakkoo walqunnamtii. Irra deebi'ii yaali.";
      }
    }

    loadStatus();
    setInterval(loadStatus, 5000);
  </script>
</body>
</html>
  `);
});

// ========================================
// 16. HEALTH CHECK
// ========================================

app.get("/health", async (req, res) => {
  let database = "connected";

  try {
    await pool.query("SELECT 1");
  } catch (error) {
    database = "disconnected";
  }

  res.status(database === "connected" ? 200 : 503).json({
    ok: database === "connected",
    app: "Hidaayatul-Bayaan",
    database,
    whatsapp: connected ? "connected" : "disconnected"
  });
});

// ========================================
// 17. WHATSAPP STATUS
// ========================================

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    connected,
    qr: connected ? null : latestQR
  });
});

// ========================================
// 18. CREATE EXAM
// ========================================

app.post("/api/exams", async (req, res) => {
  const adminCode = req.headers["x-admin-code"];

  if (!ADMIN_CODE || adminCode !== ADMIN_CODE) {
    return res.status(401).json({
      ok: false,
      error:
        "Koodii barsiisaa sirrii hin taane. ADMIN_CODE qopheessi."
    });
  }

  const {
    title,
    subject,
    teacher_phone,
    questions
  } = req.body || {};

  if (
    typeof title !== "string" ||
    !title.trim() ||
    typeof teacher_phone !== "string" ||
    !teacher_phone.trim() ||
    !Array.isArray(questions) ||
    questions.length === 0
  ) {
    return res.status(400).json({
      ok: false,
      error:
        "title, teacher_phone fi questions guutuu galchi."
    });
  }

  for (const q of questions) {
    if (
      !q ||
      typeof q.question !== "string" ||
      !q.question.trim() ||
      !Array.isArray(q.options) ||
      q.options.length !== 4 ||
      q.options.some(
        (option) =>
          typeof option !== "string" ||
          !option.trim()
      ) ||
      !["A", "B", "C", "D"].includes(
        String(q.answer || "").toUpperCase()
      )
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "Gaaffiin tokkoon tokkoon isaa gaaffii, filannoowwan 4 fi deebii A/B/C/D qabaachuu qaba."
      });
    }
  }

  try {
    let code;
    let exists;

    do {
      code = randomCode();

      exists = await pool.query(
        "SELECT 1 FROM bot_exams WHERE code = $1",
        [code]
      );

    } while (exists.rowCount > 0);

    const cleanQuestions = questions.map((q) => ({
      question: q.question.trim(),

      options: q.options.map(
        (option) => option.trim()
      ),

      answer: String(q.answer).toUpperCase()
    }));

    await pool.query(
      `
      INSERT INTO bot_exams (
        code,
        title,
        subject,
        teacher_phone,
        questions
      )
      VALUES($1, $2, $3, $4, $5)
      `,
      [
        code,
        title.trim(),
        typeof subject === "string" && subject.trim()
          ? subject.trim()
          : "Islaamaa",
        normalizePhone(teacher_phone),
        JSON.stringify(cleanQuestions)
      ]
    );

    return res.status(201).json({
      ok: true,
      code,
      message: "Qormaanni uumameera.",
      student_instruction: `WhatsApp irratti 5 ${code} ergaa.`
    });

  } catch (error) {
    console.error(
      "CREATE EXAM ERROR:",
      error.stack || error
    );

    return res.status(500).json({
      ok: false,
      error: "Qormaata uumuu hin dandeenye."
    });
  }
});

// ========================================
// 19. GET EXAM WITHOUT ANSWERS
// ========================================

app.get("/api/exams/:code", async (req, res) => {
  try {
    const exam = await getExam(req.params.code);

    if (!exam) {
      return res.status(404).json({
        ok: false,
        error: "Qormaata hin arganne."
      });
    }

    const questions = Array.isArray(exam.questions)
      ? exam.questions
      : [];

    return res.json({
      ok: true,
      code: exam.code,
      title: exam.title,
      subject: exam.subject,

      questions: questions.map((q) => ({
        question: q.question,
        options: q.options
      }))
    });

  } catch (error) {
    console.error(
      "GET EXAM ERROR:",
      error.stack || error
    );

    return res.status(500).json({
      ok: false,
      error: "Server error."
    });
  }
});

// ========================================
// 20. GET EXAM RESULTS FOR TEACHER
// ========================================

app.get("/api/exams/:code/results", async (req, res) => {
  const adminCode = req.headers["x-admin-code"];

  if (!ADMIN_CODE || adminCode !== ADMIN_CODE) {
    return res.status(401).json({
      ok: false,
      error: "Koodii barsiisaa sirrii galchi."
    });
  }

  try {
    const result = await pool.query(
      `
      SELECT
        student_phone,
        student_name,
        score,
        total,
        created_at
      FROM bot_results
      WHERE exam_code = $1
      ORDER BY score DESC, created_at ASC
      `,
      [req.params.code.toUpperCase()]
    );

    return res.json({
      ok: true,
      results: result.rows
    });

  } catch (error) {
    console.error(
      "GET RESULTS ERROR:",
      error.stack || error
    );

    return res.status(500).json({
      ok: false,
      error: "Bu'aa argachuu hin dandeenye."
    });
  }
});

// ========================================
// 21. START SERVER AND DATABASE
// ========================================

const server = app.listen(PORT, "0.0.0.0", async () => {
  console.log(
    `Hidaayatul-Bayaan server port ${PORT} irratti jalqabe.`
  );

  try {
    await initDB();

    console.log("Database wal qabateera.");

    startWhatsApp().catch((error) => {
      console.error(
        "WHATSAPP INITIAL START ERROR:",
        error.stack || error
      );
    });

  } catch (error) {
    console.error(
      "DATABASE INITIALIZATION ERROR:",
      error.stack || error
    );
  }
});

// ========================================
// 22. GRACEFUL SHUTDOWN
// ========================================

async function shutdown() {
  if (shuttingDown) return;

  shuttingDown = true;

  console.log("Server cufamaa jira...");

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    connected = false;

    if (sock) {
      try {
        sock.end(undefined);
      } catch (error) {
        console.error(
          "WHATSAPP CLOSE ERROR:",
          error.message
        );
      }
    }

    await pool.end();

    server.close(() => {
      process.exit(0);
    });

    setTimeout(() => {
      process.exit(0);
    }, 5000).unref();

  } catch (error) {
    console.error(
      "SHUTDOWN ERROR:",
      error.stack || error
    );

    process.exit(1);
  }
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
