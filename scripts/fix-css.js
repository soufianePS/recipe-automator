import { readFileSync } from 'fs';

const s = JSON.parse(readFileSync('data/sites/leagueofcooking/settings.json', 'utf-8'));
const auth = 'Basic ' + Buffer.from(s.wpUsername + ':' + s.wpAppPassword).toString('base64');

// Get current custom CSS post
const resp = await fetch(s.wpUrl + '/wp-json/wp/v2/posts?post_type=custom_css&status=publish&per_page=1&context=edit', { headers: { Authorization: auth } });
const posts = await resp.json();
const cssId = posts[0].id;

// Keep ONLY the original zoom-hover + uagb rules, rebuild everything else fresh
const freshCSS = `/* Original theme overrides */
.zoom-hover {
  overflow: hidden;
  border-radius: 6px;
}

.zoom-hover img {
  transition: transform 0.6s ease;
}

.zoom-hover:hover img {
  transform: scale(1.15);
}

.uagb-post__image {
  height: 220px;
}

.uagb-post__image div {
  background-size: cover !important;
  background-position: center !important;
}

/* ═══════════════════════════════════════════════════ */
/* GOOGLE FONTS — PRO FOOD BLOG TYPOGRAPHY            */
/* ═══════════════════════════════════════════════════ */
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,400;1,700&family=Lora:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Inter:wght@400;500;600;700&display=swap');

/* ── H1: Playfair Display — bold, commanding, editorial ── */
h1,
.entry-title,
h1.entry-title,
h1.wp-block-heading {
  font-family: 'Playfair Display', Georgia, serif !important;
  font-weight: 800 !important;
  font-size: 38px;
  line-height: 1.15;
  color: #1a1a1a;
  letter-spacing: -0.5px;
  text-rendering: optimizeLegibility;
}

/* ── H2: Playfair Display — section headings ── */
h2,
.entry-content h2,
h2.wp-block-heading {
  font-family: 'Playfair Display', Georgia, serif !important;
  font-weight: 700 !important;
  font-size: 30px;
  line-height: 1.25;
  color: #8B5E5E;
  letter-spacing: -0.3px;
  margin-top: 2.2em;
  margin-bottom: 0.7em;
}

/* ── H3: Playfair Display — step titles, FAQ ── */
h3,
.entry-content h3,
h3.wp-block-heading {
  font-family: 'Playfair Display', Georgia, serif !important;
  font-weight: 600 !important;
  font-size: 23px;
  line-height: 1.3;
  color: #C48B8B;
  margin-top: 1.8em;
  margin-bottom: 0.5em;
}

/* ── H4-H6 ── */
h4, h5, h6 {
  font-family: 'Playfair Display', Georgia, serif !important;
  font-weight: 600 !important;
  color: #3a3a3a;
}

/* ── Site title in header ── */
.site-title,
.site-branding .site-title {
  font-family: 'Playfair Display', Georgia, serif !important;
  font-weight: 700 !important;
}

/* ── Body text: Lora — warm, inviting, easy to read ── */
body,
.entry-content,
.entry-content p {
  font-family: 'Lora', Georgia, serif !important;
  font-size: 18px;
  line-height: 1.85;
  color: #3a3a3a;
  word-spacing: 0.5px;
}

.entry-content p {
  margin-bottom: 1.6em;
}

/* ── Lists ── */
.entry-content ul,
.entry-content ol {
  font-family: 'Lora', Georgia, serif !important;
  font-size: 17px;
  line-height: 1.8;
  margin-bottom: 1.5em;
  padding-left: 1.5em;
}

.entry-content li {
  margin-bottom: 0.7em;
  color: #3a3a3a;
}

/* ── UI elements: Inter — clean sans-serif ── */
.entry-meta,
.post-meta,
.comment-meta,
.widget,
.sidebar,
nav,
button,
input,
select,
textarea,
.btn,
.tasty-recipes-entry-footer,
.tasty-recipes-nutrition,
.wprm-recipe-container {
  font-family: 'Inter', -apple-system, sans-serif !important;
}

/* ═══════════════════════════════════════════════════ */
/* BLOG POST — CLEAN READABILITY + AD SPACING         */
/* ═══════════════════════════════════════════════════ */

/* Images: rounded corners + soft shadow */
.entry-content figure,
.entry-content .wp-block-image {
  margin-top: 1.5em;
  margin-bottom: 1.5em;
}

.entry-content .wp-block-image img {
  border-radius: 12px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.07);
}

/* Separators */
.entry-content hr {
  margin: 2.5em auto;
  border: none;
  border-top: 2px solid #f0e6e6;
  max-width: 180px;
}

/* Spacers */
.entry-content .wp-block-spacer {
  margin: 0;
}

/* Step tips pink accent */
.entry-content p strong:first-child {
  color: #C48B8B;
}

/* Fun fact / highlight boxes */
.entry-content p[style*="background-color"] {
  border-radius: 12px;
  border-left: 4px solid #D4A0A0;
  padding: 18px 22px !important;
}

/* Blockquotes */
.entry-content blockquote {
  border-left: 4px solid #D4A0A0;
  padding: 16px 24px;
  margin: 2em 0;
  font-style: italic;
  color: #6B4C4C;
  background: #FFF9F9;
  border-radius: 0 12px 12px 0;
}

/* ═══════════════════════════════════════════════════ */
/* HOMEPAGE — COMPACT HEADINGS                        */
/* ═══════════════════════════════════════════════════ */

.home h1,
body.home h1.wp-block-heading {
  font-size: 24px !important;
  margin-top: 1.5em;
  margin-bottom: 0.5em;
}

.home h2,
body.home h2.wp-block-heading {
  font-size: 22px !important;
  margin-top: 1.2em;
  margin-bottom: 0.5em;
}

.home .wp-block-kadence-column h1 {
  font-size: 20px !important;
}

/* Recipe card titles on homepage */
.uagb-post__title,
.uagb-post__title a {
  font-size: 15px !important;
  line-height: 1.4;
}

/* ═══════════════════════════════════════════════════ */
/* MOBILE RESPONSIVE                                   */
/* ═══════════════════════════════════════════════════ */

@media (max-width: 768px) {
  h1, .entry-title, h1.entry-title {
    font-size: 28px !important;
    line-height: 1.2;
  }
  .entry-content p {
    font-size: 16px;
    line-height: 1.75;
  }
  .entry-content h2 {
    font-size: 24px !important;
    margin-top: 1.8em;
  }
  .entry-content h3 {
    font-size: 20px !important;
  }
  .home h1 {
    font-size: 20px !important;
  }
  .home h2 {
    font-size: 18px !important;
  }
  .uagb-post__image {
    height: 180px;
  }
}`;

const updateResp = await fetch(s.wpUrl + '/wp-json/wp/v2/posts/' + cssId + '?post_type=custom_css', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: { raw: freshCSS } })
});

if (updateResp.ok) {
  console.log('CSS rebuilt and saved! Length:', freshCSS.length);
} else {
  console.log('FAILED:', updateResp.status, await updateResp.text());
}
