const express = require("express");
const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const AUTH_DIR =
  process.env.AUTH_DIR || "/tmp/hidaayatul-bayaan-auth";

let sock;
let isWhatsAppConnected = false;

const sessions = new Map();

// ==========================================
// SEENAA NABIYYII MUHAMMAD (SAW)
// ==========================================

const SEENAA_NABIYYII = [
  {
    maqaa: "1. Dhaloota Nabiyyii Muhammad (SAW)",
    seenaa: `Nabiyyiin Muhammad (SAW) Makkaa keessatti, bara Filaa jedhamuun beekamu keessatti dhalatan. Abbaan isaanii Abdullaah, haati isaanii Aaminaa jedhamu.

Abbaan isaanii osoo isaan hin dhalatin du'an. Nabiyyiin (SAW) ijoollummaa isaanii keessatti rakkina hedduu keessa darbaniiru.

Jalqaba Haalimaa Sa'diyyaa bira guddatani. Sana booda haadha isaanii waliin jiraatan. Haati isaanii yeroo isaan ijoollee ta'an duute; akkasumas akaakayyuu isaanii Abd al-Muxxalib, achiis abbeeraan isaanii Abu Xaalib isaan kunuunsan.

Barnoota:
1. Yatimni kunuunsa fi rahmata barbaada.
2. Rakkina keessatti obsa qabaachuun barbaachisaa dha.
3. Ijoollee fi namoota dadhaboo gargaaruu qabna.`
  },
  {
    maqaa: "2. Dargaggummaa fi Amanamummaa",
    seenaa: `Nabiyyiin Muhammad (SAW) dargaggummaa isaanii keessatti amanamummaa fi dhugaa dubbachuun beekamu turan.

Ummanni Makkaa isaan "Al-Amiin" jechuun waama ture; hiikni isaa nama amanamaa jechuudha.

Daldala keessatti amanamoo turan. Namoota hin gowwoomsan; waadaa isaanii ni eegu turan.

Barnoota:
1. Dhugaa dubbachuu qabna.
2. Amanamoo ta'uu qabna.
3. Daldala keessatti gowwoomsuu irraa fagaachuu qabna.`
  },
  {
    maqaa: "3. Fuudha Khadiijaa (RA)",
    seenaa: `Nabiyyiin Muhammad (SAW) Khadiijaa bint Khuwaylid (RA) waliin fuudhan.

Khadiijaan dubartii kabajamtuu, daldaltuu fi amala gaarii qabdu turte.

Yeroo wahyiin jalqaba bu'e, Khadiijaan Nabiyyii (SAW) jajjabeessite; isa amantee deeggarsa guddaa gooteef.

Khadiijaan dubartoota Islaama fudhatan jalqabaa keessaa turte.

Barnoota:
1. Haadha manaa fi maatii keenya kabajuu qabna.
2. Nama rakkate jajjabeessuu qabna.
3. Haqa irratti dhaabbachuu qabna.`
  },
  {
    maqaa: "4. Wahyii Jalqabaa",
    seenaa: `Nabiyyiin Muhammad (SAW) yeroo umriin isaanii waggaa 40 ta'u, holqa Hiraa keessatti yeroo ibaadaa keessa turan, Jibriil (AS) isaanitti dhufe.

Jibriil (AS) ajaja Rabbiitiin wahyii jalqabaa, aayata Suuratul-Alaq keessaa, isaanitti dubbise.

Nabiyyiin (SAW) gara mana isaanii deebi'an. Khadiijaan isaan jajjabeessite; booda warra beekumsa qaban bira geessite.

Ergasii Muhammad (SAW) ergamaa Rabbiitiin ta'anii namoota gara tawhiidaatti waamuu jalqaban.

Barnoota:
1. Beekumsa barachuu barbaachisaa dha.
2. Nama sodaatu jajjabeessuu qabna.
3. Rabbiin nama filate karaa Isaa irratti qajeelcha.`
  },
  {
    maqaa: "5. Da'awaa Dhoksaa",
    seenaa: `Nabiyyiin Muhammad (SAW) jalqaba namoota muraasa gara Islaamaatti waaman.

Khadiijaa (RA), Abu Bakr (RA), Alii (RA) fi namoonni biroon Islaama fudhatan.

Muslimoonni jalqabaa amantii isaanii barachuu fi ibaadaa raawwachuu irratti jabaatan.

Barnoota:
1. Hojii gaarii beekumsa irratti hundeessuu qabna.
2. Hiriyoota gaarii filachuu qabna.
3. Amantii keenya barachuu qabna.`
  },
  {
    maqaa: "6. Da'awaa Ifaatti",
    seenaa: `Rabbiin Nabiyyii Muhammad (SAW) ummata isaanii ifatti waamu ajaje.

Nabiyyiin (SAW) tawhiida barsiisan; sanamoota gabbaruu irraa namoota akeekkachiisan.

Qureeyshonni hedduun isaan morman; Muslimoota tokko tokko miidhan.

Nabiyyiin (SAW) waamicha isaanii itti fufan.

Barnoota:
1. Dhugaa barsiisuun obsa barbaada.
2. Nama miidhuu hin qabnu.
3. Waan gaarii irratti obsaan dhaabbachuu qabna.`
  },
  {
    maqaa: "7. Rakkina Muslimoota Jalqabaa",
    seenaa: `Muslimoonni jalqabaa Makkaa keessatti rakkina guddaa keessa darban.

Bilaal Ibn Rabaah (RA) amantii isaa irraa akka deebi'uuf miidhaan irra ga'e; garuu inni amantii isaa irratti jabaatee dhaabbate.

Sahaboonni biroonis rakkoo fi miidhaa obsan.

Nabiyyiin (SAW) Muslimoota jajjabeessan.

Barnoota:
1. Amantii irratti jabaachuu qabna.
2. Nama miidhuu fi cunqursuu hin qabnu.
3. Namoota rakkatan gargaaruu qabna.`
  },
  {
    maqaa: "8. Hijraa gara Habashaa",
    seenaa: `Muslimoonni tokko tokko miidhaa Makkaa keessatti isaan irra ga'u irraa baraaramuuf gara Habashaa godaanan.

Mootiin Habashaa Najjaashii jedhamu haqa irratti murteessuun beekama ture.

Muslimoonni isa bira nagaa argatan.

Barnoota:
1. Haqaaf dhaabbachuu qabna.
2. Namoota amantii isaanii kabajan kabajuu qabna.
3. Namoota rakkatanitti rahmata gochuu qabna.`
  },
  {
    maqaa: "9. Waggaa Gaddaa",
    seenaa: `Yeroo Makkaa keessatti rakkina cimaa keessa turan, Khadiijaan (RA) fi abbeeraan isaanii Abu Xaalib du'an.

Waggaan kun gadda guddaa waan fideef "Waggaa Gaddaa" jedhamee beekama.

Nabiyyiin (SAW) rakkina kana keessatti obsa qabaatan; da'awaa isaanii itti fufan.

Barnoota:
1. Yeroo gaddaa Rabbiitti hirkachuu qabna.
2. Nama jaallannu du'aan dhabuu keessatti obsa barbaachisa.
3. Hojii gaarii itti fufuu qabna.`
  },
  {
    maqaa: "10. Hijraa gara Madiinaa",
    seenaa: `Nabiyyiin Muhammad (SAW) ajaja Rabbiitiin Makkaa irraa gara Madiinaa godaanan.

Abu Bakr (RA) isaanii waliin ture.

Muslimoonni Madiinaa keessatti Nabiyyii (SAW) simatan; hawaasni Muslimootaa jabaachuu jalqabe.

Hijraan seenaa Islaamaa keessatti jijjiirama guddaa fide.

Barnoota:
1. Obsa fi karoora qabaachuun barbaachisaa dha.
2. Obboleeyyan Muslimootaa wal gargaaruu qabu.
3. Rabbiitti hirkachuun barbaachisaa dha.`
  },
  {
    maqaa: "11. Masjiida Nabawii Ijaaruu",
    seenaa: `Nabiyyiin (SAW) Madiinaa erga ga'anii booda masjiida ijaaruu keessatti hirmaatan.

Masjiidni Nabawii bakka salaataa, barnootaa fi walga'ii Muslimootaa ta'e.

Nabiyyiin (SAW) Sahaboota waliin hojjechuu fi wal gargaaruu barsiisan.

Barnoota:
1. Masjiida kabajuu qabna.
2. Hojii gaarii keessatti hirmaachuu qabna.
3. Wal gargaaruun hawaasa jabeessa.`
  },
  {
    maqaa: "12. Obbolummaa Muhajiriinaa fi Ansaar",
    seenaa: `Nabiyyiin (SAW) Muslimoota Makkaa irraa godaanan (Muhajiriin) fi Muslimoota Madiinaa (Ansaar) gidduutti obbolummaa cimsan.

Ansaaronni obboloota isaanii godaanan gargaaran; mana, nyaata fi deeggarsa kennaniif.

Kun obbolummaa fi arjummaa Islaamaa keessatti fakkeenya guddaa ta'e.

Barnoota:
1. Hiyyeeyyii fi godaantota gargaaruu qabna.
2. Obbolummaa Muslimootaa kabajuu qabna.
3. Qabeenya qooduun hojii gaarii dha.`
  },
  {
    maqaa: "13. Gahuumsa Badr",
    seenaa: `Bara 2 Hijraa keessa lola Badr ta'e.

Muslimoonni lakkoofsaan muraasa turan; garuu Rabbiin isaan gargaare.

Seenaa kana keessatti Muslimoonni obsa, tokkummaa fi ajajamuu baratan.

Barnoota:
1. Rabbiitti hirkachuu qabna.
2. Tokkummaa eeguu qabna.
3. Ajaja sirrii hordofuu qabna.`
  },
  {
    maqaa: "14. Gahuumsa Uhud",
    seenaa: `Lolli Uhud bara 3 Hijraa keessa ta'e.

Muslimoonni qormaata guddaa keessa darban. Nabiyyiin (SAW) ummata isaanii barsiisan akka ajaja hoggansa isaanii hordofan.

Seenaa Uhud keessatti ajajamuu, obsa fi dogoggora irraa barachuun barbaachisaa ta'uu hubanna.

Barnoota:
1. Ajaja sirrii hordofuu qabna.
2. Dogoggora irraa barachuu qabna.
3. Yeroo rakkinaatti obsa qabaachuu qabna.`
  },
  {
    maqaa: "15. Sulhii Hudaibiyyah",
    seenaa: `Nabiyyiin (SAW) fi Sahaboonni isaanii Umraa raawwachuuf ka'an; garuu Hudaibiyyah keessatti waliigalteen uumame.

Waliigalteen sun yeroo jalqabaatti namoota tokko tokkoof ulfaataa fakkaatus, booda Islaamni babal'achuuf karaa bane.

Barnoota:
1. Nagaa barbaaduun barbaachisaa dha.
2. Murtii keessatti obsa qabaachuu qabna.
3. Waliigaltee eeguu qabna.`
  },
  {
    maqaa: "16. Fathii Makkaa",
    seenaa: `Bara 8 Hijraa keessatti Muslimoonni Makkaa seenuun injifannoo guddaa argatan.

Nabiyyiin (SAW) yeroo humna argatan, namoota hedduuf dhiifama godhan.

Isaan sanamoota Ka'baa keessaa balleessanii Ka'baa ibaadaa Rabbiitiif qulqulleessan.

Barnoota:
1. Dhiifama gochuun amala gaarii dha.
2. Yeroo humna qabnu nama hin cunqursin.
3. Rabbiin qofa gabbaruu qabna.`
  },
  {
    maqaa: "17. Hajjii Dhaamu fi Khuxbaa",
    seenaa: `Nabiyyiin Muhammad (SAW) Hajjii isaanii dhumaa keessatti Muslimoota barsiisan.

Khuxbaa isaanii keessatti dhiiga, qabeenyaa fi kabaja namootaa eeguun; haqaan jiraachuun; dirqama amantii raawwachuun barbaachisaa ta'uu yaadachiisan.

Barnoota:
1. Qabeenyaa fi lubbuu namaa kabajuu qabna.
2. Haqa irratti dhaabbachuu qabna.
3. Muslimoonni obboloota.
4. Amantii fi naamusa gaarii eeguu qabna.`
  },
  {
    maqaa: "18. Du'a Nabiyyii Muhammad (SAW)",
    seenaa: `Nabiyyiin Muhammad (SAW) Madiinaa keessatti bara 11 Hijraa du'an. Umriin isaanii gara waggaa 63 ture.

Duuti isaanii Sahaboota gaddisiise. Abu Bakr (RA) Muslimoota yaadachiise akka Muhammad (SAW) ergamaa Rabbiitiin ta'an; Rabbiin garuu jiraataa hin duune ta'uu.

Nabiyyiin (SAW) Qur'aana fi Sunnah ummataaf dhiisanii darbaniiru.

Barnoota:
1. Nabiyyii (SAW) jaallachuu fi Sunnah isaa hordofuu qabna.
2. Qur'aana barachuu qabna.
3. Duuti nama hundaaf dhufa; hojii gaarii qopheeffachuu qabna.`
  }
];

// ==========================================
// SEENAA SAHABOOTAA
// ==========================================

const SEENAA_SAHABOOTAA = [
  {
    maqaa: "1. Abu Bakr As-Siddiiq (RA)",
    seenaa: `Abu Bakr (RA) hiriyyaa dhihoo Nabiyyii Muhammad (SAW) ture.

Inni namoota jalqaba Islaama fudhatan keessaa tokko ture. Hijraa gara Madiinaa keessatti Nabiyyii (SAW) waliin godaane.

Nabiyyii (SAW) booda khaliifaa jalqabaa Muslimootaa ta'e. Yeroo namoonni tokko tokko rakkina keessa seenan, inni Muslimoota tokkummaa irratti jabeesse.

Barnoota:
1. Amanamummaa qabaachuu qabna.
2. Hiriyyaa gaarii ta'uu qabna.
3. Hojii gaarii keessatti jabaachuu qabna.`
  },
  {
    maqaa: "2. Umar Ibn Al-Khaxxaab (RA)",
    seenaa: `Umar (RA) khaliifaa lammaffaa Muslimootaa ture.

Islaama fudhachuu isaa booda Muslimoonni jajjabina argatan. Inni haqaan bulchuu fi dadhaboo gargaaruu keessatti beekama.

Barnoota:
1. Haqaaf dhaabbachuu qabna.
2. Namoota walqixa ilaaluu qabna.
3. Dadhaboo fi hiyyeeyyii gargaaruu qabna.`
  },
  {
    maqaa: "3. Usmaan Ibn Affaan (RA)",
    seenaa: `Usmaan (RA) khaliifaa sadaffaa Muslimootaa ture.

Inni arjummaa fi naamusa gaariin beekama. Qur'aana Muslimootaaf akka qaraatii irratti tokkummaa qabaatuuf hojii guddaa hojjete.

Barnoota:
1. Arjaa ta'uu qabna.
2. Qur'aana barachuu qabna.
3. Qabeenya keenya hojii gaariif oolchuu qabna.`
  },
  {
    maqaa: "4. Alii Ibn Abii Xaalib (RA)",
    seenaa: `Alii (RA) ilma adeeraa Nabiyyii Muhammad (SAW) fi abbaa manaa Faaximaa (RA) ture.

Inni ijoollummaa irraa Islaama fudhate. Beekumsa, gootummaa fi haqaan dhaabbachuu keessatti beekama.

Aliin khaliifaa afraffaa Muslimootaa ta'e.

Barnoota:
1. Beekumsa barachuu qabna.
2. Haqaaf dhaabbachuu qabna.
3. Amala gaarii qabaachuu qabna.`
  },
  {
    maqaa: "5. Khadiijaa Bint Khuwaylid (RA)",
    seenaa: `Khadiijaa (RA) haadha manaa jalqabaa Nabiyyii Muhammad (SAW) turte.

Yeroo wahyiin jalqaba bu'e, Nabiyyii (SAW) amantee jajjabeessite. Qabeenya fi deeggarsa isheetiin Islaamaaf gumaacha guddaa goote.

Barnoota:
1. Nama rakkate gargaaruu qabna.
2. Nama keenya jajjabeessuu qabna.
3. Amanamummaa qabaachuu qabna.`
  },
  {
    maqaa: "6. A'ishaa Bint Abii Bakr (RA)",
    seenaa: `A'ishaa (RA) haadha mu'mintootaa fi haadha manaa Nabiyyii (SAW) turte.

Beekumsa Islaamaa fi hadiisaa dabarsuu keessatti gahee guddaa qabdi. Muslimoonni hedduun beekumsa ishee irraa baratan.

Barnoota:
1. Beekumsa barachuu qabna.
2. Beekumsa sirriitti dabarsuu qabna.
3. Barumsa amantii irratti jabaachuu qabna.`
  },
  {
    maqaa: "7. Bilaal Ibn Rabaah (RA)",
    seenaa: `Bilaal (RA) Sahabii Islaamaaf rakkina guddaa obse ture.

Yeroo Makkaa keessatti miidhaa irra ga'us amantii isaa irraa hin deebi'in. Inni mu'azzina Nabiyyii (SAW) ta'uun beekama.

Barnoota:
1. Amantii irratti jabaachuu qabna.
2. Namoota halluu fi dhalootaan tuffachuu hin qabnu.
3. Nama miidhametti rahmata gochuu qabna.`
  },
  {
    maqaa: "8. Mus'ab Ibn Umayr (RA)",
    seenaa: `Mus'ab (RA) dargaggeessa Makkaa keessatti jiraataa ture. Islaama fudhatee booda rakkina obse.

Nabiyyiin (SAW) isa gara Madiinaa ergan, akka namoota Islaama barsiisuuf. Inni da'awaa keessatti gahee guddaa qabaate.

Barnoota:
1. Beekumsa barachuu qabna.
2. Beekumsa namootaaf dabarsuu qabna.
3. Hojii gaarii keessatti obsa qabaachuu qabna.`
  },
  {
    maqaa: "9. Abu Hurayrah (RA)",
    seenaa: `Abu Hurayrah (RA) Sahaboota hadiisaa baay'ee dabarsan keessaa tokko ture.

Inni Nabiyyii (SAW) irraa barachuu fi hadiisa ummataaf dabarsuu irratti xiyyeeffate.

Barnoota:
1. Hadiisa sirriitti barachuu qabna.
2. Beekumsa amanamummaadhaan dabarsuu qabna.
3. Barumsa itti fufuu qabna.`
  },
  {
    maqaa: "10. Salman Al-Faarisii (RA)",
    seenaa: `Salman Al-Faarisii (RA) dhugaa barbaaduuf imala dheeraa taasise.

Dhuma irratti Nabiyyii Muhammad (SAW) argatee Islaama fudhate. Yaada isaa keessatti Muslimoota gargaaruun beekama.

Barnoota:
1. Dhugaa barbaaduu hin dhiisin.
2. Beekumsa barachuu itti fufi.
3. Namoota kabajuu qabna.`
  },
  {
    maqaa: "11. Abdur-Rahmaan Ibn Awf (RA)",
    seenaa: `Abdur-Rahmaan Ibn Awf (RA) Sahabii daldalaa fi arjaa ture.

Qabeenya isaa keessaa hedduu hojii gaarii fi Muslimoota gargaaruuf oolche.

Barnoota:
1. Daldala keessatti amanamoo ta'uu qabna.
2. Hiyyeeyyii gargaaruu qabna.
3. Arjummaa qabaachuu qabna.`
  },
  {
    maqaa: "12. Abu Ubaydah Ibn Al-Jarraah (RA)",
    seenaa: `Abu Ubaydah (RA) Sahabii amanamaa ture. Nabiyyii Muhammad (SAW) biratti amanamummaa qabaachuun beekama.

Barnoota:
1. Amanamummaa qabaachuu qabna.
2. Waadaa eeguu qabna.
3. Hojii itti gaafatamummaa qabu sirriitti raawwachuu qabna.`
  },
  {
    maqaa: "13. Talhaa Ibn Ubaydillaah (RA)",
    seenaa: `Talhaa (RA) Sahaboota beekamoo keessaa tokko ture. Nabiyyii (SAW) deeggaruu fi Islaamaaf dhaabbachuu keessatti gahee qaba.

Barnoota:
1. Nama gaarii gargaaruu qabna.
2. Amanamummaa qabaachuu qabna.
3. Hojii gaarii keessatti hirmaachuu qabna.`
  },
  {
    maqaa: "14. Zubayr Ibn Al-Awwaam (RA)",
    seenaa: `Zubayr (RA) Sahabii Nabiyyii Muhammad (SAW) deeggaru keessaa tokko ture. Islaama keessatti gootummaa fi amanamummaa qabaachuun beekama.

Barnoota:
1. Amanamummaa qabaachuu qabna.
2. Dhugaa irratti jabaachuu qabna.
3. Hiriyoota gaarii ta'uu qabna.`
  },
  {
    maqaa: "15. Sa'd Ibn Abii Waqqaas (RA)",
    seenaa: `Sa'd Ibn Abii Waqqaas (RA) Sahabii beekamaa fi namoota Islaama jalqaba fudhatan keessaa tokko ture.

Inni Muslimoota jalqabaa keessaa ta'uun, Islaamaaf gumaacha guddaa qaba.

Barnoota:
1. Amantii keenyaaf amanamoo ta'uu qabna.
2. Hojii gaarii keessatti jabaachuu qabna.`
  },
  {
    maqaa: "16. Khaalid Ibn Al-Waliid (RA)",
    seenaa: `Khaalid Ibn Al-Waliid (RA) hogganaa waraanaa beekamaa ture. Islaama erga fudhatee booda Muslimoota waliin hirmaate.

Inni ogummaa hoggansaa fi murannoo qabaachuun beekama.

Barnoota:
1. Ogummaa gaariitti fayyadamuu qabna.
2. Hojii keessatti murannoo qabaachuu qabna.
3. Hoggansi itti gaafatamummaa dha.`
  },
  {
    maqaa: "17. Ja'far Ibn Abii Xaalib (RA)",
    seenaa: `Ja'far (RA) obboleessa Alii (RA) ture. Hijraa gara Habashaa keessatti Muslimoota bakka bu'ee mootii Najjaashii duratti dubbate.

Inni amantii Muslimootaa kabajaa fi ifa ta'een ibse.

Barnoota:
1. Dhugaa ibsuu qabna.
2. Amantii keenya beekuu qabna.
3. Haqaaf dhaabbachuu qabna.`
  },
  {
    maqaa: "18. Anas Ibn Maalik (RA)",
    seenaa: `Anas Ibn Maalik (RA) yeroo ijoollee ture Nabiyyii (SAW) tajaajile. Inni Nabiyyii irraa hadiisaa fi amala isaanii barate.

Barnoota:
1. Nama gaarii irraa barachuu qabna.
2. Hadiisa amanamummaadhaan dabarsuu qabna.
3. Ijoollee beekumsa baratan jajjabeessuu qabna.`
  },
  {
    maqaa: "19. Abu Dharr Al-Ghifaarii (RA)",
    seenaa: `Abu Dharr (RA) Sahabii dhugaa dubbachuu fi jireenya salphaa jaallachuun beekama ture.

Barnoota:
1. Dhugaa dubbachuu qabna.
2. Qabeenyaaf qofa jiraachuu hin qabnu.
3. Hiyyeeyyii gargaaruu qabna.`
  },
  {
    maqaa: "20. Ummu Salamaa (RA)",
    seenaa: `Ummu Salamaa (RA) haadha mu'mintootaa fi haadha manaa Nabiyyii (SAW) turte.

Isheen ogummaa, obsa fi gorsa gaarii qabaachuun beekamti.

Barnoota:
1. Gorsa gaarii fudhachuu qabna.
2. Obsa qabaachuu qabna.
3. Dubartoota beekumsa qaban kabajuu qabna.`
  }
];

// ==========================================
// MENU
// ==========================================

function mainMenu() {
  return `🕌 *HIDAAYATUL-BAYAAN*

Assalaamu alaykum wa rahmatullaahi wa barakaatuh.

📚 *Kutaa Barnoota Seenaa*

1️⃣ Seenaa Nabiyyii Muhammad (SAW)
2️⃣ Seenaa Sahaboota

Lakkoofsa filannoo kee ergi.

0️⃣ Menu jalqabaatti deebi'i`;
}

function makeList(list, title) {
  let out = `📚 *${title}*\n\n`;

  list.forEach((item, index) => {
    out += `${index + 1}. ${item.maqaa}\n`;
  });

  out += `\nLakkoofsa seenaa dubbisuu barbaaddu ergi.\n`;
  out += `0️⃣ Gara menu jalqabaatti deebi'i`;

  return out;
}

function getStoryList(type) {
  if (type === "prophet") return SEENAA_NABIYYII;
  if (type === "sahaba") return SEENAA_SAHABOOTAA;
  return [];
}

async function sendMessage(jid, text) {
  if (!sock || !isWhatsAppConnected) {
    console.log("WhatsApp hin hidhamne; ergaan hin ergamne.");
    return;
  }

  await sock.sendMessage(jid, { text });
}

// ==========================================
// WHATSAPP MESSAGE HANDLER
// ==========================================

async function handleMessage(message) {
  if (!message.message || message.key.fromMe) return;

  const jid = message.key.remoteJid;
  if (!jid || jid.endsWith("@g.us")) return;

  const msg =
    message.message.conversation ||
    message.message.extendedTextMessage?.text ||
    message.message.buttonsResponseMessage?.selectedButtonId ||
    message.message.listResponseMessage?.singleSelectReply?.selectedRowId ||
    "";

  const text = String(msg).trim();

  if (!text) return;

  const lower = text.toLowerCase();
  let session = sessions.get(jid);

  console.log("WhatsApp message:", jid, text);

  // Gara menu jalqabaa deebi'i
  if (text === "0" || lower === "menu" || lower === "jalqaba") {
    sessions.delete(jid);
    await sendMessage(jid, mainMenu());
    return;
  }

  // Yoo seenaa keessaa filachaa jiraate
  if (session && (session.type === "prophet" || session.type === "sahaba")) {
    const list = getStoryList(session.type);

    if (lower === "back" || lower === "b") {
      await sendMessage(jid, mainMenu());
      sessions.delete(jid);
      return;
    }

    const index = Number(text) - 1;

    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= list.length
    ) {
      await sendMessage(
        jid,
        `❌ Lakkoofsa sirrii miti.\n\n${makeList(
          list,
          session.type === "prophet"
            ? "SEENAA NABIYYII MUHAMMAD (SAW)"
            : "SEENAA SAHABOOTAA"
        )}`
      );
      return;
    }

    const story = list[index];

    await sendMessage(
      jid,
      `📖 *${story.maqaa}*\n\n${story.seenaa}\n\n` +
      `━━━━━━━━━━━━━━\n` +
      `Seenaa biraa dubbisuuf lakkoofsa isaa ergi.\n` +
      `0️⃣ Gara menu jalqabaatti deebi'i`
    );
    return;
  }

  // Filannoo menu jalqabaa
  if (text === "1") {
    sessions.set(jid, { type: "prophet" });

    await sendMessage(
      jid,
      makeList(SEENAA_NABIYYII, "SEENAA NABIYYII MUHAMMAD (SAW)")
    );
    return;
  }

  if (text === "2") {
    sessions.set(jid, { type: "sahaba" });

    await sendMessage(
      jid,
      makeList(SEENAA_SAHABOOTAA, "SEENAA SAHABOOTAA")
    );
    return;
  }

  // Jecha menu erguun menu argachuu
  if (
    ["hi", "hello", "salaam", "assalaamu alaykum", "start", "menu"].includes(
      lower
    )
  ) {
    await sendMessage(jid, mainMenu());
    return;
  }

  await sendMessage(
    jid,
    `Assalaamu alaykum!\n\n${mainMenu()}`
  );
}

// ==========================================
// START WHATSAPP
// ==========================================

async function startWhatsApp() {
  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      browser: ["Hidaayatul-Bayaan", "Chrome", "1.0.0"],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 20000
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("==================================");
        console.log("WHATSAPP QR CODE:");
        console.log(qr);
        console.log("==================================");
        console.log(
          "QR code kana terminal irraa scan godhi. Yoo Render fayyadamte, QR kana argachuuf QR display endpoint dabalataa barbaachisuu danda'a."
        );
      }

      if (connection === "open") {
        isWhatsAppConnected = true;
        console.log("WhatsApp connected successfully!");
      }

      if (connection === "close") {
        isWhatsAppConnected = false;

        const statusCode =
          lastDisconnect?.error?.output?.statusCode;

        const shouldReconnect =
          statusCode !== DisconnectReason.loggedOut;

        console.log("WhatsApp connection closed:", statusCode);

        if (shouldReconnect) {
          setTimeout(startWhatsApp, 5000);
        } else {
          console.log(
            "WhatsApp logout ta'e. Auth state qulqulleessuun QR haaraa scan godhi."
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
          console.error("Message handling error:", error);

          try {
            await sendMessage(
              message.key.remoteJid,
              "Dhiifama, ergaa kee irratti dogoggorri uumame. Maaloo irra deebi'i."
            );
          } catch (sendError) {
            console.error("Error reply failed:", sendError);
          }
        }
      }
    });
  } catch (error) {
    console.error("WhatsApp startup error:", error);
    setTimeout(startWhatsApp, 10000);
  }
}

// ==========================================
// HEALTH CHECK
// ==========================================

app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Hidaayatul-Bayaan</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            text-align: center;
            padding: 40px 15px;
            background: #f0f8f3;
            color: #176b45;
          }
          .card {
            background: white;
            border-radius: 15px;
            padding: 25px;
            max-width: 450px;
            margin: auto;
            box-shadow: 0 3px 15px #0001;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>🕌 Hidaayatul-Bayaan</h1>
          <p>Seenaa Nabiyyii Muhammad (SAW) fi Sahabootaa</p>
          <p>Server: 🟢 Running</p>
          <p>WhatsApp: ${
            isWhatsAppConnected ? "🟢 Connected" : "🟠 Connecting"
          }</p>
        </div>
      </body>
    </html>
  `);
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    app: "Hidaayatul-Bayaan",
    whatsapp: isWhatsAppConnected ? "connected" : "disconnected",
    time: new Date().toISOString()
  });
});

app.get("/api/status", (req, res) => {
  res.json({
    app: "Hidaayatul-Bayaan",
    whatsappConnected: isWhatsAppConnected,
    prophetStories: SEENAA_NABIYYII.length,
    sahabaStories: SEENAA_SAHABOOTAA.length
  });
});

// ==========================================
// START SERVER
// ==========================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Hidaayatul-Bayaan server running on port ${PORT}`);
});

startWhatsApp();
