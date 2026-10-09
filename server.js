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
app.use(express.json());

const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_CODE = process.env.ADMIN_CODE || "CHANGE_THIS_ADMIN_CODE";
const AUTH_DIR = process.env.AUTH_DIR || "/var/data/whatsapp-auth";

if (!DATABASE_URL) {
  console.error("DATABASE_URL hin argamne!");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false"
    ? false
    : { rejectUnauthorized: false },
  family: 4
});

let sock = null;
let latestQR = null;
let connected = false;
let starting = false;

const seenMessages = new Set();

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

function normalizePhone(jid) {
  if (!jid) return "";
  return jid.split("@")[0].split(":")[0].replace(/\D/g, "");
}

function randomCode() {
  return "HB" + Math.random().toString(36).slice(2, 8).toUpperCase();
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
5 HB123ABC`;
}

const lessons = {
  "1": `📚 *BARNOOTA ISLAAMAA*

Islaamni amantii Rabbiin Muhammad ﷺ irratti buusee dha.

Utubaaleen Islaamaa shan:
1. Shahadaa
2. Salaata
3. Zakaa
4. Sawmii Ramadaanaa
5. Hajjii, nama danda'uuf.

Utubaalee Iimaanaa jahan:
1. Rabbiitti amanuu
2. Malaayikootaatti amanuu
3. Kitaabota Rabbiitti amanuu
4. Ergamaa Rabbiitti amanuu
5. Guyyaa Qiyaamaatti amanuu
6. Qadaraatti amanuu.

Barnoota dabalataaf jecha *MENU* ergi.`,

  "2": `🌙 *SEENAA NABII MUHAMMAD ﷺ*

Nabiyyiin Muhammad ﷺ Makkah keessatti bara Filaa keessatti dhalatan. Abbaa isaanii Abdullah, haadha isaanii Aamina bint Wahb turan.

Abbaa isaanii osoo hin dhalatin dura du'an. Haati isaanii yeroo ijoollummaa isaanii duute. Jalqaba guddina isaanii keessatti akaakayyuun isaanii Abdul-Muxxalib, sana booda abbeeraan isaanii Abu Xaalib isaan kunuunsan.

Waggaa 40tti wahyiin jalqabe. Malaaykaan Jibriil عليه السلام Qur'aana irraa aayata jalqabaa Suuraa Al-Alaq isaanitti fide.

Islaamatti namoota waaman; Makkah keessatti rakkina hedduu obsan. Bara 622 Miilaaditti gara Madiinaa hijraa godhan.

Madiinaa keessatti hawaasa Islaamaa ijaaranii ummata barsiisan. Bara 632 Miilaaditti Madiinaa keessatti du'an ﷺ.

Seenaa dabalataaf *MENU* ergi.`,

  "3": `🕌 *SEENAA SAHABOOTAA*

Sahaboonni Nabiyyii Muhammad ﷺ arganii, isaanitti amananii, Islaama irratti du'aniidha.

1. Abu Bakr As-Siddiiq رضي الله عنه — Khaliifaa jalqabaa.
2. Umar ibn Al-Khaxxaab رضي الله عنه — Khaliifaa lammaffaa.
3. Uthmaan ibn Affaan رضي الله عنه — Khaliifaa sadaffaa.
4. Ali ibn Abi Xaalib رضي الله عنه — Khaliifaa afraffaa.
5. Bilaal ibn Rabaah رضي الله عنه — Mu'azzina beekamaa.
6. Khadiija bint Khuwaylid رضي الله عنها — Haadha warraa Nabiyyii ﷺ isa jalqabaa fi namoota jalqabaa amanan keessaa tokko.

Sahaboota biroo barachuuf *MENU* ergi.`,

  "4": `❓ *GAAFFII FI DEEBII*

Gaaffii kee ergaa itti aanutti barreessi.

Fakkeenya:
- Utubaaleen Islaamaa meeqa?
- Nabiyyiin Muhammad ﷺ eessatti dhalatan?
- Malaaykaan wahyii fidu eenyu?

Deebiin ani kennu odeeffannoo waliigalaa barnoota Islaamaa irratti hundaa'a. Dhimma fatwaa murteessaa irratti hayyuu amanamaa gaafadhu.`
};

async function saveUser(phone, name) {
  if (!phone) return;

  await pool.query(`
    INSERT INTO bot_users(phone, name)
    VALUES($1, $2)
    ON CONFLICT(phone)
    DO UPDATE SET name = CASE
      WHEN EXCLUDED.name <> '' THEN EXCLUDED.name
      ELSE bot_users.name
    END
  `, [phone, name || ""]);
}

async function sendText(jid, text) {
  if (!sock || !connected) return;
  await sock.sendMessage(jid, { text });
}

async function getExam(code) {
  const result = await pool.query(
    "SELECT * FROM bot_exams WHERE code = $1",
    [code.toUpperCase()]
  );
  return result.rows[0];
}

async function handleMessage(msg) {
  if (!msg.message || msg.key.fromMe) return;
  if (msg.key.remoteJid === "status@broadcast") return;
  if (msg.key.remoteJid.endsWith("@g.us")) return;

  const jid = msg.key.remoteJid;
  const phone = normalizePhone(jid);

  if (!phone) return;

  const messageId = msg.key.id;
  if (messageId && seenMessages.has(messageId)) return;

  if (messageId) {
    seenMessages.add(messageId);
    if (seenMessages.size > 2000) {
      seenMessages.clear();
    }
  }

  const content = msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    msg.message.imageMessage?.caption ||
    "";

  const text = content.trim();
  if (!text) return;

  const pushName = msg.pushName || "";

  try {
    await saveUser(phone, pushName);

    const normalized = text.toLowerCase();

    if (
      normalized === "menu" ||
      normalized === "start" ||
      normalized === "hi" ||
      normalized === "hello" ||
      normalized === "salaam" ||
      normalized === "assalaamu alaykum"
    ) {
      return sendText(jid, menu());
    }

    if (lessons[text]) {
      return sendText(jid, lessons[text]);
    }

    if (normalized === "7") {
      return sendText(jid, `👨‍🏫 *Qajeelfama Barsiisaa*

Qormaata uumuuf:
1. Barsiisaan lakkoofsa bilbilaa isaa mirkaneessa.
2. Koodii bulchiinsaa ADMIN_CODE fayyadamuun API irratti galmaa'a.
3. Qormaata karaa API uumuu danda'a.

Endpoint qormaata uumu:
POST /api/exams

Barsiisaan qormaata uuma; barataan qormaata fudhata.`);
    }

    const examMatch = text.match(/^5\s+([A-Za-z0-9_-]+)$/);

    if (normalized === "5") {
      return sendText(
        jid,
        "📝 Qormaata fudhachuuf:\n\n5 KOOODA_QORMAATA\n\nFakkeenya: 5 HB123ABC"
      );
    }

    if (examMatch) {
      const code = examMatch[1].toUpperCase();
      const exam = await getExam(code);

      if (!exam) {
        return sendText(jid, "❌ Koodiin qormaataa hin argamne. Koodii sirrii ta'e mirkaneessi.");
      }

      const questions = exam.questions;

      if (!Array.isArray(questions) || questions.length === 0) {
        return sendText(jid, "❌ Qormaata kana keessatti gaaffiin hin jiru.");
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

      output += `Deebii kee akkana ergi:\n${exam.code} A,B,C,A`;

      return sendText(jid, output);
    }

    const answerMatch = text.match(/^([A-Za-z0-9_-]+)\s+([A-Da-d](?:\s*[, ]\s*[A-Da-d])*)$/);

    if (answerMatch) {
      const code = answerMatch[1].toUpperCase();
      const answers = answerMatch[2]
        .split(/[, ]+/)
        .filter(Boolean)
        .map(a => a.toUpperCase());

      const exam = await getExam(code);

      if (!exam) {
        return sendText(jid, "❌ Koodiin qormaataa hin argamne.");
      }

      const questions = exam.questions;

      if (answers.length !== questions.length) {
        return sendText(
          jid,
          `❌ Gaaffilee ${questions.length} jiru; deebii ${answers.length} qofa ergite. Deebii hunda ergi.`
        );
      }

      let score = 0;
      const details = [];

      questions.forEach((q, i) => {
        const given = answers[i];
        const correct = String(q.answer || "").toUpperCase();

        const isCorrect = given === correct;
        if (isCorrect) score++;

        details.push({
          question: q.question,
          answer: given,
          correct,
          isCorrect
        });
      });

      const total = questions.length;

      await pool.query(`
        INSERT INTO bot_results
          (exam_code, student_phone, student_name, score, total, answers)
        VALUES($1, $2, $3, $4, $5, $6)
        ON CONFLICT(exam_code, student_phone)
        DO UPDATE SET
          student_name = EXCLUDED.student_name,
          score = EXCLUDED.score,
          total = EXCLUDED.total,
          answers = EXCLUDED.answers,
          created_at = NOW()
      `, [
        code,
        phone,
        pushName,
        score,
        total,
        JSON.stringify(details)
      ]);

      const percentage = Math.round((score / total) * 100);

      return sendText(
        jid,
        `🎓 *BU'AA QORMAATA KEE*

Qormaata: ${exam.title}
Maqaa: ${pushName || "Barataa"}
Qabxii: ${score}/${total}
Dhibbeentaa: ${percentage}%

Jabaadhu! Barnoota kee itti fufi.

Bu'aa biraa ilaaluuf 6 ergi.`
      );
    }

    if (normalized === "6") {
      const result = await pool.query(`
        SELECT exam_code, student_name, score, total, created_at
        FROM bot_results
        WHERE student_phone = $1
        ORDER BY created_at DESC
        LIMIT 10
      `, [phone]);

      if (result.rows.length === 0) {
        return sendText(jid, "Qabxiin hin argamne. Dura qormaata fudhadhu.");
      }

      let output = "📊 *QABXII KEE*\n\n";

      result.rows.forEach((r, i) => {
        output += `${i + 1}. ${r.exam_code}\n`;
        output += `Qabxii: ${r.score}/${r.total}\n`;
        output += `Guyyaa: ${new Date(r.created_at).toLocaleDateString("en-GB")}\n\n`;
      });

      return sendText(jid, output);
    }

    return sendText(
      jid,
      `Ergaa kee hin hubanne.\n\n${menu()}\n\nGaaffii barnootaa kee guutuu barreessuu dandeessa.`
    );
  } catch (error) {
    console.error("MESSAGE ERROR:", error);
    await sendText(jid, "Rakkoon uumameera. Mee yeroo muraasa booda irra deebi'i.");
  }
}
async function startWhatsApp() {
  if (starting) return;
  starting = true;

  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });

    const { state, saveCreds } =
      await useMultiFileAuthState(AUTH_DIR);

    let version;

    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
    } catch (error) {
      console.log("WhatsApp version argachuu hin dandeenye; version duraanii fayyadama.");
    }

    sock = makeWASocket({
      auth: state,
      ...(version ? { version } : {}),
      logger: P({ level: "silent" }),
      printQRInTerminal: false,
      browser: ["Hidaayatul-Bayaan", "Chrome", "1.0.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          latestQR = await QRCode.toDataURL(qr);
          connected = false;
          console.log("QR Code qophaa'e.");
        } catch (error) {
          console.error("QR ERROR:", error.message);
        }
      }

      if (connection === "open") {
        connected = true;
        latestQR = null;
        console.log("WhatsApp connected!");
      }

      if (connection === "close") {
        connected = false;
        latestQR = null;
        starting = false;

        const status =
          lastDisconnect?.error?.output?.statusCode;

        if (status === DisconnectReason.loggedOut) {
          console.log(
            "WhatsApp logout ta'e. Session haaraa scan gochuun barbaachisa."
          );
          return;
        }

        console.log(
          "WhatsApp irraa citeera; sekondii 5 booda irra deebi'ee yaala."
        );

        setTimeout(() => {
          startWhatsApp().catch((error) => {
            console.error("RECONNECT ERROR:", error);
          });
        }, 5000);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        try {
          await handleMessage(msg);
        } catch (error) {
          console.error("MESSAGE HANDLER ERROR:", error);
        }
      }
    });

  } catch (error) {
    console.error("WHATSAPP START ERROR:", error);
    connected = false;
    latestQR = null;
    starting = false;

    setTimeout(() => {
      startWhatsApp().catch((err) => {
        console.error("WHATSAPP RETRY ERROR:", err);
      });
    }, 10000);
  }
      }

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        await handleMessage(msg);
      }
    });
  } catch (error) {
    console.error("WHATSAPP START ERROR:", error);
    starting = false;
    setTimeout(startWhatsApp, 10000);
  }
}

app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="om">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Hidaayatul-Bayaan</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          background: #f0f7f2;
          color: #173c29;
          text-align: center;
          padding: 25px;
        }
        .card {
          max-width: 450px;
          margin: 25px auto;
          background: white;
          border-radius: 16px;
          padding: 24px;
          box-shadow: 0 3px 15px #0001;
        }
        h1 { color: #087443; }
        button {
          border: 0;
          border-radius: 8px;
          padding: 12px 18px;
          background: #087443;
          color: white;
          font-size: 16px;
        }
        img { width: 100%; max-width: 320px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>📚 Hidaayatul-Bayaan</h1>
        <p>Barnoota Islaamaa fi Qormaata</p>
        <p id="status">Haala WhatsApp ilaalaa...</p>
        <img id="qr" style="display:none" alt="WhatsApp QR Code">
        <p id="message"></p>
        <button onclick="loadStatus()">Haaromsi</button>
      </div>
      <script>
        async function loadStatus() {
          try {
            const r = await fetch('/api/status');
            const d = await r.json();
            document.getElementById('status').textContent =
              d.connected ? '✅ WhatsApp wal qabateera' : '⏳ WhatsApp wal qunnamsiisaa jira';

            const qr = document.getElementById('qr');
            if (d.qr) {
              qr.src = d.qr;
              qr.style.display = 'block';
              document.getElementById('message').textContent =
                'WhatsApp bilbila kee irratti bani, Linked devices > Link a device filadhu, QR kana scan godhi.';
            } else {
              qr.style.display = 'none';
              document.getElementById('message').textContent =
                d.connected ? 'Botichi qophaa’eera.' : 'QR Code yoo hin mul’anne daqiiqaa muraasa eegii haaromsi.';
            }
          } catch (e) {
            document.getElementById('status').textContent = 'Rakkoo walqunnamtii';
          }
        }
        loadStatus();
        setInterval(loadStatus, 5000);
      </script>
    </body>
    </html>
  `);
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    app: "Hidaayatul-Bayaan",
    whatsapp: connected ? "connected" : "disconnected"
  });
});

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    connected,
    qr: latestQR
  });
});

// Qormaata uumuuf endpoint barsiisaa.
// ADMIN_CODE keessatti koodii iccitii kee fayyadami.
app.post("/api/exams", async (req, res) => {
  const adminCode = req.headers["x-admin-code"];

  if (!ADMIN_CODE ||
      ADMIN_CODE === "CHANGE_THIS_ADMIN_CODE" ||
      adminCode !== ADMIN_CODE) {
    return res.status(401).json({
      ok: false,
      error: "Koodii barsiisaa sirrii hin taane. ADMIN_CODE qopheessi."
    });
  }

  const { title, subject, teacher_phone, questions } = req.body;

  if (!title || !teacher_phone || !Array.isArray(questions) ||
      questions.length === 0) {
    return res.status(400).json({
      ok: false,
      error: "title, teacher_phone fi questions guutuu galchi."
    });
  }

  for (const q of questions) {
    if (
      !q.question ||
      !Array.isArray(q.options) ||
      q.options.length !== 4 ||
      !["A", "B", "C", "D"].includes(String(q.answer || "").toUpperCase())
    ) {
      return res.status(400).json({
        ok: false,
        error: "Gaaffiin tokkoon tokkoon isaa question, options 4 fi answer A/B/C/D qabaachuu qaba."
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

    await pool.query(`
      INSERT INTO bot_exams
        (code, title, subject, teacher_phone, questions)
      VALUES($1, $2, $3, $4, $5)
    `, [
      code,
      title,
      subject || "Islaamaa",
      normalizePhone(teacher_phone),
      JSON.stringify(questions.map(q => ({
        question: q.question,
        options: q.options,
        answer: String(q.answer).toUpperCase()
      })))
    ]);

    res.status(201).json({
      ok: true,
      code,
      message: "Qormaanni uumameera.",
      student_instruction: `WhatsApp irratti 5 ${code} ergaa.`
    });
  } catch (error) {
    console.error("CREATE EXAM ERROR:", error);
    res.status(500).json({
      ok: false,
      error: "Qormaata uumuu hin dandeenye."
    });
  }
});

app.get("/api/exams/:code", async (req, res) => {
  try {
    const exam = await getExam(req.params.code);

    if (!exam) {
      return res.status(404).json({
        ok: false,
        error: "Qormaata hin arganne."
      });
    }

    res.json({
      ok: true,
      code: exam.code,
      title: exam.title,
      subject: exam.subject,
      questions: exam.questions.map(q => ({
        question: q.question,
        options: q.options
      }))
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: "Server error." });
  }
});

app.get("/api/exams/:code/results", async (req, res) => {
  const adminCode = req.headers["x-admin-code"];

  if (adminCode !== ADMIN_CODE ||
      ADMIN_CODE === "CHANGE_THIS_ADMIN_CODE") {
    return res.status(401).json({
      ok: false,
      error: "Koodii barsiisaa sirrii galchi."
    });
  }

  try {
    const result = await pool.query(`
      SELECT student_phone, student_name, score, total, created_at
      FROM bot_results
      WHERE exam_code = $1
      ORDER BY score DESC, created_at ASC
    `, [req.params.code.toUpperCase()]);

    res.json({ ok: true, results: result.rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: "Bu'aa argachuu hin dandeenye." });
  }
});

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`Hidaayatul-Bayaan server port ${PORT} irratti jalqabe.`);

  try {
    await initDB();
    startWhatsApp().catch(console.error);
  } catch (error) {
    console.error("DATABASE INITIALIZATION ERROR:", error);
  }
});
