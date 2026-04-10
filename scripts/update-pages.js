/**
 * update-pages.js
 * Updates About, Contact, and Privacy Policy pages on WordPress via REST API.
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load settings
const settingsPath = join(__dirname, '..', 'data', 'sites', 'leagueofcooking', 'settings.json');
const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));

const { wpUrl, wpUsername, wpAppPassword } = settings;
const authHeader = 'Basic ' + Buffer.from(`${wpUsername}:${wpAppPassword}`).toString('base64');

// ---------------------------------------------------------------------------
// Page content builders
// ---------------------------------------------------------------------------

function buildAboutContent() {
  return `<!-- wp:heading {"textAlign":"center","level":1} -->
<h1 class="wp-block-heading has-text-align-center">Hi, I'm Amelia!</h1>
<!-- /wp:heading -->

<!-- wp:paragraph {"align":"center","style":{"typography":{"fontSize":"20px"}}} -->
<p class="has-text-align-center" style="font-size:20px">Welcome to League of Cooking, the place where simple meets delicious.</p>
<!-- /wp:paragraph -->

<!-- wp:separator -->
<hr class="wp-block-separator has-alpha-channel-opacity"/>
<!-- /wp:separator -->

<!-- wp:heading {"textAlign":"center"} -->
<h2 class="wp-block-heading has-text-align-center">My Story</h2>
<!-- /wp:heading -->

<!-- wp:paragraph {"style":{"typography":{"fontSize":"18px","lineHeight":"1.8"}}} -->
<p style="font-size:18px;line-height:1.8">I started League of Cooking because I believe amazing food does not have to be complicated. Growing up, some of my happiest memories were made in the kitchen. The smell of something baking, the sound of a pot simmering, that moment when everyone sits down together and takes the first bite.</p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"style":{"typography":{"fontSize":"18px"}}} -->
<p style="font-size:18px">I am not a trained chef. I am a home cook who has spent years figuring out what works, what shortcuts actually save time, and what makes people come back for seconds. Every recipe on this site has been tested in my own kitchen, tweaked until it is just right, and written so anyone can follow along.</p>
<!-- /wp:paragraph -->

<!-- wp:heading {"textAlign":"center"} -->
<h2 class="wp-block-heading has-text-align-center">What You Will Find Here</h2>
<!-- /wp:heading -->

<!-- wp:paragraph {"style":{"typography":{"fontSize":"18px"}}} -->
<p style="font-size:18px">From quick breakfasts that get you out the door to cozy dinners that bring the family together, you will find recipes that fit real life. Nothing fussy. Nothing with a million steps. Just honest, good food made with ingredients you probably already have.</p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"style":{"typography":{"fontSize":"18px"}}} -->
<p style="font-size:18px">I especially love creating recipes that look impressive but are secretly easy. The kind where your friends ask how did you make this and you smile because it only took 30 minutes.</p>
<!-- /wp:paragraph -->

<!-- wp:heading {"textAlign":"center"} -->
<h2 class="wp-block-heading has-text-align-center">Let's Cook Together</h2>
<!-- /wp:heading -->

<!-- wp:paragraph {"style":{"typography":{"fontSize":"18px"}}} -->
<p style="font-size:18px">I would love to hear from you! Try a recipe, snap a photo, and tag me on <a href="https://www.instagram.com/amelia_cooking_/">Instagram</a> or <a href="https://www.pinterest.com/LeagueOfCookingwithAmelia/">Pinterest</a>. There is nothing that makes my day more than seeing your creations.</p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"align":"center","style":{"typography":{"fontSize":"18px"}}} -->
<p class="has-text-align-center" style="font-size:18px">Happy cooking! <strong>Amelia</strong></p>
<!-- /wp:paragraph -->`;
}

function buildContactContent() {
  return `<!-- wp:heading {"textAlign":"center","level":1} -->
<h1 class="wp-block-heading has-text-align-center">Get In Touch</h1>
<!-- /wp:heading -->

<!-- wp:paragraph {"align":"center","style":{"typography":{"fontSize":"18px"}}} -->
<p class="has-text-align-center" style="font-size:18px">I love hearing from readers! Whether you have a question about a recipe, want to share your cooking wins, or are interested in working together, I would love to connect.</p>
<!-- /wp:paragraph -->

<!-- wp:separator -->
<hr class="wp-block-separator has-alpha-channel-opacity"/>
<!-- /wp:separator -->

<!-- wp:columns -->
<div class="wp-block-columns"><!-- wp:column -->
<div class="wp-block-column"><!-- wp:heading {"level":3} -->
<h3 class="wp-block-heading">Recipe Questions</h3>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>Have a question about a recipe? The best way to get a quick answer is to leave a comment directly on the recipe post. I check comments regularly and love helping troubleshoot or suggest substitutions. Other readers often chime in with helpful tips too!</p>
<!-- /wp:paragraph --></div>
<!-- /wp:column -->

<!-- wp:column -->
<div class="wp-block-column"><!-- wp:heading {"level":3} -->
<h3 class="wp-block-heading">Business Inquiries</h3>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>Interested in partnering together? I am open to sponsored content, brand collaborations, recipe development, and other creative partnerships. Please reach out via email with details about your project and I will get back to you as soon as possible.</p>
<!-- /wp:paragraph --></div>
<!-- /wp:column --></div>
<!-- /wp:columns -->

<!-- wp:spacer {"height":"20px"} -->
<div style="height:20px" aria-hidden="true" class="wp-block-spacer"></div>
<!-- /wp:spacer -->

<!-- wp:heading {"textAlign":"center","level":3} -->
<h3 class="wp-block-heading has-text-align-center">Email Me</h3>
<!-- /wp:heading -->

<!-- wp:paragraph {"align":"center","style":{"typography":{"fontSize":"20px"}}} -->
<p class="has-text-align-center" style="font-size:20px"><strong><a href="mailto:contact@leagueofcooking.com">contact@leagueofcooking.com</a></strong></p>
<!-- /wp:paragraph -->

<!-- wp:spacer {"height":"20px"} -->
<div style="height:20px" aria-hidden="true" class="wp-block-spacer"></div>
<!-- /wp:spacer -->

<!-- wp:heading {"textAlign":"center","level":3} -->
<h3 class="wp-block-heading has-text-align-center">Follow Along</h3>
<!-- /wp:heading -->

<!-- wp:paragraph {"align":"center","style":{"typography":{"fontSize":"17px"}}} -->
<p class="has-text-align-center" style="font-size:17px"><a href="https://www.pinterest.com/LeagueOfCookingwithAmelia/">Pinterest</a> | <a href="https://www.instagram.com/amelia_cooking_/">Instagram</a></p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"align":"center","style":{"typography":{"fontSize":"14px"},"color":{"text":"#888888"}}} -->
<p class="has-text-align-center has-text-color" style="color:#888888;font-size:14px">I typically respond within 24 to 48 hours. Thank you for being part of the League of Cooking community!</p>
<!-- /wp:paragraph -->`;
}

function buildPrivacyContent() {
  return `<!-- wp:heading {"textAlign":"center","level":1} -->
<h1 class="wp-block-heading has-text-align-center">Privacy Policy</h1>
<!-- /wp:heading -->

<!-- wp:paragraph {"style":{"typography":{"fontSize":"18px"}}} -->
<p style="font-size:18px">This Privacy Policy explains how League of Cooking (<a href="https://leagueofcooking.com">https://leagueofcooking.com</a>) collects, uses, and protects your information when you visit our website. By using this site, you agree to the practices described in this policy.</p>
<!-- /wp:paragraph -->

<!-- wp:separator -->
<hr class="wp-block-separator has-alpha-channel-opacity"/>
<!-- /wp:separator -->

<!-- wp:heading -->
<h2 class="wp-block-heading">Information We Collect</h2>
<!-- /wp:heading -->

<!-- wp:heading {"level":3} -->
<h3 class="wp-block-heading">Personal Information</h3>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>We may collect personal information that you voluntarily provide when you:</p>
<!-- /wp:paragraph -->

<!-- wp:list -->
<ul class="wp-block-list"><!-- wp:list-item -->
<li>Leave a comment on a blog post (name, email address, website URL)</li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li>Subscribe to our newsletter (email address)</li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li>Contact us via email (name, email address, message content)</li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li>Interact with us on social media</li>
<!-- /wp:list-item --></ul>
<!-- /wp:list -->

<!-- wp:heading {"level":3} -->
<h3 class="wp-block-heading">Automatically Collected Information</h3>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>When you visit our website, certain information is collected automatically, including:</p>
<!-- /wp:paragraph -->

<!-- wp:list -->
<ul class="wp-block-list"><!-- wp:list-item -->
<li>IP address</li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li>Browser type and version</li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li>Operating system</li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li>Referring URL</li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li>Pages visited and time spent on each page</li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li>Date and time of visit</li>
<!-- /wp:list-item --></ul>
<!-- /wp:list -->

<!-- wp:heading -->
<h2 class="wp-block-heading">Cookies</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>League of Cooking uses cookies to improve your browsing experience. Cookies are small text files stored on your device. We use cookies for:</p>
<!-- /wp:paragraph -->

<!-- wp:list -->
<ul class="wp-block-list"><!-- wp:list-item -->
<li>Remembering your preferences and settings</li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li>Analyzing website traffic and usage patterns</li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li>Serving relevant advertisements</li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li>Enabling comment functionality</li>
<!-- /wp:list-item --></ul>
<!-- /wp:list -->

<!-- wp:paragraph -->
<p>You can control cookies through your browser settings. Disabling cookies may affect certain features of the website.</p>
<!-- /wp:paragraph -->

<!-- wp:heading -->
<h2 class="wp-block-heading">Advertising</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>We may use third-party advertising networks to display ads on our website. These companies may use cookies and similar technologies to serve ads based on your interests and browsing history. Third-party ad networks we may work with include:</p>
<!-- /wp:paragraph -->

<!-- wp:list -->
<ul class="wp-block-list"><!-- wp:list-item -->
<li>Google AdSense / Google Ad Manager</li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li>Mediavine</li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li>AdThrive / Raptive</li>
<!-- /wp:list-item --></ul>
<!-- /wp:list -->

<!-- wp:paragraph -->
<p>You can opt out of personalized advertising by visiting:</p>
<!-- /wp:paragraph -->

<!-- wp:list -->
<ul class="wp-block-list"><!-- wp:list-item -->
<li><a href="https://www.aboutads.info/choices/">Digital Advertising Alliance Opt-Out</a></li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li><a href="https://www.networkadvertising.org/choices/">Network Advertising Initiative Opt-Out</a></li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li><a href="https://adssettings.google.com/">Google Ads Settings</a></li>
<!-- /wp:list-item --></ul>
<!-- /wp:list -->

<!-- wp:heading -->
<h2 class="wp-block-heading">Comments</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>When you leave a comment on our site, we collect the data shown in the comment form, your IP address, and browser user agent string to help with spam detection. An anonymized string created from your email address (also called a hash) may be provided to the Gravatar service to check if you have a profile. Comments and their associated data are retained indefinitely so we can recognize and approve follow-up comments automatically.</p>
<!-- /wp:paragraph -->

<!-- wp:heading -->
<h2 class="wp-block-heading">Newsletter</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>If you subscribe to our newsletter, your email address will be stored with our email service provider. You can unsubscribe at any time using the link provided in every email. We will never sell, rent, or share your email address with third parties for their marketing purposes.</p>
<!-- /wp:paragraph -->

<!-- wp:heading -->
<h2 class="wp-block-heading">Affiliate Links and Sponsored Content</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>League of Cooking may contain affiliate links. When you click on an affiliate link and make a purchase, we may earn a small commission at no additional cost to you. We only recommend products and services we genuinely believe in. Sponsored posts and partnerships will always be clearly disclosed in the content.</p>
<!-- /wp:paragraph -->

<!-- wp:heading -->
<h2 class="wp-block-heading">Third-Party Services</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>We use the following third-party services that may collect and process your data:</p>
<!-- /wp:paragraph -->

<!-- wp:list -->
<ul class="wp-block-list"><!-- wp:list-item -->
<li><strong>Google Analytics</strong> - to analyze website traffic and user behavior. Google Analytics uses cookies to collect anonymous data. You can opt out using the <a href="https://tools.google.com/dlpage/gaoptout">Google Analytics Opt-Out Browser Add-on</a>.</li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li><strong>Ad Networks</strong> - third-party advertising partners as described in the Advertising section above.</li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li><strong>Yoast SEO</strong> - for search engine optimization. Yoast may collect limited data for site analysis purposes.</li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li><strong>WordPress.com</strong> - our content management system and hosting platform, which may collect server logs and usage data.</li>
<!-- /wp:list-item --></ul>
<!-- /wp:list -->

<!-- wp:heading -->
<h2 class="wp-block-heading">Your Rights</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>You have the right to:</p>
<!-- /wp:paragraph -->

<!-- wp:list -->
<ul class="wp-block-list"><!-- wp:list-item -->
<li><strong>Access</strong> - Request a copy of the personal data we hold about you.</li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li><strong>Correction</strong> - Request that we correct any inaccurate or incomplete personal data.</li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li><strong>Deletion</strong> - Request that we delete your personal data, subject to any legal obligations we may have to retain it.</li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li><strong>Objection</strong> - Object to the processing of your personal data for certain purposes.</li>
<!-- /wp:list-item --></ul>
<!-- /wp:list -->

<!-- wp:paragraph -->
<p>To exercise any of these rights, please contact us at <a href="mailto:contact@leagueofcooking.com">contact@leagueofcooking.com</a>. We will respond to your request within 30 days.</p>
<!-- /wp:paragraph -->

<!-- wp:heading -->
<h2 class="wp-block-heading">Children's Privacy</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>League of Cooking is not directed at children under the age of 13. We do not knowingly collect personal information from children. If you believe a child has provided us with personal information, please contact us immediately so we can take appropriate action to remove that data.</p>
<!-- /wp:paragraph -->

<!-- wp:heading -->
<h2 class="wp-block-heading">Changes to This Policy</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>We may update this Privacy Policy from time to time to reflect changes in our practices, technology, or legal requirements. Any changes will be posted on this page with an updated revision date. We encourage you to review this policy periodically to stay informed about how we protect your information.</p>
<!-- /wp:paragraph -->

<!-- wp:heading -->
<h2 class="wp-block-heading">Contact Us</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>If you have any questions or concerns about this Privacy Policy, please contact us at:</p>
<!-- /wp:paragraph -->

<!-- wp:paragraph -->
<p><strong>Email:</strong> <a href="mailto:contact@leagueofcooking.com">contact@leagueofcooking.com</a><br><strong>Website:</strong> <a href="https://leagueofcooking.com">https://leagueofcooking.com</a></p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"style":{"typography":{"fontSize":"14px"},"color":{"text":"#888888"}}} -->
<p class="has-text-color" style="color:#888888;font-size:14px"><em>Last updated: March 28, 2026</em></p>
<!-- /wp:paragraph -->`;
}

// ---------------------------------------------------------------------------
// WordPress REST API helper
// ---------------------------------------------------------------------------

async function updatePage(pageId, slug, content, extraFields = {}) {
  const endpoint = `${wpUrl}/wp-json/wp/v2/pages/${pageId}`;
  const body = {
    slug,
    content,
    ...extraFields,
  };

  const res = await fetch(endpoint, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  return { ok: res.ok, status: res.status, title: data.title?.rendered || slug, id: pageId, data };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Updating pages on ${wpUrl} as ${wpUsername}...\n`);

  const pages = [
    { id: 198, slug: 'about', label: 'About', content: buildAboutContent() },
    { id: 197, slug: 'contact', label: 'Contact', content: buildContactContent() },
    { id: 3, slug: 'privacy-policy', label: 'Privacy Policy', content: buildPrivacyContent(), extra: { status: 'publish' } },
  ];

  for (const page of pages) {
    try {
      const result = await updatePage(page.id, page.slug, page.content, page.extra || {});
      if (result.ok) {
        console.log(`[SUCCESS] ${page.label} (ID: ${page.id}) updated successfully.`);
      } else {
        console.error(`[FAILURE] ${page.label} (ID: ${page.id}) - HTTP ${result.status}: ${JSON.stringify(result.data)}`);
      }
    } catch (err) {
      console.error(`[ERROR] ${page.label} (ID: ${page.id}) - ${err.message}`);
    }
  }

  console.log('\nDone.');
}

main();
