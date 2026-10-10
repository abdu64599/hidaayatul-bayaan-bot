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
  proto
} = require("@whiskeysockets/baileys");

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;

const logger = pino({ level: "warn" });

if (!DATABASE_URL) {
  console.error("DATABASE_URL hin argamne.");
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

/* =========================================
   DATABASE
========================================= */

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

async function createDatabaseAuthState() {
  const result = await pool.query(
    "SELECT data FROM whatsapp_auth_creds WHERE id = $1",
    ["main"]
  );

  let creds;

  if (result.rows.length) {
    creds = decodeJSON(result.rows[0].data);
    console.log("WhatsApp session database irraa fe'ame.");
  } else {
    creds = initAuthCreds();

    await pool.query(
      `INSERT INTO whatsapp_auth_creds (id, data)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      ["main", encodeJSON(creds)]
    );

    console.log("Session WhatsApp haaraan uumame.");
  }

  const keys = {
    async get(type, ids) {
      if (!ids || !ids.length) return {};

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

        if (type === "app-state-sync-key" && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value);
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
            if (value == null) {
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

/* =========================================
   SEENAA NABII MUHAMMAD ﷺ
========================================= */

const MUHAMMAD_STORY = [
  {
    title: "1. Dhalachuu fi ijoollummaa",
    text:
      "Nabiyyiin Muhammad ﷺ Makkaa keessatti bara Filaa jedhamuun beekamu keessa dhalatan. " +
      "Abbaan isaanii Abdullah, haati isaanii Aaminah bint Wahb turan. " +
      "Isaan osoo hin dhalatin abbaan isaanii du'e. " +
      "Ijoollummaatti haadha isaanii, achiis abbaa guddiftuu isaanii Abdul-Muxxalib dhabani. " +
      "Ergasii eessuma isaanii Abu Taalib kunuunsa isaanii jalatti guddatan."
  },
  {
    title: "2. Amanamummaa fi gaa'ela",
    text:
      "Nabiyyiin Muhammad ﷺ dhugaa dubbachuu fi amanamummaa isaanii irraa kan ka'e Al-Amiin jechuun waamamu turan. " +
      "Daldala keessatti amanamummaa agarsiisan. " +
      "Umurii waggaa 25tti Khadiijah bint Khuwaylid (RA) waliin gaa'ela godhan. " +
      "Khadiijah (RA) yeroo jalqaba wahyii fudhatan Nabiyyicha deeggaruun gahee guddaa qabdi."
  },
  {
    title: "3. Wahyii jalqabaa",
    text:
      "Nabiyyiin Muhammad ﷺ yeroo umuriin isaanii waggaa 40 ga'u, holqa Hiraa keessatti ibaadaa fi xiinxalaaf yeroo dabarsu turan. " +
      "Achitti Jibriil (AS) dhufee wahyii jalqabaa, aayata jalqabaa Suuraa Al-Alaq, itti dabarse. " +
      "Nabiyyummaan isaanii achumaan jalqabe. " +
      "Khadiijah (RA) isaan jajjabeessite; Waraqah ibn Nawfal waliin mari'achuunis seenaa jalqabaa kana keessatti ni yaadatama."
  },
  {
    title: "4. Da'waa Makkaa",
    text:
      "Nabiyyiin Muhammad ﷺ namoota gara Rabbiin tokko qofa gabbaruu, shirkii dhiisuu, dhugaa dubbachuu fi amala gaarii qabaachuuf waaman. " +
      "Jalqaba namoota muraasa dhoksaadhaan barsiisan; booda ifatti da'waa godhan. " +
      "Muslimoonni jalqabaa gariin ari'atamaa fi dararama keessa darban. " +
      "Nabiyyiin obsa, rahmata fi Rabbitti hirkachuu barsiisan."
  },
  {
    title: "5. Hijraa gara Madiinaa",
    text:
      "Makkaa keessatti Muslimoonni rakkoo guddaa keessa erga darban booda, Nabiyyiin Muhammad ﷺ ajaja Rabbii irratti hirkachuun Madiinaa godaanan. " +
      "Abuu Bakr As-Siddiiq (RA) imala kana keessatti isaanii waliin ture. " +
      "Madiinaa keessatti masjiida ijaaran, Muslimoota walitti hidhan, obbolummaa isaanii cimsan, hawaasa haqaa fi walii gargaaruu irratti hundaa'e ijaaran."
  },
  {
    title: "6. Jireenya Madiinaa",
    text:
      "Madiinaa keessatti Nabiyyiin ﷺ namoota barsiisan, hawaasa isaanii qindeessan, waliigaltee fi haqaan jiraachuu irratti xiyyeeffatan. " +
      "Duulaalee Badr, Uhud fi Khandaq seenaa hawaasa Muslimootaa keessatti iddoo guddaa qabu. " +
      "Nabiyyiin murtii keessatti haqaan hojjechuu, waadaa eeguu fi nama dadhabaa gargaaruu barsiisan."
  },
  {
    title: "7. Fath Makkaa",
    text:
      "Bara 8 Hijraa keessatti Muslimoonni Makkaa seenuun seenaa guddaa raawwatan. " +
      "Nabiyyiin Muhammad ﷺ yeroo humna qabanitti namoota hedduuf dhiifama godhan. " +
      "Amalli isaanii araara, gad of qabuu fi rahmata agarsiisuun beekama. " +
      "Seenaa kana irraa dhiifama, obsa fi humna yeroo argatanitti haqaan jiraachuu baranna."
  },
  {
    title: "8. Hajjii fi du'a",
    text:
      "Nabiyyiin Muhammad ﷺ Hajjii isaanii isa dhumaa keessatti namootaaf gorsa guddaa kennan. " +
      "Dhiiga, qabeenya fi kabaja namaa eeguu, haqa raawwachuu fi waan namootaaf amaname deebisuu barsiisan. " +
      "Bara 11 Hijraa keessatti Madiinaa keessatti du'aan boqotan. " +
      "Qur'aanni fi Sunnah isaanii Muslimootaaf qajeelfama guddaa ta'anii hafu."
  },
  {
    title: "9. Amala Nabiyyii ﷺ",
    text:
      "Nabiyyiin Muhammad ﷺ dhugaa dubbachuu, amanamummaa, obsa, arjummaa, rahmata fi gad of qabuu irratti fakkeenya gaarii turan. " +
      "Maatii isaanii gargaaru, daa'immanitti rahmata godhu, hiyyeeyyii kunuunsu, ollaa waliin gaariitti jiraachuu barsiisu turan. " +
      "Muslimoonni jireenya isaanii irraa amala gaarii fi ibaadaa baratu."
  }
];

/* =========================================
   SEENAA NABIYYOOTA BIROO
========================================= */

const OTHER_PROPHETS = {
  aadam: {
    name: "Nabii Aadam (AS)",
    parts: [
      {
        title: "Uumama Aadam",
        text:
          "Nabii Aadam (AS) nama jalqabaa fi nabii jalqabaa ture. " +
          "Rabbiin isa uume, maqaa wantoota isa barsiise. " +
          "Rabbiin malaa'ikotaaf sadjoodii kabajaa akka Aadamif godhan ajaje."
      },
      {
        title: "Tawbaa fi barumsa",
        text:
          "Aadamii fi haati keenya Hawwaa dogoggora erga raawwatanii booda gara Rabbii tawbaa godhan. " +
          "Seenaa isaanii irraa tawbaa, ajaja Rabbii kabajuu fi araara Rabbii abdachuu baranna."
      }
    ]
  },

  nuuh: {
    name: "Nabii Nuuh (AS)",
    parts: [
      {
        title: "Da'waa Nuuh",
        text:
          "Nabii Nuuh (AS) ummata isaa yeroo dheeraaf gara ibaadaa Rabbii qofaatti waame. " +
          "Guyyaa fi halkan isaan gorse, garuu namoonni hedduun didan. " +
          "Inni obsa fi amanamummaa keessatti fakkeenya ta'e."
      },
      {
        title: "Dooyyee fi barumsa",
        text:
          "Rabbiin Nuuh (AS) doonii akka ijaaru ajaje. " +
          "Namoonni amanan doonii seenuun balaa bishaan guddaa irraa baraaraman. " +
          "Seenaa kana irraa ajaja Rabbii hordofuu fi obsa qabaachuu baranna."
      }
    ]
  },

  ibraahim: {
    name: "Nabii Ibraahiim (AS)",
    parts: [
      {
        title: "Tawhiida",
        text:
          "Nabii Ibraahiim (AS) ummata isaa gara Rabbii tokko qofa gabbaruutti waame. " +
          "Waan uumaman gabbaruun sirrii akka hin taane ibse. " +
          "Tawhiida irratti dhaabbachuun amala isaa guddaa ture."
      },
      {
        title: "Qormaata fi barumsa",
        text:
          "Nabii Ibraahiim (AS) qormaata hedduu keessa darban; Rabbitti hirkachuu fi ajaja Isaa fudhachuu keessatti fakkeenya ta'an. " +
          "Inni Ismaa'iil (AS) waliin Ka'baan akka ijaaramtu keessatti hirmaate. " +
          "Seenaa isaanii irraa amantii, obsa fi ajaja Rabbii hordofuu baranna."
      }
    ]
  }
};

/* =========================================
   SEENAA SAHABOOTAA
========================================= */

const SAHABAS = [
  {
    name: "Abuu Bakr As-Siddiiq (RA)",
    parts: [
      {
        title: "Jireenya fi Islaamummaa",
        text:
          "Abuu Bakr (RA) maqaan isaanii Abdullah ibn Abi Quhaafah ture. " +
          "Isaan namoota Islaama jalqaba fudhatan keessaa tokko turan. " +
          "Nabiyyii Muhammad ﷺ amananii deeggaruun beekamu. " +
          "Arjummaa fi amanamummaan isaanii Muslimoota biratti fakkeenya gaarii ta'e."
      },
      {
        title: "Hijraa fi khilaafaa",
        text:
          "Abuu Bakr (RA) Hijraa gara Madiinaa keessatti Nabiyyii ﷺ waliin ture. " +
          "Nabiyyiin erga du'anii booda khalifaa jalqabaa ta'e. " +
          "Muslimoota walitti qabuu fi hawaasa Islaamaa tikfachuu keessatti gahee guddaa qaba ture."
      }
    ]
  },
  {
    name: "Umar ibn Al-Khattaab (RA)",
    parts: [
      {
        title: "Islaamummaa fi amalli isaa",
        text:
          "Umar (RA) jalqaba Islaama mormaa ture; booda Muslim ta'uun Islaamaaf jabinaan dhaabbate. " +
          "Gootummaa, haq-qabeessummaa fi murtii cimaa irratti beekama. " +
          "Islaamummaa fudhachuun Muslimootaaf jajjabina guddaa ta'e."
      },
      {
        title: "Khalifaa lammaffaa",
        text:
          "Umar (RA) khalifaa lammaffaa ta'e. " +
          "Bulchiinsa keessatti haqa, itti gaafatamummaa fi namoota rakkatan gargaaruu irratti xiyyeeffate. " +
          "Seenaa isaa irraa haqaan murteessuu fi amanamummaa baranna."
      }
    ]
  },
  {
    name: "Uthmaan ibn Affaan (RA)",
    parts: [
      {
        title: "Amala fi arjummaa",
        text:
          "Uthmaan (RA) sahaabaa amanamaa fi arjaa ture. " +
          "Qabeenya isaa hojii gaarii fi Muslimoota gargaaruuf oolcha ture. " +
          "Nabiyyii Muhammad ﷺ irraa kabaja qaba ture."
      },
      {
        title: "Khalifaa sadaffaa",
        text:
          "Uthmaan (RA) khalifaa sadaffaa ta'e. " +
          "Yeroo bulchiinsa isaa keessatti Qur'aana barreessuu fi qira'aa isaa Muslimoota biratti walitti fiduu irratti hojii guddaa raawwatame. " +
          "Seenaa isaa irraa arjummaa fi tajaajila amantii baranna."
      }
    ]
  },
  {
    name: "Ali ibn Abii Taalib (RA)",
    parts: [
      {
        title: "Jireenya jalqabaa",
        text:
          "Ali (RA) ilma abbeeraa Nabiyyii Muhammad ﷺ ture. " +
          "Ijoollee keessaa namoota Islaama jalqaba fudhatan keessaa tokko. " +
          "Beekumsa, gootummaa fi Nabiyyii ﷺ waliin dhiyeenya qabaachuun beekama."
      },
      {
        title: "Khalifaa afraffaa",
        text:
          "Ali (RA) khalifaa afraffaa ta'e. " +
          "Beekumsa, ibaadaa fi murtii irratti gahee guddaa qaba ture. " +
          "Seenaa isaa irraa beekumsa barbaaduu, haqaan jiraachuu fi Rabbitti hirkachuu baranna."
      }
    ]
  },
  {
    name: "Bilaal ibn Rabaah (RA)",
    parts: [
      {
        title: "Obsa fi Islaamummaa",
        text:
          "Bilaal (RA) Muslimoota jalqabaa keessaa tokko ture. " +
          "Sababa amantii isaa irraa kan ka'e dararama guddaa keessa darbe, garuu amantii isaa hin dhiisne. " +
          "Obsa isaa irraa fakkeenya guddaa arganna."
      },
      {
        title: "Mu'azzina Islaamaa",
        text:
          "Bilaal (RA) mu'azzina Nabiyyii Muhammad ﷺ keessaa isa beekamaa ture. " +
          "Sagalee isaa fayyadamuun namoota salaataaf waama ture. " +
          "Seenaa isaa irraa obsa, tawhiida fi ibaadaa baranna."
      }
    ]
  },
  {
    name: "Khaalid ibn Al-Waliid (RA)",
    parts: [
      {
        title: "Gootummaa fi Islaamummaa",
        text:
          "Khaalid ibn Al-Waliid (RA) dura Muslimoota mormaa ture; booda Islaama fudhate. " +
          "Gootummaa fi dandeettii waraanaa isaatiin beekama. " +
          "Nabiyyiin Muhammad ﷺ isa kabajanii ture."
      },
      {
        title: "Tajaajila Islaamaa",
        text:
          "Khaalid (RA) Islaamaaf tajaajila guddaa kenne. " +
          "Seenaa isaa irraa dandeettii ofii hojii gaarii keessatti fayyadamuu fi ajaja Rabbii hordofuu baranna."
      }
    ]
  },
  {
    name: "Abdur-Rahmaan ibn Awf (RA)",
    parts: [
      {
        title: "Daldalaa amanamaa",
        text:
          "Abdur-Rahmaan ibn Awf (RA) sahaabaa dureessa ta'ee beekama, garuu qabeenya isaa keessatti arjummaa qaba ture. " +
          "Daldala keessatti amanamummaa fi hojii cimaa irratti fakkeenya ture."
      },
      {
        title: "Arjummaa",
        text:
          "Abdur-Rahmaan (RA) qabeenya isaa Muslimoota gargaaruuf oolcha ture. " +
          "Seenaa isaa irraa qabeenya karaa gaarii fayyadamuu, arjummaa fi amanamummaa baranna."
      }
    ]
  },
  {
    name: "Sa'd ibn Abii Waqqaas (RA)",
    parts: [
      {
        title: "Muslimoota jalqabaa keessaa",
        text:
          "Sa'd ibn Abii Waqqaas (RA) Muslimoota jalqabaa keessaa tokko ture. " +
          "Gootummaa fi amantii irratti dhaabbataa ta'uun beekama. " +
          "Nabiyyii Muhammad ﷺ waliin ta'uun hojiiwwan Islaamaa keessatti hirmaate."
      },
      {
        title: "Tajaajila isaa",
        text:
          "Sa'd (RA) Islaamaaf tajaajila guddaa kenne. " +
          "Seenaa isaa irraa amantii irratti dhaabbachuu, obsa qabaachuu fi hojii gaarii keessatti hirmaachuu baranna."
      }
    ]
  },
  {
    name: "Mus'ab ibn Umayr (RA)",
    parts: [
      {
        title: "Jireenya irraa jijjiirama",
        text:
          "Mus'ab ibn Umayr (RA) dargaggeessa Makkaa keessatti jireenya mijataa qabu ture. " +
          "Islaama erga fudhatee booda qormaata hedduu keessa darbe. " +
          "Amantii isaa jireenya qananii caalaa filate."
      },
      {
        title: "Da'waa Madiinaa",
        text:
          "Mus'ab (RA) Madiinaa keessatti Islaama barsiisuuf ergame. " +
          "Da'waa fi barsiisa isaa keessatti gahee guddaa qaba ture. " +
          "Seenaa isaa irraa amantii, fedhii ofii aarsaa gochuu fi beekumsa barsiisuu baranna."
      }
    ]
  },
  {
    name: "Abuu Hurayrah (RA)",
    parts: [
      {
        title: "Barnoota hadiisaa",
        text:
          "Abuu Hurayrah (RA) sahaabaa hadiisa Nabiyyii Muhammad ﷺ baay'ee dabarse keessaa isa beekamaa dha. " +
          "Yeroo isaa barachuu fi waan Nabiyyiin barsiisan yaadachuuf oolcha ture."
      },
      {
        title: "Barumsa isaa",
        text:
          "Abuu Hurayrah (RA) Muslimootaaf beekumsa hadiisaa dabarsu keessatti gahee guddaa qaba ture. " +
          "Seenaa isaa irraa beekumsa barbaaduu, waan baranne dabarsuu fi yeroo keenya barnootaaf oolchuu baranna."
      }
    ]
  }
];

/* =========================================
   MENU FUNCTIONS
========================================= */

function mainMenu() {
  return (
    "🌿 *HIDAAYATUL-BAYAAN*\n\n" +
    "Baga nagaan dhuftan!\n" +
    "Maal barachuu barbaaddu?\n\n" +
    "1️⃣ Seenaa Nabiyyii Muhammad ﷺ\n" +
    "2️⃣ Seenaa Nabiyyoota biroo\n" +
    "3️⃣ Seenaa Sahaabootaa\n\n" +
    "0️⃣ Menu jalqabaatti deebi'i\n\n" +
    "📚 Barnoonni ifsaadha!"
  );
}

function muhammadMenu() {
  return (
    "📖 *SEENAA NABIYYII MUHAMMAD ﷺ*\n\n" +
    MUHAMMAD_STORY.map((part, index) =>
      `${index + 1}️⃣ ${part.title}`
    ).join("\n") +
    "\n\n0️⃣ Menu jalqabaatti deebi'i"
  );
}

function prophetMenu() {
  return (
    "📖 *SEENAA NABIYYOOTA BIROO*\n\n" +
    "1️⃣ Nabii Aadam (AS)\n" +
    "2️⃣ Nabii Nuuh (AS)\n" +
    "3️⃣ Nabii Ibraahiim (AS)\n\n" +
    "0️⃣ Menu jalqabaatti deebi'i"
  );
}

function sahabaMenu() {
  return (
    "🌟 *SEENAA SAHABOOTAA*\n\n" +
    SAHABAS.map((person, index) =>
      `${index + 1}️⃣ ${person.name}`
    ).join("\n") +
    "\n\n0️⃣ Menu jalqabaatti deebi'i"
  );
}

function storyPartsMenu(person) {
  return (
    `📚 *${person.name}*\n\n` +
    person.parts.map((part, index) =>
      `${index + 1}️⃣ ${part.title}`
    ).join("\n") +
    "\n\n0️⃣ Menu jalqabaatti deebi'i"
  );
}

/* =========================================
   MESSAGE HANDLER
========================================= */

function getText(message) {
  const content = message.message;
  if (!content) return "";

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

  return "";
}

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

  const text = getText(message).trim();
  if (!text) return;

  messageCount++;

  const input = text.toLowerCase();
  let state = userMenus.get(jid) || { page: "main" };
  let reply = "";

  const greetings = [
    "hi",
    "hello",
    "salaam",
    "salam",
    "akkam",
    "menu",
    "jalqaba",
    "السلام عليكم",
    "assalaamu alaykum",
    "assalamu alaikum"
  ];

  if (greetings.includes(input)) {
    state = { page: "main" };
    reply = mainMenu();
  } else if (text === "0") {
    state = { page: "main" };
    reply = mainMenu();
  } else if (
    state.page === "main" &&
    text === "1"
  ) {
    state = { page: "muhammad" };
    reply = muhammadMenu();
  } else if (
    state.page === "main" &&
    text === "2"
  ) {
    state = { page: "prophets" };
    reply = prophetMenu();
  } else if (
    state.page === "main" &&
    text === "3"
  ) {
    state = { page: "sahaba" };
    reply = sahabaMenu();
  } else if (
    state.page === "muhammad" &&
    /^[1-9]$/.test(text) &&
    MUHAMMAD_STORY[Number(text) - 1]
  ) {
    const part = MUHAMMAD_STORY[Number(text) - 1];

    state = { page: "muhammad" };

    reply =
      `📖 *${part.title}*\n\n` +
      `${part.text}\n\n` +
      "Lakkoofsa biraa seenaa itti aanuuf filadhu.\n" +
      "0️⃣ Menu jalqabaatti deebi'i";
  } else if (
    state.page === "prophets" &&
    ["1", "2", "3"].includes(text)
  ) {
    const key = {
      "1": "aadam",
      "2": "nuuh",
      "3": "ibraahim"
    }[text];

    const person = OTHER_PROPHETS[key];

    state = {
      page: "otherProphet",
      person: key
    };

    reply = storyPartsMenu(person);
  } else if (
    state.page === "otherProphet" &&
    OTHER_PROPHETS[state.person] &&
    /^[1-2]$/.test(text)
  ) {
    const person = OTHER_PROPHETS[state.person];
    const part = person.parts[Number(text) - 1];

    if (part) {
      reply =
        `📖 *${person.name} — ${part.title}*\n\n` +
        `${part.text}\n\n` +
        storyPartsMenu(person);
    } else {
      reply = storyPartsMenu(person);
    }
  } else if (
    state.page === "sahaba" &&
    /^[1-9]$/.test(text) &&
    SAHABAS[Number(text) - 1]
  ) {
    const index = Number(text) - 1;
    const person = SAHABAS[index];

    state = {
      page: "sahabaStory",
      personIndex: index
    };

    reply = storyPartsMenu(person);
  } else if (
    state.page === "sahabaStory" &&
    Number.isInteger(Number(text)) &&
    Number(text) >= 1 &&
    Number(text) <= 2
  ) {
    const person = SAHABAS[state.personIndex];

    if (person) {
      const part = person.parts[Number(text) - 1];

      reply =
        `🌟 *${person.name}*\n` +
        `*${part.title}*\n\n` +
        `${part.text}\n\n` +
        storyPartsMenu(person);
    } else {
      state = { page: "main" };
      reply = mainMenu();
    }
  } else {
    reply =
      "Filannoon kee sirrii miti.\n\n" +
      "Lakkoofsa menu irratti argamu keessaa filadhu.\n" +
      "0️⃣ Menu jalqabaatti deebi'i.";
  }

  userMenus.set(jid, state);

  if (!sock || !connected) {
    console.log("WhatsApp hin walqabanne; deebiin hin ergamne.");
    return;
  }

  await sock.sendMessage(jid, { text: reply });
}

/* =========================================
   WHATSAPP CONNECTION
========================================= */

function scheduleReconnect() {
  if (stopping || reconnectTimer) return;

  const delay = reconnectDelay;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;

    startWhatsApp().catch((error) => {
      lastError = error.message;
      console.error("Reconnect error:", error.message);
    });
  }, delay);

  reconnectDelay = Math.min(reconnectDelay * 2, 60000);

  console.log(
    `WhatsApp sekondii ${delay / 1000} booda irra deebi'a.`
  );
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
        console.error("Session kuusuu hin dandeenye:", error.message);
      }
    });

    socket.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      lastConnectionUpdate = new Date().toISOString();

      if (qr) {
        try {
          currentQR = await QRCode.toDataURL(qr);
          connected = false;
          console.log("QR Code qophaa'e.");
        } catch (error) {
          lastError = error.message;
          console.error("QR Code error:", error.message);
        }
      }

      if (connection === "open") {
        connected = true;
        currentQR = null;
        reconnectDelay = 5000;
        lastError = null;
        lastDisconnectCode = null;

        console.log("WhatsApp milkaa'inaan walqabate.");
      }

      if (connection === "close") {
        connected = false;
        currentQR = null;

        if (sock === socket) sock = null;

        const statusCode =
          lastDisconnect?.error?.output?.statusCode ??
          lastDisconnect?.error?.statusCode ??
          null;

        lastDisconnectCode = statusCode;
        lastError =
          lastDisconnect?.error?.message ||
          "WhatsApp connection cufame.";

        console.error(
          "WhatsApp connection close details:",
          JSON.stringify({
            statusCode,
            errorMessage: lastError,
            errorName: lastDisconnect?.error?.name
          })
        );

        if (statusCode === DisconnectReason.loggedOut) {
          lastError =
            "WhatsApp logout ta'e. QR Code haaraa scan godhi.";
          console.error(lastError);
          return;
        }

        if (!stopping) scheduleReconnect();
      }
    });

    socket.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const message of messages) {
        try {
          await handleIncomingMessage(message);
        } catch (error) {
          lastError = error.message;
          console.error("Message error:", error.message);
        }
      }
    });
  } catch (error) {
    lastError = error.message;

    console.error(
      "WhatsApp start error:",
      error.stack || error.message
    );

    if (!stopping) scheduleReconnect();
  } finally {
    starting = false;
  }
}

/* =========================================
   WEBSITE
========================================= */

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
body{font-family:Arial,sans-serif;background:#f0f7f2;margin:0;padding:18px;color:#173b29}
.card{max-width:520px;margin:25px auto;background:white;padding:24px;border-radius:16px;box-shadow:0 4px 20px #0001;text-align:center}
h1{color:#087443}
button{background:#087443;color:white;border:0;padding:12px 18px;border-radius:8px;font-size:16px;cursor:pointer}
#qr{max-width:280px;width:100%;margin:15px auto;display:block}
.status{padding:12px;background:#eef7ef;border-radius:8px;overflow-wrap:anywhere;line-height:1.8}
.warning{padding:12px;border-radius:8px;background:#fff3cd;color:#674d03;font-size:13px;line-height:1.6}
</style>
</head>
<body>
<div class="card">
<h1>🌿 Hidaayatul-Bayaan</h1>
<p>WhatsApp Barnoota Islaamaa</p>
<div class="status" id="status">Status ilaalaa jira...</div>
<div id="qrbox"><p>QR Code qopheessaa jira...</p></div>
<button onclick="refreshStatus()">Haaromsi</button>
<p class="warning">QR Code kana nama biraatti hin qoodin. WhatsApp kee waliin walqabsiisuuf qofa fayyadami.</p>
<p>📚 Barnoonni ifsaadha!</p>
</div>
<script>
async function refreshStatus(){
 try{
  const r=await fetch('/api/status',{cache:'no-store'});
  const d=await r.json();

  document.getElementById('status').innerHTML=
   'WhatsApp: <b>'+(d.connected?'Walqabateera ✅':'Hin walqabanne')+'</b><br>'+
   'Database: '+(d.database?'Hojjechaa jira ✅':'Rakkoo qaba ❌')+
   (d.lastError?'<br>Dogoggora: '+String(d.lastError).replace(/[&<>"]/g,''):'') ;

  const qrResponse=await fetch('/api/whatsapp/qr',{cache:'no-store'});
  const q=await qrResponse.json();
  const box=document.getElementById('qrbox');

  if(d.connected){
   box.innerHTML='<h3>WhatsApp walqabateera! ✅</h3>';
  }else if(q.qr){
   box.innerHTML='<h3>📱 QR Code WhatsApp</h3><p>WhatsApp kee irraa scan godhi.</p>';
   const img=document.createElement('img');
   img.id='qr';
   img.alt='WhatsApp QR Code';
   img.src=q.qr;
   box.appendChild(img);
  }else{
   box.innerHTML='<p>QR Code qophaa’aa jira. Muraasa booda haaromsi.</p>';
  }
 }catch(e){
  document.getElementById('status').textContent='Server bira ga’uu hin dandeenye.';
 }
}
refreshStatus();
setInterval(refreshStatus,5000);
</script>
</body>
</html>`);
});

/* =========================================
   HEALTH AND STATUS
========================================= */

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      app: "Hidaayatul-Bayaan",
      database: true,
      connected
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      app: "Hidaayatul-Bayaan",
      database: false
    });
  }
});

app.get("/api/status", async (req, res) => {
  let database = false;

  try {
    await pool.query("SELECT 1");
    database = true;
  } catch (_) {}

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

app.get("/api/whatsapp/qr", (req, res) => {
  res.set("Cache-Control", "no-store");

  res.json({
    connected,
    qr: connected ? null : currentQR
  });
});

/* =========================================
   SHUTDOWN
========================================= */

async function shutdown() {
  if (stopping) return;

  stopping = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    if (sock) sock.end(undefined);
  } catch (_) {}

  server.close();

  try {
    await pool.end();
  } catch (_) {}

  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

/* =========================================
   START SERVER
========================================= */

async function main() {
  await initializeDatabase();

  await new Promise((resolve, reject) => {
    server.once("error", reject);

    server.listen(PORT, "0.0.0.0", () => {
      server.removeListener("error", reject);

      console.log(
        `Hidaayatul-Bayaan port ${PORT} irratti hojjachaa jira.`
      );

      resolve();
    });
  });

  startWhatsApp().catch((error) => {
    lastError = error.message;
    console.error("WhatsApp initialization error:", error.message);
  });
}

main().catch((error) => {
  console.error(
    "Server initialization failed:",
    error.stack || error.message
  );
  process.exit(1);
});
