# dsh-mail-automation

DeepSeek Harness (DSH) प्लगइन: आपके इनबॉक्स को एक मेल ट्रायाज पाइपलाइन बनाता है — IMAP और Microsoft Graph से
पोल करता है, हर नई मेल को लोकल आर्काइव में सहेजता है, उसे एक **सीमित सब-एजेंट** को देता है जो उसे पढ़कर निष्कर्ष
लिखता है, और **शेड्यूल्ड एजेंट टास्क** चलाता है (रोज़ / हफ़्ते / महीने / तय अंतराल / हर बार शुरू होने पर),
हर एक का अपना prompt; QQ भेजना एजेंट खुद करता है।

- स्रोत: IMAP (`imapflow`), POP3 (अंतर्निहित क्लाइंट), Gmail API और Microsoft Graph (OAuth; सेटिंग्स से बाइंड करें)
- प्रति मेल एक आर्काइव फ़ोल्डर: मूल संदेश, HTML, टेक्स्ट, प्रीव्यू इमेज, `conclusion.md`
- प्रति मेल सब-एजेंट, न्यूनतम preset के साथ (shell नहीं, फ़ाइल लेखन नहीं) — देखें `agent.preset`
- मनमुताबिक़ शेड्यूल्ड टास्क (दिन में कई समय, हफ़्ते/महीने के कई दिन, तय अंतराल, हर बार शुरू होने पर);
  हर टास्क का अपना prompt। QQ भेजना एजेंट खुद `qq_notify` से करता है; प्लगइन अब खुद नहीं भेजता।
- DSH के अंदर सेटिंग्स पेज (overview / archived / mailboxes / schedules / prompts / params / guide) जो YAML को जगह पर ही बदलता है

## What it is: a default control flow, not a fixed product

डिफ़ॉल्ट रूप से दो चरण जुड़े हैं: पोलिंग + लोकल आर्काइव, और हर मेल के लिए एक सब-एजेंट टर्न। शेड्यूल्ड टास्क
स्पष्ट होते हैं: `schedules:` में `prompt_file` के साथ जोड़ें। सारांश टास्क आर्काइव पढ़कर सारांश लिख सकता है,
`qq_notify` कॉल कर सकता है और `archive_clear` से साफ़ कर सकता है। फ़्लो **तय नहीं** है: टास्क जोड़ें/हटाएँ,
प्रॉम्प्ट और `agent.tools` बदलें (और अन्य DSH प्लगइन जोड़ें)। डिलीवरी एजेंट के prompt में `qq_notify` कॉल है।

## Requirements

- Node `^22.19.0 || >=24.0.0`
- DSH `0.1.2-rc.1` … `0.2.x` — `@deepseek-ai/dsh-llm|session|tools|storage-domain|brand` के सटीक peer रेंज
  `package.json` में हैं। रेंज से बाहर का host **इंस्टॉल अस्वीकार** कर देता है (`dsh plugin add` peer जाँचता है)।
- HTML प्रीव्यू के लिए Chromium आधारित ब्राउज़र (Edge/Chrome); Windows के बाहर `render.browser` स्पष्ट दें।
- QQ के लिए: आधिकारिक बॉट का `appId` / `appSecret` और प्राप्तकर्ता का `openid`।

## Install

दोनों तरीके चलते हैं; वितरण के अनुसार चुनें:

**लिंक इंस्टॉल** (Windows पर junction; प्लगइन पेज का "स्थानीय फ़ोल्डर से इंस्टॉल")।
यह रेपो **ही** इंस्टॉल प्रतिलिपि है — बदलकर DSH पुनः आरंभ करें:

```powershell
# DSH ऐप में: Settings → Plugins → स्थानीय फ़ोल्डर से इंस्टॉल → यह डायरेक्टरी चुनें
# फिर DSH पुनः आरंभ करें
```

**प्रतिलिपि इंस्टॉल** (`file:` या `npm pack` का tarball)। प्रोफ़ाइल में प्रतिलिपि रहती है, बदलने के बाद सिंक करें:

```powershell
node sync.mjs      # src/ client.js skills/ scripts/ locale/ docs/ को प्रोफ़ाइल इंस्टॉल में कॉपी करें
# फिर DSH पुनः आरंभ करें
```

dsh `0.2.1-rc.3` पर मापा गया: लिंक इंस्टॉल में भी `@deepseek-ai/*` हल होता है (लॉग में `schema=bare-import`)।
प्लगइन प्रोफ़ाइल में **कोई फ़ाइल नहीं लिखता**। ध्यान दें: **`desktop` प्रोफ़ाइल केवल ऐप के प्लगइन पेज से ही
दोबारा इंस्टॉल हो सकती है** — CLI उसे अस्वीकार करता है
(`profile "desktop" is managed exclusively by the Electron application`)।

## Configure

तीन परतें, बाद वाली जीतती है:

1. `cordis.patch.yml` → `mail-automation` पंक्ति का `config` (Schemastery से सत्यापित; प्रोफ़ाइल में बदला जा सकता है)
2. `configFile` का YAML — डिफ़ॉल्ट `$DSH_HOME/mail-automation/mail-automation.yaml`, हर चक्र में फिर पढ़ा जाता है
3. `src/defaults.js` के अंतर्निहित मान

रोज़ के लिए परत 2 ही काफ़ी है: सहेजें, अगले चक्र में लागू (prompts अगली मेल पर)। `poll_seconds` volatile है और
`schedules` अगले heartbeat पर फिर से शेड्यूल होता है — प्लगइन दोबारा लोड करने की ज़रूरत नहीं। पूरी फ़ील्ड सूची: [docs/configuration.md](docs/configuration.md)।

क्रेडेंशियल संदर्भ से दें:

```yaml
sources:
  - id: private
    name: निजी
    type: imap
    host: imap.qq.com
    user: me@qq.com
    password_ref: MAIL_PRIVATE_PASSWORD   # ctx.credentials से हल होता है
qq:
  enabled: true
  openid: <प्राप्तकर्ता openid>          # appId/appSecret डिफ़ॉल्ट QQ_BOT_APP_ID / QQ_BOT_SECRET
```

## Quick start

1. ऊपर के अनुसार इंस्टॉल करें और DSH पुनः आरंभ करें।
2. न्यूनतम YAML (एक स्रोत + अपना `openid`) `$DSH_HOME/mail-automation/mail-automation.yaml` में लिखें।
3. `MAIL_PRIVATE_PASSWORD` (और वैकल्पिक `QQ_BOT_APP_ID` / `QQ_BOT_SECRET`) क्रेडेंशियल पेज में या
   `$DSH_HOME/.credentials.yaml` के `refs:` में रखें।
4. DSH पुनः आरंभ करें और `$DSH_HOME/mail-automation/mail-automation.log` में देखें:
   `插件加载 … schema=bare-import` और `已注册工具：qq_notify / …`।
5. **Settings → 邮件助理** खोलें: स्रोत, उनके कर्सर और `startup.md` में नवीनतम 10 हेडर दिखेंगे।

## Tools

| टूल | काम |
|---|---|
| `qq_notify` | आधिकारिक QQ बॉट से संदेश भेजें |
| `mail_automation_archive_read` | लोकल आर्काइव से **एक मेल** पढ़ें (`text` / `html` / `image` / `raw` / `conclusion` / `meta`) |
| `mail_automation_archive_list` | पूरा आर्काइव (या ids) सूचीबद्ध करें; विषय/समय/प्रेषक/प्राप्तकर्ता/conclusion.md जोड़ें |
| `mail_automation_archive_clear` | पूरा आर्काइव या दी गई ids साफ़ करें (विनाशकारी) |
| `mail_automation_status` | अंतराल, पिछला डाइजेस्ट, प्रति-स्रोत कर्सर, बकाया संख्या |
| `mail_automation_poll` | अभी एक चक्र चलाएँ (अटका चक्र भी मुक्त करें) |
| `mail_automation_config` | पेज जैसी ही क्रियाएँ: read / save_params / save_prompts / retry_failed / retry_poll |

पैरामीटर, वापसी मान और HTTP API: [docs/api.md](docs/api.md)।

## Settings page

**Settings → 邮件助理** में सात टैब: **Overview** (स्थिति, अगला शेड्यूल्ड टास्क, बैकएंड, कॉन्फ़िग पथ, प्रति-स्रोत कर्सर,
"अभी पुनः प्रयास"), **Archived** (स्थानीय रूप से सहेजी गई मेल, ✓ / विफल / प्रोसेसिंग बैज के साथ; "विफल पुनः प्रयास"
ऊपर-दाएँ है और हर शेड्यूल्ड टास्क का अपना "अभी चलाएँ" है), **Mailboxes**, **Schedules** (कितने भी टास्क जोड़ें/बदलें/हटाएँ, हर एक का अपना समय और prompt),
**Prompts** (mail / HTML, दोनों `prompt/` फ़ोल्डर में), **Settings** (पोल/हार्टबीट/हेडर, साइलेंट मोड,
एजेंट वर्कस्पेस और मेल मॉडल / प्रयास / टूल सेट), **Guide** (वेरिएबल, कमेंट सिंटैक्स, आंतरिक skills और मॉडल उन्हें कैसे लोड करे)। सहेजने पर YAML में केवल बदले हुए स्केलर लिखे जाते हैं (टिप्पणियाँ सुरक्षित) और पूरी तालिका फिर जाँची जाती है; टास्क पूरे array के रूप में लिखे जाते हैं।

## Common pitfalls

- **पोल ही नहीं होता** → कॉन्फ़िग में `sources` नहीं, या `configFile` किसी अनुपस्थित फ़ाइल की ओर है (लॉग पथ बताता है)।
- **कुछ आर्काइव नहीं होता** → `password_ref` हल नहीं हुआ (खाली क्रेडेंशियल कभी "कॉन्फ़िगर" नहीं माना जाता), या IMAP का
  `STATUS` उपयोगी नहीं था (चक्र छोड़ा जाता है, कर्सर नहीं बढ़ता)।
- **हर मेल विफल** → `conclusion.md` में `（agent 处理失败：…）` देखें; पैरेंट सेशन तैयार न होना या सब-एजेंट का
  `agent/pre-step` से अस्वीकार होना लॉग में लिखा होता है। टूटा `mail-automation-agent` preset केवल टोकन बचाता नहीं —
  डिफ़ॉल्ट preset पर लौट आता है।
- **प्रीव्यू नहीं** → Edge/Chrome नहीं मिला; `render.browser` दें। `render.remote_images: false` दूरस्थ इमेज/स्टाइल भी
  रोकता है (ट्रैकिंग पिक्सेल से बचाव)।
- **शेड्यूल्ड टास्क नहीं चला** → `schedules` में अमान्य प्रविष्टि (Overview टैब चिपकी कॉन्फ़िग त्रुटि दिखाता है) या टास्क बंद है;
  लॉग `下次定时任务` अगला बताता है।
- **सारांश चला पर QQ नहीं पहुँचा** → टास्क prompt जाँचें (उसमें `qq_notify` होना चाहिए) और agent session देखें।
  प्लगइन अब QQ नहीं भेजता और runtime पर prompt नहीं बदलता।
- **सारांश बना पर archive नहीं हटा** → agent turn विफल हुआ या उसने `（QQ 发送失败：…）` लिखा। सफल भेजने के बाद prompt
  को `archive_clear` कॉल करना चाहिए; सब `[schedule:<id>]` के साथ लॉग होता है।
- **Settings पेज 404 / खाली** → `webServer` नहीं है या route किसी और instance का है; प्लगइन सिर्फ़ WARN करता है।
- **0.8.0 में अपग्रेड (breaking cleanup)**: `digest.*`, inline `schedules[].prompt`, `prompt.inline`,
  `kind`/`consume_archive`, पुराना Graph token migration, पुराने source-id cursor adoption, पुराने prompt copies और
  `mail_automation_digest` टूल हटा दिए गए हैं। हर task को `prompt_file` देना होगा; prompts `prompt/` में रहते हैं;
  Graph हर source के लिए अलग token रखता है: `tokens/graph-<id>.json` (folder suffix नहीं)।

## Tests

```powershell
node test\entry.test.mjs     # 92 जाँच: कॉन्ट्रैक्ट, पंजीकरण क्रम, अनलोड, क्रेडेंशियल, सेटिंग्स पैरामीटर
node test\issues.test.mjs    # 22 जाँच: वर्तमान कॉन्फ़िग, आर्काइव टूल, स्नैपशॉट और क्लाइंट
node test\harness.mjs        # नकली ctx के साथ पूरी श्रृंखला (वास्तविक मेलबॉक्स कॉन्फ़िग चाहिए)
node src\cli.js config       # हल किया कॉन्फ़िग, गोपनीय मान छिपे हुए
```

## Docs

- [docs/architecture.md](docs/architecture.md) — जीवनचक्र, मॉड्यूल, एक मेल की यात्रा, समवर्तीता, एजेंट मॉडल
- [docs/configuration.md](docs/configuration.md) — सभी फ़ील्ड, पथ विस्तार, volatile, ज्ञात सीमाएँ
- [docs/api.md](docs/api.md) — टूल, skills, सेटिंग्स HTTP API, CLI
- [docs/operations.md](docs/operations.md) — इंस्टॉल के तरीके, डेटा पथ, सत्यापन, समस्या-निदान, रोलबैक
- [docs/lessons.md](docs/lessons.md) — वे रनटाइम नियम जो प्लगइन गाइड में नहीं हैं
- [docs/development.md](docs/development.md) — बदलाव अनुशासन, दोष सूची, check/doctor परिणाम

## Boundaries

- मेलबॉक्स के प्रति केवल-पढ़ें: सर्वर पर पढ़ा-चिह्नित, स्थानांतरित या हटाया नहीं जाता।
- केवल कॉन्फ़िगर किए फ़ोल्डर देखता है; सामूहिक मेल नहीं भेजता।
- एजेंट का काम क्रमिक है: एक समय में एक मेल।
- मेलबॉक्स की विफलताएँ लॉग में जाती हैं, host को कभी नहीं फेंकी जातीं।

## License

MIT — देखें [LICENSE](LICENSE)।
