export const meta = {
  name: 'readme-seo-research',
  description: 'Research keywords + GEO/E-E-A-T best practices for the whatRust README, then produce a blueprint',
  phases: [
    { title: 'Research', detail: 'keywords/competitors + GEO/E-E-A-T in parallel' },
    { title: 'Blueprint', detail: 'synthesize into a concrete README plan' },
  ],
}

const product = [
  'PRODUCT: whatRust — a free, open-source, lightweight, cross-platform (Linux, Windows, macOS) desktop client for WhatsApp Web, built with Rust + Tauri v2.',
  'It wraps web.whatsapp.com in the OS-native webview (WebKitGTK/WebView2/WKWebView) instead of bundling Chromium like the official Electron-based WhatsApp Desktop, so idle RAM is roughly 5-10x lower.',
  'Features: system tray + close-to-tray + unread badge, native OS notifications, persistent login, voice messages + calls (mic/camera), launch-at-startup, global show/hide shortcut, single instance, remembers window size/position. One-line install (curl|sh, irm|iex).',
  'Repo: https://github.com/karem505/whatRust . It is an UNOFFICIAL wrapper, not affiliated with WhatsApp/Meta.',
].join(' ')

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    primary_keywords: { type: 'array', items: { type: 'string' }, description: 'highest-intent phrases people search' },
    secondary_keywords: { type: 'array', items: { type: 'string' } },
    related_questions: { type: 'array', items: { type: 'string' }, description: 'real questions users/LLMs ask, for an FAQ' },
    competitor_notes: { type: 'array', items: { type: 'string' }, description: 'what comparable repos (eneshecan/whatsapp-for-linux etc.) do well/poorly in their README' },
    recommended_sections: { type: 'array', items: { type: 'string' } },
    geo_tips: { type: 'array', items: { type: 'string' }, description: 'concrete passage-level citability tips for AI Overviews/ChatGPT/Perplexity' },
    eeat_tips: { type: 'array', items: { type: 'string' } },
    avoid: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'primary_keywords', 'recommended_sections'],
}

phase('Research')
const [kw, geo] = await parallel([
  () => agent([
    'Role: SEO keyword + competitor researcher. Use WebSearch.',
    product,
    'Find the real search intent around tools like this. Investigate queries such as: lightweight whatsapp desktop linux, whatsapp web client linux, whatsapp desktop low ram / memory, open source whatsapp desktop, whatsapp desktop alternative, electron whatsapp ram usage, tauri whatsapp, whatsapp for linux app, whatsapp appimage. Identify the PRIMARY high-intent keywords and long-tail phrases this README should target to rank on Google, plus the real questions people ask (People-Also-Ask style) for an FAQ. Look at competitor repos (e.g. eneshecan/whatsapp-for-linux, other Tauri/Electron whatsapp wrappers) and note what their READMEs do that aids discoverability and what they miss. Be concrete and specific to this product (do not invent metrics). Cite sources.',
  ].join('\n'), { label: 'research:keywords', phase: 'Research', schema: SCHEMA }),
  () => agent([
    'Role: GEO (Generative Engine Optimization) + E-E-A-T specialist for a GitHub README. Use WebSearch for current best practice.',
    product,
    'GitHub renders README markdown and STRIPS embedded JSON-LD/script, and Google indexes the rendered repo page; ChatGPT/Perplexity/Claude/Google-AI-Overviews crawl GitHub READMEs. Given that, produce CONCRETE, README-specific guidance to maximize (a) Google ranking and (b) being cited/quoted by LLMs and AI search. Cover: passage-level citability (self-contained, declarative, factual sentences near the top; a one-sentence definition answering "what is whatRust"), question-style H2/H3 headings that match queries, an FAQ written as content (note: FAQPage schema is NOT needed/usable here, but Q&A CONTENT is highly citable), comparison framing ("whatRust vs WhatsApp Desktop / vs Electron"), entity clarity (Rust, Tauri, WhatsApp Web, AppImage), factual specificity (numbers, supported OSes, requirements), and E-E-A-T/trust signals appropriate to OSS (clear unaffiliated disclaimer, license, accurate limitations, how-it-works, install provenance). Also list what to AVOID (keyword stuffing, unverifiable claims, FAQ schema, marketing fluff). Return a concrete checklist + recommended section order.',
  ].join('\n'), { label: 'research:geo-eeat', phase: 'Research', schema: SCHEMA }),
])

phase('Blueprint')
const blueprint = await agent([
  'You are the SEO content architect. Two researchers produced keyword/competitor findings and GEO/E-E-A-T guidance for the whatRust GitHub README.',
  product,
  'KEYWORD FINDINGS:', JSON.stringify(kw, null, 2),
  'GEO/E-E-A-T FINDINGS:', JSON.stringify(geo, null, 2),
  'Produce a concrete, implementation-ready README BLUEPRINT: the exact ordered section list (with the precise H1 and H2/H3 wording to use, chosen to match search queries), where each primary/secondary keyword should appear naturally, the one-sentence definition to put first, a comparison-table spec (whatRust vs official WhatsApp Desktop / Electron), and 6-10 FAQ questions (the exact question wording) with one-line answer guidance each. Keep every claim truthful to the product as described (no invented metrics; the ~5-10x RAM point is the only quantitative claim and should be framed as typical/approximate). Output the blueprint as clear structured text I can write the README from.',
].join('\n'), { label: 'blueprint', phase: 'Blueprint' })

return { keywords: kw, geo: geo, blueprint }
