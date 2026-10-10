const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const pino = require("pino");
const QRCode = require("qrcode");
const { Pool } = require("pg");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ===============================
// CONFIGURATION
// ===============================

const PORT = process.env.PORT || 10000;

const DATABASE_URL = process.env.DATABASE_URL;

const ADMIN_CODE = process.env.ADMIN_CODE || "123456";

const AUTH_DIR =
  process.env.AUTH_DIR || "/tmp/hidaayatul-bayaan-auth";

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
  family: 4
});

pool.on("error", (error) => {
  console.error("DATABASE POOL ERROR:", error.message);
});

// ===============================
// WHATSAPP STATE
// ===============================

let sock = null;
let connected = false;
let starting = false;
let qrImage = null;
let whatsappPhone = null;
let lastMessageAt = null;
let reconnectTimer = null;
let reconnectAttempts = 0;

const sessions = new Map();

const logger = pino({ level: "silent" });

// ===============================
// DATABASE
// ===============================

async function initializeDatabase() {
  console.log("DATABASE INITIALIZATION STARTED");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_users (
      id BIGSERIAL PRIMARY KEY,
      phone TEXT UNIQUE NOT NULL,
      name TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_exams (
      id BIGSERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      creator_phone TEXT NOT NULL,
      title TEXT NOT NULL,
      subject TEXT DEFAULT '',
      duration_minutes INTEGER DEFAULT 30,
      questions JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_results (
      id BIGSERIAL PRIMARY KEY,
      exam_code TEXT NOT NULL,
      student_phone TEXT NOT NULL,
      student_name TEXT DEFAULT '',
      score NUMERIC DEFAULT 0,
      total NUMERIC DEFAULT 0,
      percentage NUMERIC DEFAULT 0,
      answers JSONB DEFAULT '[]'::jsonb,
      submitted_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Existing tables keessatti column hin jirre dabaluu
  await pool.query(`
    ALTER TABLE bot_users
    ADD COLUMN IF NOT EXISTS name TEXT DEFAULT ''
  `);

  await pool.query(`
    ALTER TABLE bot_exams
    ADD COLUMN IF NOT EXISTS subject TEXT DEFAULT ''
  `);

  await pool.query(`
    ALTER TABLE bot_exams
    ADD COLUMN IF NOT EXISTS duration_minutes INTEGER DEFAULT 30
  `);

  await pool.query(`
    ALTER TABLE bot_exams
    ADD COLUMN IF NOT EXISTS questions JSONB DEFAULT '[]'::jsonb
  `);

  await pool.query(`
    ALTER TABLE bot_results
    ADD COLUMN IF NOT EXISTS student_name TEXT DEFAULT ''
  `);

  await pool.query(`
    ALTER TABLE bot_results
    ADD COLUMN IF NOT EXISTS score NUMERIC DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE bot_results
    ADD COLUMN IF NOT EXISTS total NUMERIC DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE bot_results
    ADD COLUMN IF NOT EXISTS percentage NUMERIC DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE bot_results
    ADD COLUMN IF NOT EXISTS answers JSONB DEFAULT '[]'::jsonb
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS bot_results_phone_idx
    ON bot_results(student_phone)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS bot_results_exam_idx
    ON bot_results(exam_code)
  `);

  console.log("DATABASE MIGRATIONS COMPLETED");
}

// ===============================
// BASIC HELPERS
// ===============================

function normalizePhone(jid) {
  if (!jid) return "";

  return jid
    .split("@")[0]
    .split(":")[0]
    .replace(/\D/g, "");
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function generateExamCode() {
  return crypto
    .randomBytes(4)
    .toString("hex")
    .toUpperCase();
}

function getMessageText(message) {
  if (!message) return "";

  if (message.conversation) {
    return message.conversation;
  }

  if (message.extendedTextMessage?.text) {
    return message.extendedTextMessage.text;
  }

  if (message.imageMessage?.caption) {
    return message.imageMessage.caption;
  }

  if (message.videoMessage?.caption) {
    return message.videoMessage.caption;
  }

  if (message.documentMessage?.caption) {
    return message.documentMessage.caption;
  }

  if (message.buttonsResponseMessage?.selectedButtonId) {
    return message.buttonsResponseMessage.selectedButtonId;
  }

  if (message.listResponseMessage?.singleSelectReply?.selectedRowId) {
    return message.listResponseMessage.singleSelectReply.selectedRowId;
  }

  if (message.templateButtonReplyMessage?.selectedId) {
    return message.templateButtonReplyMessage.selectedId;
  }

  if (message.ephemeralMessage?.message) {
    return getMessageText(message.ephemeralMessage.message);
  }

  if (message.viewOnceMessage?.message) {
    return getMessageText(message.viewOnceMessage.message);
  }

  if (message.viewOnceMessageV2?.message) {
    return getMessageText(message.viewOnceMessageV2.message);
  }

  if (message.documentWithCaptionMessage?.message) {
    return getMessageText(
      message.documentWithCaptionMessage.message
    );
  }

  return "";
}

async function sendText(jid, text) {
  if (!sock || !connected) {
    console.error("SEND FAILED: WhatsApp is not connected");
    return false;
  }

  try {
    await sock.sendMessage(jid, { text: String(text) });

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

async function saveUser(phone, name = "") {
  if (!phone) return;

  await pool.query(
    `
    INSERT INTO bot_users (phone, name)
    VALUES ($1, $2)
    ON CONFLICT (phone)
    DO UPDATE SET
      name = CASE
        WHEN EXCLUDED.name <> '' THEN EXCLUDED.name
        ELSE bot_users.name
      END
    `,
    [phone, name]
  );
}

function mainMenu(name = "") {
  return (
    `Assalaamu alaykum ${name}!\n\n` +
    `Baga gara Hidaayatul-Bayaan dhuftan.\n\n` +
    `1️⃣ Qormaata Uumi\n` +
    `2️⃣ Qormaata Fudhadhu\n` +
    `3️⃣ Qabxii Koo\n` +
    `4️⃣ Qormaata Koo\n` +
    `5️⃣ Barnoota\n` +
    `0️⃣ Menu kana irra deebi'i\n\n` +
    `Filannoo kee lakkoofsaan ergi.`
  );
}

// ===============================
// EXAM CREATION
// ===============================

async function beginExamCreation(jid) {
  sessions.set(jid, {
    type: "create_exam",
    step: "title",
    exam: {
      title: "",
      subject: "",
      duration: 30,
      questions: []
    }
  });

  await sendText(
    jid,
    "Qormaata haaraa uumuuf maqaa qormaataa barreessi."
  );
}

async function finishExamCreation(jid, session) {
  const exam = session.exam;

  if (!exam.questions.length) {
    sessions.delete(jid);

    await sendText(
      jid,
      "Qormaanni gaaffii tokko illee hin qabu. Mee irra deebi'i."
    );

    return;
  }

  let code = generateExamCode();

  // Code wal fakkaatu yoo jiraate haaromsi
  for (let attempt = 0; attempt < 5; attempt++) {
    const exists = await pool.query(
      "SELECT 1 FROM bot_exams WHERE code = $1",
      [code]
    );

    if (exists.rowCount === 0) break;

    code = generateExamCode();
  }

  await pool.query(
    `
    INSERT INTO bot_exams
      (code, creator_phone, title, subject, duration_minutes, questions)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    `,
    [
      code,
      normalizePhone(jid),
      exam.title,
      exam.subject,
      exam.duration,
      JSON.stringify(exam.questions)
    ]
  );

  sessions.delete(jid);

  await sendText(
    jid,
    `✅ Qormaanni milkaa'inaan uumame!\n\n` +
    `📘 Maqaa: ${exam.title}\n` +
    `📚 Barnoota: ${exam.subject}\n` +
    `⏱ Yeroo: Daqiiqaa ${exam.duration}\n` +
    `📝 Gaaffilee: ${exam.questions.length}\n` +
    `🔑 Koodii qormaataa: ${code}\n\n` +
    `Barattoonni qormaata kana fudhachuuf koodii kana fayyadamuu danda'u.\n\n` +
    `Menu: 0 ergi.`
  );
}

async function processExamCreation(jid, text, session) {
  const exam = session.exam;
  const input = text.trim();

  if (session.step === "title") {
    if (input.length < 2) {
      await sendText(jid, "Maqaa qormaataa sirrii barreessi.");
      return;
    }

    exam.title = input;
    session.step = "subject";

    await sendText(
      jid,
      "Maqaa barnootaa barreessi.\nFakkeenya: Qur'aana, Hadiisa, Fiqhii."
    );

    return;
  }

  if (session.step === "subject") {
    exam.subject = input;
    session.step = "duration";

    await sendText(
      jid,
      "Yeroo qormaataa daqiiqaadhaan barreessi.\nFakkeenya: 30"
    );

    return;
  }

  if (session.step === "duration") {
    const duration = Number(input);

    if (
      !Number.isInteger(duration) ||
      duration < 1 ||
      duration > 300
    ) {
      await sendText(
        jid,
        "Yeroo 1 hanga 300 gidduutti lakkoofsaan barreessi."
      );

      return;
    }

    exam.duration = duration;
    session.step = "question";

    await sendText(
      jid,
      "Gaaffii jalqabaa barreessi."
    );

    return;
  }

  if (session.step === "question") {
    if (input.length < 2) {
      await sendText(jid, "Gaaffii guutuu barreessi.");
      return;
    }

    session.currentQuestion = {
      text: input,
      options: [],
      correct: "",
      points: 1
    };

    session.step = "options";

    await sendText(
      jid,
      "Filannoowwan afran sarara adda addaatiin barreessi:\n\n" +
      "A. Filannoo tokko\n" +
      "B. Filannoo lama\n" +
      "C. Filannoo sadii\n" +
      "D. Filannoo afur\n\n" +
      "Fakkeenya kana fakkaatuun ergi."
    );

    return;
  }

  if (session.step === "options") {
    const lines = input
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const options = [];

    for (const line of lines) {
      const match = line.match(/^([A-D])[\.\)\:\-]\s*(.+)$/i);

      if (match) {
        options.push({
          letter: match[1].toUpperCase(),
          text: match[2].trim()
        });
      }
    }

    const letters = options.map((option) => option.letter);
    const valid =
      options.length === 4 &&
      ["A", "B", "C", "D"].every((letter) =>
        letters.includes(letter)
      );

    if (!valid) {
      await sendText(
        jid,
        "Filannoowwan A, B, C, D afran guutuu ergi.\n\n" +
        "Fakkeenya:\nA. Tokko\nB. Lama\nC. Sadii\nD. Afur"
      );

      return;
    }

    session.currentQuestion.options = options.sort(
      (a, b) => a.letter.localeCompare(b.letter)
    );

    session.step = "correct";

    await sendText(
      jid,
      "Deebiin sirrii kami?\nA, B, C ykn D keessaa tokko ergi."
    );

    return;
  }

  if (session.step === "correct") {
    const correct = input.toUpperCase();

    if (!["A", "B", "C", "D"].includes(correct)) {
      await sendText(
        jid,
        "Deebii sirrii A, B, C ykn D keessaa tokko ergi."
      );

      return;
    }

    session.currentQuestion.correct = correct;

    exam.questions.push(session.currentQuestion);
    session.currentQuestion = null;
    session.step = "more";

    await sendText(
      jid,
      `✅ Gaaffiin ${exam.questions.length} dabalame.\n\n` +
      `Gaaffii biraa dabaluuf 1 ergi.\n` +
      `Qormaata xumuruuf 2 ergi.`
    );

    return;
  }

  if (session.step === "more") {
    if (input === "1") {
      session.step = "question";

      await sendText(
        jid,
        `Gaaffii ${exam.questions.length + 1} barreessi.`
      );

      return;
    }

    if (input === "2") {
      await finishExamCreation(jid, session);
      return;
    }

    await sendText(
      jid,
      "Gaaffii biraa dabaluuf 1, xumuruuf 2 ergi."
    );
  }
}

// ===============================
// EXAM TAKING
// ===============================

async function beginExamTaking(jid) {
  sessions.set(jid, {
    type: "take_exam",
    step: "code"
  });

  await sendText(
    jid,
    "Koodii qormaataa barsiisaan siif kenne barreessi."
  );
}

async function showQuestion(jid, session) {
  const exam = session.exam;
  const index = session.index;
  const question = exam.questions[index];

  if (!question) {
    await finishExamTaking(jid, session);
    return;
  }

  const optionsText = (question.options || [])
    .map((option) => `${option.letter}. ${option.text}`)
    .join("\n");

  await sendText(
    jid,
    `📘 ${exam.title}\n` +
    `📚 ${exam.subject || "Barnoota"}\n\n` +
    `Gaaffii ${index + 1}/${exam.questions.length}\n\n` +
    `${question.text}\n\n` +
    `${optionsText}\n\n` +
    `Deebii kee A, B, C ykn D ergi.`
  );
}

async function processExamTaking(jid, text, session) {
  const input = text.trim();

  if (session.step === "code") {
    const result = await pool.query(
      "SELECT * FROM bot_exams WHERE UPPER(code) = UPPER($1)",
      [input]
    );

    if (result.rowCount === 0) {
      await sendText(
        jid,
        "❌ Koodiin qormaataa hin argamne. Koodii sirrii barreessi."
      );

      return;
    }

    const exam = result.rows[0];
    const questions = Array.isArray(exam.questions)
      ? exam.questions
      : [];

    if (!questions.length) {
      sessions.delete(jid);

      await sendText(
        jid,
        "Qormaanni kun gaaffii hin qabu. Barsiisaa kee qunnami."
      );

      return;
    }

    session.exam = {
      ...exam,
      questions
    };

    session.step = "name";

    await sendText(
      jid,
      `Qormaata: ${exam.title}\n\n` +
      `Maqaa kee guutuu barreessi.`
    );

    return;
  }

  if (session.step === "name") {
    if (input.length < 2) {
      await sendText(jid, "Maqaa kee guutuu barreessi.");
      return;
    }

    session.studentName = input;
    session.index = 0;
    session.answers = [];
    session.step = "answer";

    await showQuestion(jid, session);

    return;
  }

  if (session.step === "answer") {
    const answer = input.toUpperCase();

    if (!["A", "B", "C", "D"].includes(answer)) {
      await sendText(
        jid,
        "Deebii A, B, C ykn D keessaa tokko ergi."
      );

      return;
    }

    const question = session.exam.questions[session.index];

    session.answers.push({
      question: question.text,
      answer,
      correct: question.correct,
      points: Number(question.points || 1),
      earned: answer === question.correct
        ? Number(question.points || 1)
        : 0
    });

    session.index++;

    if (session.index < session.exam.questions.length) {
      await showQuestion(jid, session);
    } else {
      await finishExamTaking(jid, session);
    }
  }
}

async function finishExamTaking(jid, session) {
  const exam = session.exam;
  const answers = session.answers || [];

  const score = answers.reduce(
    (sum, answer) => sum + Number(answer.earned || 0),
    0
  );

  const total = answers.reduce(
    (sum, answer) => sum + Number(answer.points || 1),
    0
  );

  const percentage = total > 0
    ? Number(((score / total) * 100).toFixed(2))
    : 0;

  const phone = normalizePhone(jid);

  await pool.query(
    `
    INSERT INTO bot_results
      (exam_code, student_phone, student_name, score, total, percentage, answers)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
    `,
    [
      exam.code,
      phone,
      session.studentName || "",
      score,
      total,
      percentage,
      JSON.stringify(answers)
    ]
  );

  await saveUser(phone, session.studentName || "");

  sessions.delete(jid);

  await sendText(
    jid,
    `✅ Qormaata kee xumurte!\n\n` +
    `📘 Qormaata: ${exam.title}\n` +
    `👤 Barataa: ${session.studentName}\n` +
    `🎯 Qabxii: ${score}/${total}\n` +
    `📊 Dhibbeentaa: ${percentage}%\n\n` +
    `Galmeen bu'aa kee milkaa'inaan kuufameera.\n` +
    `Menu: 0 ergi.`
  );
}

// ===============================
// RESULTS
// ===============================

async function showMyResults(jid) {
  const phone = normalizePhone(jid);

  const result = await pool.query(
    `
    SELECT exam_code, student_name, score, total, percentage, submitted_at
    FROM bot_results
    WHERE student_phone = $1
    ORDER BY submitted_at DESC
    LIMIT 10
    `,
    [phone]
  );

  if (!result.rows.length) {
    await sendText(
      jid,
      "Qabxiin galmaa'e hin jiru.\nQormaata fudhattee booda bu'aan kee asitti mul'ata."
    );

    return;
  }

  let message = "📊 QABXIILEE KOO\n\n";

  result.rows.forEach((row, index) => {
    message +=
      `${index + 1}. Koodii: ${row.exam_code}\n` +
      `👤 Maqaa: ${row.student_name || "-"}\n` +
      `🎯 Qabxii: ${row.score}/${row.total}\n` +
      `📈 Dhibbeentaa: ${row.percentage}%\n\n`;
  });

  await sendText(jid, message);
}

async function showMyExams(jid) {
  const phone = normalizePhone(jid);

  const result = await pool.query(
    `
    SELECT code, title, subject, duration_minutes, created_at
    FROM bot_exams
    WHERE creator_phone = $1
    ORDER BY created_at DESC
    LIMIT 10
    `,
    [phone]
  );

  if (!result.rows.length) {
    await sendText(
      jid,
      "Ati hanga ammaatti qormaata hin uumne."
    );

    return;
  }

  let message = "📚 QORMAATA KOO\n\n";

  result.rows.forEach((exam, index) => {
    message +=
      `${index + 1}. ${exam.title}\n` +
      `📘 Barnoota: ${exam.subject || "-"}\n` +
      `🔑 Koodii: ${exam.code}\n` +
      `⏱ Yeroo: ${exam.duration_minutes} daqiiqaa\n\n`;
  });

  await sendText(jid, message);
}

// ===============================
// LESSONS
// ===============================

async function showLessons(jid) {
  await sendText(
    jid,
    `📚 BARNOOTA HIDAAyATUL-BAYAAN\n\n` +
    `1. Qur'aana\n` +
    `2. Hadiisa\n` +
    `3. Aqiiдаa\n` +
    `4. Fiqhii\n` +
    `5. Seenaa Islaamaa\n\n` +
    `Barnoota filachuuf lakkoofsa ergi.\n` +
    `Menu guddaatti deebi'uuf 0 ergi.`
  );
}

async function handleLessonChoice(jid, text) {
  const lessons = {
    "1": "📖 QUR'AANA\n\nQur'aanni kitaaba Rabbii kan Nabii Muhammad ﷺ irratti bu'eedha. Qur'aana qara'uu, tajwiidaa fi hiika isaa barachuun barbaachisaadha.",
    "2": "📚 HADIISA\n\nHadiisni jecha, hojii fi ragaa Nabii Muhammad ﷺ ti. Hadiisa sirrii madda amanamaa irraa barachuun barbaachisaadha.",
    "3": "🕌 AQIIDAA\n\nAqiidaan bu'uura amantii Islaamaa ti. Rabbitti, malaa'ikotaatti, kitaabotaatti, ergamtootaatti, Guyyaa Qiyaamaatti fi qadaraatti amanuu of keessatti qabata.",
    "4": "📘 FIQHII\n\nFiqhiin seera ibaadaa fi hojiiwwan jireenya Muslimootaa Qur'aanaa fi Sunnah irraa barachuu dha.",
    "5": "📜 SEENAA ISLAAMAA\n\nSeenaa Nabiyyoota, sahaabota fi babal'ina Islaamaa madda amanamaa irraa baradhu."
  };

  await sendText(
    jid,
    lessons[text] || "Filannoo hin beekamne. Lakkoofsa 1 hanga 5 keessaa tokko ergi."
  );
}

// ===============================
// MAIN MESSAGE HANDLER
// ===============================

async function handleMessage(msg) {
  const jid = msg?.key?.remoteJid;

  if (!jid) return;

  // Ergaa group keessatti dhufu hin hojjenna.
  if (jid.endsWith("@g.us")) return;

  if (msg.key?.fromMe) return;

  const text = getMessageText(msg.message).trim();

  if (!text) {
    console.log("MESSAGE IGNORED: Text hin qabu");
    return;
  }

  lastMessageAt = new Date().toISOString();

  const phone = normalizePhone(jid);
  const name = msg.pushName || "";

  console.log(
    "ERGAAN HAARAA:",
    phone,
    JSON.stringify(text)
  );

  try {
    await saveUser(phone, name);
  } catch (error) {
    console.error("SAVE USER ERROR:", error.message);
  }

  const normalized = normalizeText(text);

  // Menu keessaa ba'uu
  if (
    ["0", "menu", "start", "hi", "hello", "salaam", "assalaamu alaykum"].includes(normalized)
  ) {
    sessions.delete(jid);

    await sendText(jid, mainMenu(name));

    return;
  }

  // User session keessa jiraachuu
  const session = sessions.get(jid);

  if (session?.type === "create_exam") {
    await processExamCreation(jid, text, session);
    return;
  }

  if (session?.type === "take_exam") {
    await processExamTaking(jid, text, session);
    return;
  }

  // Main menu
  if (text === "1") {
    await beginExamCreation(jid);
    return;
  }

  if (text === "2") {
    await beginExamTaking(jid);
    return;
  }

  if (text === "3") {
    await showMyResults(jid);
    return;
  }

  if (text === "4") {
    await showMyExams(jid);
    return;
  }

  if (text === "5") {
    sessions.set(jid, {
      type: "lessons",
      step: "choice"
    });

    await showLessons(jid);
    return;
  }

  // Filannoo barnootaa
  if (session?.type === "lessons") {
    await handleLessonChoice(jid, text);
    return;
  }

  // Commands jechootaatiin
  if (normalized.includes("qormaata uumi")) {
    await beginExamCreation(jid);
    return;
  }

  if (normalized.includes("qormaata fudhadhu")) {
    await beginExamTaking(jid);
    return;
  }

  if (normalized.includes("qabxii")) {
    await showMyResults(jid);
    return;
  }

  if (normalized.includes("barnoota")) {
    sessions.set(jid, {
      type: "lessons",
      step: "choice"
    });

    await showLessons(jid);
    return;
  }

  await sendText(jid, mainMenu(name));
}

// ===============================
// WHATSAPP CONNECTION
// ===============================

function scheduleReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  reconnectAttempts++;

  const delay = Math.min(
    5000 * Math.pow(2, Math.min(reconnectAttempts - 1, 5)),
    60000
  );

  console.log(
    `WHATSAPP RECONNECT SCHEDULED IN ${delay}ms`
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;

    startWhatsApp().catch((error) => {
      console.error(
        "WHATSAPP RECONNECT ERROR:",
        error.stack || error
      );

      scheduleReconnect();
    });
  }, delay);
}

async function startWhatsApp() {
  if (starting) {
    console.log("WHATSAPP START SKIPPED: already starting");
    return;
  }

  if (connected && sock) {
    console.log("WHATSAPP ALREADY CONNECTED");
    return;
  }

  starting = true;

  try {
    console.log("WHATSAPP STARTING...");
    console.log("AUTH DIRECTORY:", AUTH_DIR);

    // Render irratti /tmp akka barreessuu danda'u mirkaneessi.
    fs.mkdirSync(AUTH_DIR, { recursive: true });

    const { state, saveCreds } =
      await useMultiFileAuthState(AUTH_DIR);

    const newSock = makeWASocket({
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ["Hidaayatul-Bayaan", "Chrome", "1.0.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000
    });

    sock = newSock;

    newSock.ev.on("creds.update", saveCreds);

    newSock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          qrImage = await QRCode.toDataURL(qr);

          console.log("WHATSAPP QR READY");
        } catch (error) {
          console.error("QR GENERATION ERROR:", error.message);
        }
      }

      if (connection === "connecting") {
        console.log("WHATSAPP CONNECTING...");
      }

      if (connection === "open") {
        connected = true;
        starting = false;
        reconnectAttempts = 0;
        qrImage = null;

        whatsappPhone = newSock.user?.id || null;

        console.log(
          "WHATSAPP CONNECTED:",
          whatsappPhone || "phone unknown"
        );
      }

      if (connection === "close") {
        connected = false;
        starting = false;
        qrImage = null;

        const statusCode =
          lastDisconnect?.error?.output?.statusCode;

        console.error(
          "WHATSAPP CONNECTION CLOSED:",
          statusCode || "unknown",
          lastDisconnect?.error?.message || ""
        );

        if (sock === newSock) {
          sock = null;
        }

        if (statusCode === DisconnectReason.loggedOut) {
          console.error(
            "WHATSAPP LOGGED OUT: QR haaraa scan gochuun barbaachisa."
          );

          try {
            fs.rmSync(AUTH_DIR, {
              recursive: true,
              force: true
            });

            console.log("OLD AUTH FILES REMOVED");
          } catch (error) {
            console.error(
              "AUTH CLEANUP ERROR:",
              error.message
            );
          }
        }

        scheduleReconnect();
      }
    });

    // Ergaa WhatsApp dhufu
    newSock.ev.on("messages.upsert", async (event) => {
      if (sock !== newSock) {
        console.log("MESSAGE SKIPPED: old socket");
        return;
      }

      const messages = event?.messages || [];
      const type = event?.type || "unknown";

      console.log(
        "MESSAGE EVENT:",
        type,
        "Count:",
        messages.length
      );

      // notify ergaa haaraa dha.
      if (type !== "notify") {
        console.log("MESSAGE EVENT IGNORED:", type);
        return;
      }

      for (const msg of messages) {
        try {
          console.log(
            "MESSAGE RAW:",
            JSON.stringify({
              id: msg?.key?.id,
              from: msg?.key?.remoteJid,
              fromMe: msg?.key?.fromMe,
              hasMessage: Boolean(msg?.message),
              messageTypes: Object.keys(msg?.message || {})
            })
          );

          if (!msg?.message) {
            console.log("MESSAGE SKIPPED: no message content");
            continue;
          }

          if (msg.key?.fromMe) {
            console.log("MESSAGE SKIPPED: own message");
            continue;
          }

          const text = getMessageText(msg.message);

          console.log(
            "MESSAGE EXTRACTED TEXT:",
            text || "(text not found)"
          );

          await handleMessage(msg);

          console.log(
            "MESSAGE HANDLING FINISHED:",
            msg.key?.id
          );
        } catch (error) {
          console.error(
            "MESSAGE HANDLER ERROR:",
            error.stack || error
          );
        }
      }
    });

    starting = false;

    console.log("WHATSAPP SOCKET INITIALIZED");
  } catch (error) {
    starting = false;
    connected = false;

    console.error(
      "WHATSAPP START ERROR:",
      error.stack || error
    );

    scheduleReconnect();
  }
}

// ===============================
// HTTP ROUTES
// ===============================

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="om">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#087443">
  <title>Hidaayatul-Bayaan WhatsApp Bot</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      background: #f2f7f4;
      margin: 0;
      padding: 20px;
      color: #183c2c;
    }
    .card {
      max-width: 500px;
      margin: 30px auto;
      background: white;
      border-radius: 18px;
      padding: 24px;
      text-align: center;
      box-shadow: 0 4px 18px #0001;
    }
    h1 { color: #087443; }
    #status { font-weight: bold; margin: 16px 0; }
    #qr { max-width: 280px; width: 100%; margin: 15px auto; }
    .small { color: #52685c; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Hidaayatul-Bayaan</h1>
    <p>WhatsApp Bot</p>
    <div id="status">Status ilaalamaa jira...</div>
    <img id="qr" alt="WhatsApp QR Code" hidden>
    <p class="small" id="detail"></p>
    <p class="small">
      Yoo QR mul'ate, WhatsApp kee bani.
      Linked devices → Link a device → QR scan godhi.
    </p>
  </div>
  <script>
    async function refreshStatus() {
      try {
        const response = await fetch('/api/status', {
          cache: 'no-store'
        });
        const data = await response.json();

        const status = document.getElementById('status');
        const qr = document.getElementById('qr');
        const detail = document.getElementById('detail');

        if (data.connected) {
          status.textContent = '✅ WhatsApp Connected';
          qr.hidden = true;
          detail.textContent =
            'WhatsApp sirriitti wal qabateera.';
        } else if (data.qr) {
          status.textContent =
            '📱 QR Code scan godhi';
          qr.src = data.qr;
          qr.hidden = false;
          detail.textContent =
            'WhatsApp kee QR kanaan wal qunnamsiisi.';
        } else {
          status.textContent =
            '⏳ WhatsApp wal qunnamaa jira...';
          qr.hidden = true;
          detail.textContent =
            'Maaloo yeroo muraasa eegi.';
        }
      } catch (error) {
        document.getElementById('status').textContent =
          '❌ Status argachuu hin dandeenye';
      }
    }

    refreshStatus();
    setInterval(refreshStatus, 4000);
  </script>
</body>
</html>
  `);
});

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    app: "Hidaayatul-Bayaan",
    time: new Date().toISOString()
  });
});

app.get("/api/status", (req, res) => {
  res.set("Cache-Control", "no-store");

  res.json({
    app: "Hidaayatul-Bayaan",
    connected,
    starting,
    qr: qrImage,
    phone: whatsappPhone,
    lastMessageAt,
    reconnectAttempts,
    time: new Date().toISOString()
  });
});

app.post("/api/exams", async (req, res) => {
  try {
    const {
      adminCode,
      creatorPhone,
      title,
      subject,
      duration,
      questions
    } = req.body || {};

    if (adminCode !== ADMIN_CODE) {
      return res.status(403).json({
        error: "Admin code sirrii miti."
      });
    }

    if (
      !creatorPhone ||
      !title ||
      !Array.isArray(questions) ||
      questions.length === 0
    ) {
      return res.status(400).json({
        error: "creatorPhone, title fi questions barbaachisu."
      });
    }

    const phone = normalizePhone(creatorPhone);
    const examCode = generateExamCode();

    await pool.query(
      `
      INSERT INTO bot_exams
        (code, creator_phone, title, subject, duration_minutes, questions)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      `,
      [
        examCode,
        phone,
        String(title).trim(),
        String(subject || "").trim(),
        Number(duration) || 30,
        JSON.stringify(questions)
      ]
    );

    res.status(201).json({
      success: true,
      code: examCode,
      title,
      questions: questions.length
    });
  } catch (error) {
    console.error("CREATE EXAM API ERROR:", error.stack || error);

    res.status(500).json({
      error: "Qormaata uumuu hin dandeenye."
    });
  }
});

app.get("/api/exams/:code", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT code, title, subject, duration_minutes, questions, created_at
      FROM bot_exams
      WHERE UPPER(code) = UPPER($1)
      `,
      [req.params.code]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Qormaanni hin argamne."
      });
    }

    const exam = result.rows[0];

    res.json({
      ...exam,
      questionCount: Array.isArray(exam.questions)
        ? exam.questions.length
        : 0
    });
  } catch (error) {
    console.error("GET EXAM ERROR:", error.stack || error);

    res.status(500).json({
      error: "Qormaata argachuu hin dandeenye."
    });
  }
});

app.get("/api/exams/:code/results", async (req, res) => {
  try {
    const adminCode = req.query.adminCode;

    if (adminCode !== ADMIN_CODE) {
      return res.status(403).json({
        error: "Admin code sirrii miti."
      });
    }

    const result = await pool.query(
      `
      SELECT
        exam_code,
        student_phone,
        student_name,
        score,
        total,
        percentage,
        submitted_at
      FROM bot_results
      WHERE UPPER(exam_code) = UPPER($1)
      ORDER BY submitted_at DESC
      `,
      [req.params.code]
    );

    res.json({
      code: req.params.code,
      count: result.rowCount,
      results: result.rows
    });
  } catch (error) {
    console.error("GET RESULTS ERROR:", error.stack || error);

    res.status(500).json({
      error: "Bu'aa qormaataa argachuu hin dandeenye."
    });
  }
});

// ===============================
// SERVER START
// ===============================

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log("SERVER RUNNING ON PORT:", PORT);
  console.log("HEALTH CHECK: /health");
});

async function bootstrap() {
  try {
    await initializeDatabase();
    console.log("DATABASE READY");
  } catch (error) {
    console.error(
      "DATABASE INITIALIZATION FAILED:",
      error.stack || error
    );
  }

  // Database rakkoo qabaatus server akka hin cufamne.
  await startWhatsApp();
}

bootstrap().catch((error) => {
  console.error("BOOTSTRAP ERROR:", error.stack || error);
});

async function shutdown(signal) {
  console.log("SHUTDOWN SIGNAL:", signal);

  try {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }

    if (sock) {
      try {
        sock.end(undefined);
      } catch (error) {
        console.error("SOCKET CLOSE ERROR:", error.message);
      }
    }

    server.close(() => {
      console.log("HTTP SERVER CLOSED");
    });

    await pool.end();

    process.exit(0);
  } catch (error) {
    console.error("SHUTDOWN ERROR:", error.stack || error);
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("UNCAUGHT EXCEPTION:", error.stack || error);
});
