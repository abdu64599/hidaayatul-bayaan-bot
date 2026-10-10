const express = require("express");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const AUTH_DIR =
  process.env.AUTH_DIR || path.join("/tmp", "hidaayatul-bayaan-auth");

let sock = null;
let currentQR = null;
let isWhatsAppConnected = false;
let isStarting = false;

const sessions = new Map();

/* =========================
   SEENAA NABIYYII MUHAMMAD ﷺ
========================= */

const SEENAA_NABIYYII = [
  {
    title: "Dhaloota Nabiyyii ﷺ",
    text: `Nabiyyiin Muhammad ﷺ bara 570 ykn 571 Dh.K.D.tti Makka keessatti dhalatan jedhamee beekama. Abbaa isaanii Abdullah, haadha isaanii Aamina jedhama. Isaan gosa Quraysh keessaa turan.`
  },
  {
    title: "Abbaa fi Haadha isaanii",
    text: `Abbaan Nabiyyii ﷺ osoo isaan hin dhalatin du'an. Haati isaanii Aamina yeroo Nabiyyiin ﷺ umuriin isaanii waggaa ja'a ta'u duute. Sana booda akaakayyuun isaanii Abdul-Muttalib isaan kunuunsan.`
  },
  {
    title: "Abbaa Adeessaa Abu Taalib",
    text: `Abdul-Muttalib erga du'anii booda Nabiyyiin ﷺ abbaa adeessaa isaanii Abu Taalib jalatti guddatan. Abu Taalib isaan kunuunsanii fi eegan.`
  },
  {
    title: "Amanamummaa Nabiyyii ﷺ",
    text: `Nabiyyiin Muhammad ﷺ amanamummaa fi dhugaa dubbachuun beekamu turan. Namoonni Makkaa Al-Amiin, jechuunis amanamaa, jedhanii isaan waamu turan.`
  },
  {
    title: "Fuudhaa Khadiijaa رضي الله عنها",
    text: `Nabiyyiin ﷺ Khadiijaa bint Khuwaylid رضي الله عنها fuudhan. Khadiijaan haadha warraa isaanii isa jalqabaa fi namoota jalqaba Islaama fudhatan keessaa tokko turte.`
  },
  {
    title: "Wahyiin jalqabaa",
    text: `Nabiyyiin ﷺ yeroo umuriin isaanii waggaa 40 ta'u, holqa Hiraa keessatti Jibriil عليه السلام irraa wahyii jalqabaa argatan. Aayanni jalqabaa Suuraa Al-Alaq keessaa aayata 1–5 ture.`
  },
  {
    title: "Islaama waamuu",
    text: `Nabiyyiin ﷺ namoota gara tawhiidaa, Rabbiin Tokkicha qofa gabbaruutti waamuu jalqaban. Jalqaba maatii fi hiriyoota isaanii keessaa namoota muraasa waaman; booda waamichi isaanii bal'ate.`
  },
  {
    title: "Rakkina Makkaa",
    text: `Muslimoonni jalqabaa sababii amantii isaanii Islaamaatiin rakkina hedduu keessa darbani. Nabiyyiin ﷺ obsaan, amantiitti jabaatanii, namoota gara Rabbiitti waamuu itti fufan.`
  },
  {
    title: "Hijraa gara Habaashaa",
    text: `Muslimoonni muraasni ajaja Nabiyyii ﷺ tiin gara Habaashaa godaanan. Achitti mootii Najaashii biratti nageenya argatan.`
  },
  {
    title: "Waggaa Gadda",
    text: `Khadiijaan رضي الله عنها fi Abu Taalib yeroo walitti dhihaatanii du'an. Bara kana Nabiyyiin ﷺ gadda guddaa keessa darbani; waggaa gaddaa jedhamee beekama.`
  },
  {
    title: "Hijraa gara Madiinaa",
    text: `Nabiyyiin ﷺ ajaja Rabbiitiin Makkaa irraa gara Madiinaa godaanan. Abu Bakr رضي الله عنه isaan waliin ture. Hijraan kun seenaa Islaamaa keessatti taatee guddaa dha.`
  },
  {
    title: "Masjiida Nabawii",
    text: `Madiinaa erga ga'anii booda Nabiyyiin ﷺ masjiida ijaaruu keessatti hirmaatan. Masjiidni Nabawii bakka salaataa, barnootaa fi hojii hawaasaa ta'e.`
  },
  {
    title: "Obbolummaa Muhaajirii fi Ansaar",
    text: `Nabiyyiin ﷺ Muslimoota Makkaa irraa godaanan, Muhaajiroota, fi Muslimoota Madiinaa, Ansaar, gidduutti obbolummaa cimsan. Kun tokkummaa fi waliif yaaduu guddisuuf gargaare.`
  },
  {
    title: "Lola Badrii",
    text: `Lolli Badrii bara 2 Hijriyaa keessatti Muslimoota fi Quraysh gidduutti ta'e. Muslimoonni lakkoofsaan xiqqaa turanis, Rabbiin isaan gargaaruun injifannoo argatan.`
  },
  {
    title: "Fath Makkaa",
    text: `Bara 8 Hijriyaa Nabiyyiin ﷺ Makkaa seenuun injifatan. Namoota hedduuf araara godhan. Ka'baa keessatti waaqeffannaa Rabbiin Tokkicha qofaaf ta'u deebisuun barbaachisaa ture.`
  },
  {
    title: "Hajjii Wadaa",
    text: `Nabiyyiin ﷺ bara 10 Hijriyaa hajjii isaanii isa dhumaa raawwatani. Khutbaa isaanii keessatti dhiiga, qabeenya, mirga namootaa fi waliif kabaja qabaachuu irratti gorsan.`
  },
  {
    title: "Du'a Nabiyyii ﷺ",
    text: `Nabiyyiin Muhammad ﷺ bara 11 Hijriyaa, Madiinaa keessatti du'an. Umuriin isaanii gara waggaa 63 ture. Muslimoonni Qur'aana fi Sunnah isaanii hordofuun barnoota isaanii irraa fayyadamu.`
  },
  {
    title: "Barnoota Seenaa Nabiyyii ﷺ",
    text: `Seenaa Nabiyyii ﷺ irraa dhugaa dubbachuu, amanamummaa, obsa, araara, rahmata, haqa fi Rabbiin irratti hirkachuu baranna.`
  }
];

/* =========================
   SEENAA SAHABOOTAA
========================= */

const SEENAA_SAHABOOTAA = [
  {
    title: "Abu Bakr As-Siddiiq رضي الله عنه",
    text: `Abu Bakr رضي الله عنه hiriyyaa dhihoo Nabiyyii ﷺ fi dhiira bilisa ta'e keessaa nama jalqabaa Islaama fudhate ture. Hijraa keessatti Nabiyyii ﷺ waliin ture. Erga Nabiyyiin ﷺ du'anii booda khalifaa jalqabaa ta'e.`
  },
  {
    title: "Umar ibn Al-Khattab رضي الله عنه",
    text: `Umar رضي الله عنه khalifaa lammaffaa ture. Haqa, murtii cimaa fi haqaan bulchuu isaatiin beekama. Yeroo isaa keessatti mootummaa Islaamaa bal'inaan babal'ate.`
  },
  {
    title: "Usman ibn Affan رضي الله عنه",
    text: `Usman رضي الله عنه khalifaa sadaffaa ture. Qabeenya isaa Muslimoota gargaaruuf oolcha ture. Mushafii Qur'aanaa irratti Muslimoonni tokko akka hordofan hojii guddaa raawwate.`
  },
  {
    title: "Ali ibn Abi Taalib رضي الله عنه",
    text: `Ali رضي الله عنه ilma abbaa adeessaa Nabiyyii ﷺ fi abbaa warraa Faaximaa رضي الله عنها ture. Khalifaa afraffaa fi nama beekumsa, gootummaa fi murtii isaatiin beekamu ture.`
  },
  {
    title: "Khadiijaa bint Khuwaylid رضي الله عنها",
    text: `Khadiijaan رضي الله عنها haadha warraa Nabiyyii ﷺ isa jalqabaa turte. Yeroo wahyiin jalqabaa dhufe Nabiyyii ﷺ jajjabeessite, amantii isaanii fudhatte, qabeenya isheetiinis Islaama deeggarte.`
  },
  {
    title: "Aa'ishaa رضي الله عنها",
    text: `Aa'ishaan رضي الله عنها haadha warraa Nabiyyii ﷺ turte. Beekumsa hadiisaa fi fiqhiitiin beekamti. Sahaboonni hedduun beekumsa amantii ishee irraa baratan.`
  },
  {
    title: "Bilaal ibn Rabaah رضي الله عنه",
    text: `Bilaal رضي الله عنه Muslimoota jalqabaa keessaa tokko ture. Rakkina guddaa keessa darbellee amantii isaa irratti jabaate. Nabiyyiin ﷺ mu'azzina isaanii godhan.`
  },
  {
    title: "Mus'ab ibn Umayr رضي الله عنه",
    text: `Mus'ab رضي الله عنه dargaggeessa Quraysh keessaa jireenya qananii qabu ture. Islaama erga fudhatee booda amantii isaa filate. Nabiyyiin ﷺ isa gara Madiinaa barsiisaa fi waamicha amantii godhuuf ergan.`
  },
  {
    title: "Abu Hurayrah رضي الله عنه",
    text: `Abu Hurayrah رضي الله عنه hadiisa Nabiyyii ﷺ baay'ee dabarse. Beekumsa Sunnah tiksuu fi barsiisuu keessatti gahee guddaa qaba.`
  },
  {
    title: "Salmaan Al-Faarisii رضي الله عنه",
    text: `Salmaan رضي الله عنه dhugaa amantii barbaacha imala dheeraa godhe. Dhumarratti Islaama fudhate. Yaada boolla qotuu lola Khandaq keessatti dhiheessuun beekama.`
  },
  {
    title: "Abdur-Rahmaan ibn Awf رضي الله عنه",
    text: `Abdur-Rahmaan رضي الله عنه sahaabaa dureessa fi arjaa ture. Qabeenya isaa Muslimoota gargaaruuf oolcha ture. Dureessummaa isaa waliin tawwaa fi sadaqaa jaallata ture.`
  },
  {
    title: "Abu Ubaydah ibn Al-Jarraah رضي الله عنه",
    text: `Abu Ubaydah رضي الله عنه sahaabaa amanamaa fi hogganaa waraanaa ture. Nabiyyiin ﷺ amanamummaa isaa faarsan.`
  },
  {
    title: "Talhah ibn Ubaydillah رضي الله عنه",
    text: `Talhah رضي الله عنه sahaabaa goota ture. Lola Uhud keessatti Nabiyyii ﷺ eeguuf gootummaa guddaa agarsiise.`
  },
  {
    title: "Az-Zubayr ibn Al-Awwaam رضي الله عنه",
    text: `Az-Zubayr رضي الله عنه sahaabaa goota fi namoota Islaama jalqabaa fudhatan keessaa tokko ture. Lola keessatti Nabiyyii ﷺ deeggaruun beekama.`
  },
  {
    title: "Sa'd ibn Abi Waqqaas رضي الله عنه",
    text: `Sa'd رضي الله عنه sahaabaa goota ture. Muslimoota jalqabaa keessaa tokko yoo ta'u, xiyya darbuu irratti beekama.`
  },
  {
    title: "Khaalid ibn Al-Waliid رضي الله عنه",
    text: `Khaalid رضي الله عنه hogganaa waraanaa beekamaa ture. Islaama erga fudhatee booda Muslimootaaf lolaa fi hojii waraanaa keessatti tajaajila guddaa kenne.`
  },
  {
    title: "Ja'far ibn Abi Taalib رضي الله عنه",
    text: `Ja'far رضي الله عنه obboleessa Alii fi sahaabaa goota ture. Habaashaa keessatti Muslimoota bakka bu'uun mootii Najaashii duratti haala Muslimootaa ibse.`
  },
  {
    title: "Anas ibn Maalik رضي الله عنه",
    text: `Anas رضي الله عنه waggoota hedduuf Nabiyyii ﷺ tajaajile. Hadiisa hedduu dabarse; amala gaarii Nabiyyii ﷺ irraa barate.`
  },
  {
    title: "Abu Dharr Al-Ghifaarii رضي الله عنه",
    text: `Abu Dharr رضي الله عنه Islaama jalqaba fudhatan keessaa tokko ture. Jireenya salphaa, dhugaa dubbachuu fi qabeenya irratti of eeggannoo qabaachuu irratti beekama.`
  },
  {
    title: "Umm Salama رضي الله عنها",
    text: `Umm Salama رضي الله عنها haadha warraa Nabiyyii ﷺ fi dubartii beekumsa qabdu turte. Gorsa fi beekumsa isheetiin Muslimoota gargaarte.`
  }
];

/* =========================
   MENU
========================= */

function mainMenu() {
  return `🌿 *HIDAAYATUL-BAYAAN* 🌿

Assalaamu Alaikum warahmatullaahi wabarakaatuh.

Baga gara Hidaayatul-Bayaan dhuftan.

📚 Barnoota keenya keessaa filadhu:

1️⃣ Seenaa Nabiyyii Muhammad ﷺ
2️⃣ Seenaa Sahabootaa

🔢 Lakkoofsa 1 ykn 2 ergi.

0️⃣ Gara menu jalqabaatti deebi'i.

اللهم صل وسلم على نبينا محمد ﷺ`;
}

function makeList(items, heading) {
  let result = `${heading}\n\n`;

  items.forEach((item, index) => {
    result += `${index + 1}️⃣ ${item.title}\n`;
  });

  result += `\nLakkoofsa seenaa barbaaddu ergi.\n0️⃣ Gara menu jalqabaatti deebi'i.`;
  return result;
}

function storyText(item, index, items) {
  const next = index < items.length - 1
    ? `\n\n➡️ Itti aanuuf: ${index + 2} ergi.`
    : `\n\n✅ Seenaa tarree kanaa xumurteetta.`;

  return `📖 *${item.title}*\n\n${item.text}${next}\n\n0️⃣ Menu jalqabaatti deebi'i.`;
}

/* =========================
   WHATSAPP MESSAGE HANDLER
========================= */

async function handleMessage(message) {
  const jid = message.key.remoteJid;

  if (!jid || jid === "status@broadcast" || message.key.fromMe) {
    return;
  }

  const messageType = Object.keys(message.message || {})[0];

  if (
    messageType === "protocolMessage" ||
    messageType === "senderKeyDistributionMessage"
  ) {
    return;
  }

  const text =
    message.message?.conversation ||
    message.message?.extendedTextMessage?.text ||
    message.message?.imageMessage?.caption ||
    "";

  const input = text.trim();

  if (!input) return;

  const lower = input.toLowerCase();

  if (
    ["hi", "hello", "salaam", "assalamu alaikum", "assalaamu alaikum", "akkam"].includes(lower)
  ) {
    sessions.delete(jid);
    await sock.sendMessage(jid, { text: mainMenu() });
    return;
  }

  if (input === "0") {
    sessions.delete(jid);
    await sock.sendMessage(jid, { text: mainMenu() });
    return;
  }

  const session = sessions.get(jid);

  if (session?.section === "nabi") {
    const number = Number(input);

    if (
      Number.isInteger(number) &&
      number >= 1 &&
      number <= SEENAA_NABIYYII.length
    ) {
      const index = number - 1;
      await sock.sendMessage(jid, {
        text: storyText(SEENAA_NABIYYII[index], index, SEENAA_NABIYYII)
      });
      return;
    }

    await sock.sendMessage(jid, {
      text: `Lakkoofsa sirrii galchi.\n1 hanga ${SEENAA_NABIYYII.length} filadhu.\n\n0️⃣ Menu jalqabaatti deebi'i.`
    });
    return;
  }

  if (session?.section === "sahaba") {
    const number = Number(input);

    if (
      Number.isInteger(number) &&
      number >= 1 &&
      number <= SEENAA_SAHABOOTAA.length
    ) {
      const index = number - 1;
      await sock.sendMessage(jid, {
        text: storyText(SEENAA_SAHABOOTAA[index], index, SEENAA_SAHABOOTAA)
      });
      return;
    }

    await sock.sendMessage(jid, {
      text: `Lakkoofsa sirrii galchi.\n1 hanga ${SEENAA_SAHABOOTAA.length} filadhu.\n\n0️⃣ Menu jalqabaatti deebi'i.`
    });
    return;
  }

  if (input === "1") {
    sessions.set(jid, { section: "nabi" });

    await sock.sendMessage(jid, {
      text: makeList(SEENAA_NABIYYII, "📖 *SEENAA NABIYYII MUHAMMAD ﷺ*")
    });
    return;
  }

  if (input === "2") {
    sessions.set(jid, { section: "sahaba" });

    await sock.sendMessage(jid, {
      text: makeList(SEENAA_SAHABOOTAA, "🌟 *SEENAA SAHABOOTAA رضي الله عنهم*")
    });
    return;
  }

  await sock.sendMessage(jid, {
    text: `Filannoo kee sirriitti hin hubanne.\n\n${mainMenu()}`
  });
}

/* =========================
   START WHATSAPP
========================= */

async function startWhatsApp() {
  if (isStarting) return;

  isStarting = true;

  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      auth: state,
      logger: pino({ level: "silent" }),
      browser: ["Hidaayatul-Bayaan", "Chrome", "1.0.0"],
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR = qr;
        console.log("WhatsApp QR code generated.");
      }

      if (connection === "open") {
        isWhatsAppConnected = true;
        currentQR = null;
        console.log("Hidaayatul-Bayaan WhatsApp connected.");
      }

      if (connection === "connecting") {
        isWhatsAppConnected = false;
        console.log("WhatsApp connecting...");
      }

      if (connection === "close") {
        isWhatsAppConnected = false;

        const statusCode =
          lastDisconnect?.error?.output?.statusCode;

        console.log("WhatsApp connection closed:", statusCode || "unknown");

        if (statusCode !== DisconnectReason.loggedOut) {
          setTimeout(() => {
            isStarting = false;
            startWhatsApp();
          }, 5000);
        } else {
          currentQR = null;
          console.log(
            "WhatsApp logged out. Remove saved session and reconnect."
          );
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const message of messages) {
        try {
          await handleMessage(message);
        } catch (error) {
          console.error("Message handling error:", error.message);
        }
      }
    });

  } catch (error) {
    console.error("WhatsApp startup error:", error.message);

    setTimeout(() => {
      isStarting = false;
      startWhatsApp();
    }, 10000);

    return;
  }

  isStarting = false;
}

/* =========================
   WEBSITE HOME PAGE
========================= */

app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="om">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#087443">
  <title>Hidaayatul-Bayaan</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 20px;
      font-family: Arial, sans-serif;
      background: #f0f7f3;
      color: #183c2c;
      text-align: center;
    }
    .card {
      max-width: 520px;
      margin: 30px auto;
      background: white;
      padding: 25px;
      border-radius: 18px;
      box-shadow: 0 5px 25px #00000012;
    }
    h1 { color: #087443; }
    .status {
      padding: 12px;
      margin: 12px 0;
      border-radius: 10px;
      background: #f1f7f3;
      overflow-wrap: anywhere;
    }
    #whatsappQR {
      display: none;
      width: 280px;
      max-width: 100%;
      margin: 15px auto;
      border: 1px solid #ddd;
      border-radius: 10px;
    }
    .hint {
      line-height: 1.7;
      color: #456354;
      font-size: 14px;
    }
    .warning {
      color: #925900;
      background: #fff5db;
      padding: 12px;
      border-radius: 10px;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>🌿 Hidaayatul-Bayaan</h1>
    <p>Seenaa Nabiyyii Muhammad ﷺ fi Seenaa Sahabootaa</p>

    <div class="status" id="serverStatus">
      Server: 🟢 Running
    </div>

    <div class="status" id="whatsappStatus">
      WhatsApp: 🟠 Connecting...
    </div>

    <hr>

    <h2>📱 WhatsApp Walqabsiisi</h2>
    <p id="qrStatus">QR Code barbaadaa jira...</p>

    <img id="whatsappQR" alt="WhatsApp QR Code">

    <div class="hint" id="instructions">
      WhatsApp kee bani → Settings ykn menu ⋮ → Linked Devices
      → Link a Device → QR Code scan godhi.
    </div>

    <p class="warning">
      ⚠️ QR Code kana namoota hin amanneef hin agarsiisin.
      Namni QR kana scan godhu WhatsApp bot kana walqabsiisuu danda'a.
    </p>
  </div>

  <script>
    async function loadStatus() {
      try {
        const response = await fetch("/api/status");
        const data = await response.json();

        document.getElementById("serverStatus").textContent =
          "Server: 🟢 Running";

        document.getElementById("whatsappStatus").textContent =
          data.whatsappConnected
            ? "WhatsApp: 🟢 Connected"
            : "WhatsApp: 🟠 Connecting";
      } catch (error) {
        document.getElementById("serverStatus").textContent =
          "Server: 🔴 Error";
      }
    }

    async function loadQR() {
      const status = document.getElementById("qrStatus");
      const image = document.getElementById("whatsappQR");

      try {
        const response = await fetch("/api/whatsapp/qr");
        const data = await response.json();

        if (data.connected) {
          status.textContent = "✅ WhatsApp walqabateera!";
          image.style.display = "none";
          return;
        }

        if (data.qrReady && data.qr) {
          image.src = data.qr;
          image.style.display = "block";
          status.textContent =
            "QR Code kana WhatsApp kee irraa scan godhi.";
        } else {
          image.style.display = "none";
          status.textContent =
            data.message || "QR Code ammallee hin uumamne. Eegi...";
        }
      } catch (error) {
        status.textContent =
          "QR argachuun hin danda'amne. Xiqqoo booda irra deebi'i.";
      }
    }

    loadStatus();
    loadQR();

    setInterval(loadStatus, 5000);
    setInterval(loadQR, 3000);
  </script>
</body>
</html>`);
});

/* =========================
   QR API
========================= */

app.get("/api/whatsapp/qr", async (req, res) => {
  try {
    if (isWhatsAppConnected) {
      return res.json({
        connected: true,
        qrReady: false,
        message: "WhatsApp duraan walqabateera."
      });
    }

    if (!currentQR) {
      return res.status(202).json({
        connected: false,
        qrReady: false,
        message: "QR Code ammallee hin uumamne. Xiqqoo eegi."
      });
    }

    const qrImage = await QRCode.toDataURL(currentQR);

    return res.json({
      connected: false,
      qrReady: true,
      qr: qrImage,
      message: "QR Code kana scan godhi."
    });
  } catch (error) {
    console.error("QR generation error:", error.message);

    return res.status(500).json({
      error: "QR Code uumuu hin dandeenye."
    });
  }
});

/* =========================
   HEALTH & STATUS
========================= */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    app: "Hidaayatul-Bayaan",
    server: "running",
    whatsappConnected: isWhatsAppConnected
  });
});

app.get("/api/status", (req, res) => {
  res.json({
    app: "Hidaayatul-Bayaan",
    serverRunning: true,
    whatsappConnected: isWhatsAppConnected,
    qrReady: Boolean(currentQR),
    time: new Date().toISOString()
  });
});

/* =========================
   START SERVER
========================= */

app.listen(PORT, "0.0.0.0", () => {
  console.log("Hidaayatul-Bayaan running on port " + PORT);
  startWhatsApp();
});
