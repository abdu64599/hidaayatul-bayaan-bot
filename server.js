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
// CONFIGURATION
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
// DATABASE CONNECTION
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
// WHATSAPP VARIABLES
// ========================================

let sock = null;
let latestQR = null;
let connected = false;
let starting = false;

let reconnectTimer = null;

const seenMessages = new Set();

// ========================================
// DATABASE INITIALIZATION
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
// HELPER FUNCTIONS
// ========================================

function normalizePhone(jid) {
  if (!jid) return "";

  return jid
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
// ISLAMIC LESSONS
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

Deebiin ani kennu odeeffannoo waliigalaa barnoota Islaamaa irratti hundaa'a.

Dhimma fatwaa murteessaa irratti hayyuu amanamaa gaafadhu.`
};

// ========================================
// SAVE USER
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
// SEND WHATSAPP MESSAGE
// ========================================

async function sendText(jid, text) {
  if (!sock || !connected) {
    console.log("WhatsApp hin wal qabanne.");
    return;
  }

  try {
    await sock.sendMessage(jid, {
      text
    });
  } catch (error) {
    console.error("SEND MESSAGE ERROR:", error.message);
  }
}

// ========================================
// GET EXAM
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
// HANDLE INCOMING MESSAGES
// ========================================

async function handleMessage(msg) {
  if (!msg || !msg.message || msg.key.fromMe) {
    return;
  }

  const jid = msg.key.remoteJid || "";

  if (!jid) return;

  if (jid === "status@broadcast") return;

  if (jid.endsWith("@g.us")) return;

  if (jid.endsWith("@broadcast")) return;

  const phone = normalizePhone(jid);

  if (!phone) return;

  const messageId = msg.key.id;

  if (messageId && seenMessages.has(messageId)) {
    return;
  }

  if (messageId) {
    seenMessages.add(messageId);

    if (seenMessages.size > 2000) {
      const firstItems = Array.from(seenMessages).slice(0, 1000);

      for (const item of firstItems) {
        seenMessages.delete(item);
      }
    }
  }

  const content =
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    msg.message.imageMessage?.caption ||
    msg.message.videoMessage?.caption ||
    "";

  const text = content.trim();

  if (!text) return;

  const pushName = msg.pushName || "";

  try {
    await saveUser(phone, pushName);

    const normalized = text.toLowerCase();

    // MENU

    if (
      [
        "menu",
        "start",
        "hi",
        "hello",
        "salaam",
        "assalaamu alaykum"
      ].includes(normalized)
    ) {
      return sendText(jid, menu());
    }

    // LESSONS

    if (lessons[text]) {
      return sendText(jid, lessons[text]);
    }

    // TEACHER INSTRUCTIONS

    if (normalized === "7") {
      return sendText(
        jid,
        `👨‍🏫 *QAJEELFAMA BARSIISAA*

Barsiisaan qormaata karaa API uumuun ni danda'a.

Endpoint:

POST /api/exams

Headers:

x-admin-code: KOOODA_ICCITII

Qormaata keessatti:

- Maqaa qormaataa
- Mata-duree
- Lakkoofsa bilbilaa barsiisaa
- Gaaffilee
- Filannoowwan A, B, C, D
- Deebii sirrii

galchuu qaba.

Qormaata erga uume booda koodii qormaataa argata.

Barattoonni WhatsApp irratti:

5 KOOODA_QORMAATA

erga jedhuun qormaata fudhachuu danda'u.`
      );
    }

    // TAKE EXAM MENU

    if (normalized === "5") {
      return sendText(
        jid,
        `📝 *QORMAATA FUDHADHU*

Koodii qormaataa qabaadhu.

Achiin booda akkana ergi:

5 HB123ABC

HB123ABC bakka koodii qormaataa keetiin jijjiiri.`
      );
    }

    // REQUEST EXAM

    const examMatch = text.match(
      /^5\s+([A-Za-z0-9_-]+)$/
    );

    if (examMatch) {
      const code = examMatch[1].toUpperCase();

      const exam = await getExam(code);

      if (!exam) {
        return sendText(
          jid,
          "❌ Koodiin qormaataa hin argamne. Maaloo koodii sirrii ta'e mirkaneessi."
        );
      }

      const questions = exam.questions;

      if (
        !Array.isArray(questions) ||
        questions.length === 0
      ) {
        return sendText(
          jid,
          "❌ Qormaata kana keessatti gaaffiin hin jiru."
        );
      }

      let output = `📝 *${exam.title}*\n`;

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

      output += `Deebii kee akkana ergi:\n`;
      output += `${exam.code} A,B,C,A\n\n`;
      output += "Deebiiwwan kee hundaa sirriitti galchi.";

      return sendText(jid, output);
    }

    // SUBMIT EXAM ANSWERS

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
        return sendText(
          jid,
          "❌ Koodiin qormaataa hin argamne."
        );
      }

      const questions = exam.questions;

      if (
        !Array.isArray(questions) ||
        questions.length === 0
      ) {
        return sendText(
          jid,
          "❌ Qormaata kana keessatti gaaffiin hin jiru."
        );
      }

      if (answers.length !== questions.length) {
        return sendText(
          jid,
          `❌ Gaaffilee ${questions.length} jiru.

Ati deebii ${answers.length} qofa ergite.

Maaloo deebii gaaffilee hunda ergi.

Fakkeenya:
${code} A,B,C,D`
        );
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

      return sendText(jid, resultMessage);
    }

    // STUDENT RESULTS

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
        return sendText(
          jid,
          "📊 Qabxiin hin argamne. Dura qormaata fudhadhu."
        );
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

      return sendText(jid, output);
    }

    // DEFAULT RESPONSE

    return sendText(
      jid,
      `Ergaa kee sirriitti hin hubanne.

${menu()}

Gaaffii barnootaa kee guutuu barreessuu dandeessa.`
    );

  } catch (error) {
    console.error("MESSAGE ERROR:", error);

    await sendText(
      jid,
      "Rakkoon uumameera. Mee yeroo muraasa booda irra deebi'i."
    );
  }
}

// ========================================
// START WHATSAPP
// ========================================

async function startWhatsApp() {
  if (starting) {
    console.log("WhatsApp duraan jalqabsiifamaa jira.");
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
        "WhatsApp version argachuu hin dandeenye; version duraanii fayyadama."
      );
    }

    sock = makeWASocket({
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

    sock.ev.on("creds.update", saveCreds);

    // CONNECTION EVENTS

    sock.ev.on(
      "connection.update",
      async (update) => {
        const {
          connection,
          lastDisconnect,
          qr
        } = update;

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

          if (
            status === DisconnectReason.loggedOut
          ) {
            console.log(
              "WhatsApp logout ta'e."
            );

            console.log(
              "Session haaraa uumuuf WhatsApp irra deebi'ii link godhi."
            );

            return;
          }

          console.log(
            "WhatsApp irraa citeera."
          );

          console.log(
            "Sekondii 5 booda irra deebi'ee yaala."
          );

          if (reconnectTimer) {
            clearTimeout(reconnectTimer);
          }

          reconnectTimer = setTimeout(() => {
            startWhatsApp().catch((error) => {
              console.error(
                "RECONNECT ERROR:",
                error
              );
            });
          }, 5000);
        }
      }
    );

    // INCOMING MESSAGES

    sock.ev.on(
      "messages.upsert",
      async ({ messages, type }) => {
        if (type !== "notify") {
          return;
        }

        for (const msg of messages) {
          try {
            await handleMessage(msg);

          } catch (error) {
            console.error(
              "MESSAGE HANDLER ERROR:",
              error
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
      error
    );

    connected = false;

    latestQR = null;

    starting = false;

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }

    reconnectTimer = setTimeout(() => {
      startWhatsApp().catch((err) => {
        console.error(
          "WHATSAPP RETRY ERROR:",
          err
        );
      });
    }, 10000);
  }
}

// ========================================
// HOME PAGE
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
      <p id="status">
        Haala WhatsApp ilaalaa...
      </p>
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

        const status =
          document.getElementById("status");

        const qr =
          document.getElementById("qr");

        const message =
          document.getElementById("message");

        if (data.connected) {
          status.textContent =
            "✅ WhatsApp wal qabateera";

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
        document.getElementById("status")
          .textContent =
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
// HEALTH CHECK
// ========================================

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    app: "Hidaayatul-Bayaan",
    whatsapp: connected
      ? "connected"
      : "disconnected"
  });
});

// ========================================
// WHATSAPP STATUS
// ========================================

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    connected,
    qr: latestQR
  });
});

// ========================================
// CREATE EXAM
// ========================================

app.post("/api/exams", async (req, res) => {
  const adminCode = req.headers["x-admin-code"];

  if (
    !ADMIN_CODE ||
    adminCode !== ADMIN_CODE
  ) {
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
  } = req.body;

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
        `
        SELECT 1
        FROM bot_exams
        WHERE code = $1
        `,
        [code]
      );

    } while (exists.rowCount > 0);

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
        subject || "Islaamaa",
        normalizePhone(teacher_phone),
        JSON.stringify(
          questions.map((q) => ({
            question: q.question.trim(),

            options: q.options.map(
              (option) => option.trim()
            ),

            answer: String(q.answer).toUpperCase()
          }))
        )
      ]
    );

    return res.status(201).json({
      ok: true,
      code,
      message: "Qormaanni uumameera.",
      student_instruction:
        `WhatsApp irratti 5 ${code} ergaa.`
    });

  } catch (error) {
    console.error(
      "CREATE EXAM ERROR:",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        "Qormaata uumuu hin dandeenye."
    });
  }
});

// ========================================
// GET EXAM WITHOUT ANSWERS
// ========================================

app.get("/api/exams/:code", async (req, res) => {
  try {
    const exam = await getExam(
      req.params.code
    );

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
      error
    );

    return res.status(500).json({
      ok: false,
      error: "Server error."
    });
  }
});

// ========================================
// GET EXAM RESULTS FOR TEACHER
// ========================================

app.get(
  "/api/exams/:code/results",
  async (req, res) => {
    const adminCode =
      req.headers["x-admin-code"];

    if (
      !ADMIN_CODE ||
      adminCode !== ADMIN_CODE
    ) {
      return res.status(401).json({
        ok: false,
        error:
          "Koodii barsiisaa sirrii galchi."
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
        [
          req.params.code.toUpperCase()
        ]
      );

      return res.json({
        ok: true,
        results: result.rows
      });

    } catch (error) {
      console.error(
        "GET RESULTS ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "Bu'aa argachuu hin dandeenye."
      });
    }
  }
);

// ========================================
// START SERVER AND DATABASE
// ========================================

const server = app.listen(
  PORT,
  "0.0.0.0",
  async () => {
    console.log(
      `Hidaayatul-Bayaan server port ${PORT} irratti jalqabe.`
    );

    try {
      await initDB();

      console.log(
        "Database wal qabateera."
      );

      startWhatsApp().catch((error) => {
        console.error(
          "WHATSAPP INITIAL START ERROR:",
          error
        );
      });

    } catch (error) {
      console.error(
        "DATABASE INITIALIZATION ERROR:",
        error
      );
    }
  }
);

// ========================================
// GRACEFUL SHUTDOWN
// ========================================

async function shutdown() {
  console.log(
    "Server cufamaa jira..."
  );

  try {
    if (sock) {
      sock.end(undefined);
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
      error
    );

    process.exit(1);
  }
}

process.on("SIGTERM", shutdown);

process.on("SIGINT", shutdown);
