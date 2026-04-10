import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const settingsPath = join(__dirname, '..', 'data', 'sites', 'leagueofcooking', 'settings.json');
const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
const auth = 'Basic ' + Buffer.from(s.wpUsername + ':' + s.wpAppPassword).toString('base64');

const aboutHTML = `<!-- wp:spacer {"height":"30px"} -->
<div style="height:30px" aria-hidden="true" class="wp-block-spacer"></div>
<!-- /wp:spacer -->

<!-- wp:columns {"verticalAlignment":"center"} -->
<div class="wp-block-columns are-vertically-aligned-center">
<!-- wp:column {"verticalAlignment":"center","width":"40%"} -->
<div class="wp-block-column is-vertically-aligned-center" style="flex-basis:40%">

<!-- wp:image {"id":367,"sizeSlug":"large","linkDestination":"none","align":"center","className":"is-style-rounded"} -->
<figure class="wp-block-image aligncenter size-large is-style-rounded"><img src="https://leagueofcooking.com/wp-content/uploads/2026/03/big-image-2.jpg" alt="Amelia from League of Cooking" class="wp-image-367" style="border-radius:50%;max-width:320px;"/></figure>
<!-- /wp:image -->

</div>
<!-- /wp:column -->

<!-- wp:column {"verticalAlignment":"center","width":"60%"} -->
<div class="wp-block-column is-vertically-aligned-center" style="flex-basis:60%">

<!-- wp:heading {"level":1,"style":{"typography":{"fontSize":"38px"}}} -->
<h1 class="wp-block-heading" style="font-size:38px">Hi, I'm Amelia!</h1>
<!-- /wp:heading -->

<!-- wp:paragraph {"style":{"typography":{"fontSize":"20px","lineHeight":"1.7"},"color":{"text":"#6B4C4C"}}} -->
<p style="color:#6B4C4C;font-size:20px;line-height:1.7">Welcome to <strong>League of Cooking</strong>, the place where simple meets delicious. I believe amazing food does not have to be complicated, and I am here to prove it one recipe at a time.</p>
<!-- /wp:paragraph -->

</div>
<!-- /wp:column -->
</div>
<!-- /wp:columns -->

<!-- wp:spacer {"height":"40px"} -->
<div style="height:40px" aria-hidden="true" class="wp-block-spacer"></div>
<!-- /wp:spacer -->

<!-- wp:separator {"className":"is-style-wide"} -->
<hr class="wp-block-separator has-alpha-channel-opacity is-style-wide"/>
<!-- /wp:separator -->

<!-- wp:spacer {"height":"30px"} -->
<div style="height:30px" aria-hidden="true" class="wp-block-spacer"></div>
<!-- /wp:spacer -->

<!-- wp:heading {"textAlign":"center","style":{"typography":{"fontSize":"32px"},"color":{"text":"#8B5E5E"}}} -->
<h2 class="wp-block-heading has-text-align-center" style="color:#8B5E5E;font-size:32px">My Story</h2>
<!-- /wp:heading -->

<!-- wp:spacer {"height":"15px"} -->
<div style="height:15px" aria-hidden="true" class="wp-block-spacer"></div>
<!-- /wp:spacer -->

<!-- wp:paragraph {"style":{"typography":{"fontSize":"18px","lineHeight":"1.85"}}} -->
<p style="font-size:18px;line-height:1.85">I started League of Cooking because some of my happiest memories were made in the kitchen. The smell of something baking on a Sunday morning. The sound of a pot simmering while the house fills with warmth. That moment when everyone sits down, takes the first bite, and just smiles.</p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"style":{"typography":{"fontSize":"18px","lineHeight":"1.85"}}} -->
<p style="font-size:18px;line-height:1.85">I am not a trained chef. Not even close. I am a home cook who has spent years figuring out what actually works, which shortcuts save real time, and what makes people come back for seconds. Every single recipe on this site has been tested in my own kitchen, tweaked until it felt just right, and written so that anyone can follow along.</p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"style":{"typography":{"fontSize":"18px","lineHeight":"1.85"}}} -->
<p style="font-size:18px;line-height:1.85">I got tired of recipes that needed 47 ingredients and three hours of prep. So I made a space for the kind of cooking I actually do. Quick. Real. Delicious.</p>
<!-- /wp:paragraph -->

<!-- wp:spacer {"height":"40px"} -->
<div style="height:40px" aria-hidden="true" class="wp-block-spacer"></div>
<!-- /wp:spacer -->

<!-- wp:heading {"textAlign":"center","style":{"typography":{"fontSize":"32px"},"color":{"text":"#8B5E5E"}}} -->
<h2 class="wp-block-heading has-text-align-center" style="color:#8B5E5E;font-size:32px">What You Will Find Here</h2>
<!-- /wp:heading -->

<!-- wp:spacer {"height":"15px"} -->
<div style="height:15px" aria-hidden="true" class="wp-block-spacer"></div>
<!-- /wp:spacer -->

<!-- wp:columns -->
<div class="wp-block-columns">
<!-- wp:column -->
<div class="wp-block-column">

<!-- wp:heading {"level":3,"textAlign":"center","style":{"color":{"text":"#C48B8B"}}} -->
<h3 class="wp-block-heading has-text-align-center" style="color:#C48B8B">Quick Breakfasts</h3>
<!-- /wp:heading -->

<!-- wp:paragraph {"align":"center","style":{"typography":{"fontSize":"16px","lineHeight":"1.7"}}} -->
<p class="has-text-align-center" style="font-size:16px;line-height:1.7">Recipes that get you out the door with a full stomach and a smile. No alarm clock needed.</p>
<!-- /wp:paragraph -->

</div>
<!-- /wp:column -->

<!-- wp:column -->
<div class="wp-block-column">

<!-- wp:heading {"level":3,"textAlign":"center","style":{"color":{"text":"#C48B8B"}}} -->
<h3 class="wp-block-heading has-text-align-center" style="color:#C48B8B">Cozy Dinners</h3>
<!-- /wp:heading -->

<!-- wp:paragraph {"align":"center","style":{"typography":{"fontSize":"16px","lineHeight":"1.7"}}} -->
<p class="has-text-align-center" style="font-size:16px;line-height:1.7">The kind of meals that bring everyone to the table. Comfort food made simple.</p>
<!-- /wp:paragraph -->

</div>
<!-- /wp:column -->

<!-- wp:column -->
<div class="wp-block-column">

<!-- wp:heading {"level":3,"textAlign":"center","style":{"color":{"text":"#C48B8B"}}} -->
<h3 class="wp-block-heading has-text-align-center" style="color:#C48B8B">Sweet Treats</h3>
<!-- /wp:heading -->

<!-- wp:paragraph {"align":"center","style":{"typography":{"fontSize":"16px","lineHeight":"1.7"}}} -->
<p class="has-text-align-center" style="font-size:16px;line-height:1.7">Desserts that look impressive but are secretly easy. Your friends will definitely ask for the recipe.</p>
<!-- /wp:paragraph -->

</div>
<!-- /wp:column -->
</div>
<!-- /wp:columns -->

<!-- wp:spacer {"height":"40px"} -->
<div style="height:40px" aria-hidden="true" class="wp-block-spacer"></div>
<!-- /wp:spacer -->

<!-- wp:paragraph {"align":"center","style":{"typography":{"fontSize":"18px","lineHeight":"1.85"},"color":{"text":"#6B4C4C","background":"#FFF5F5"}}} -->
<p class="has-text-align-center" style="color:#6B4C4C;background-color:#FFF5F5;font-size:18px;line-height:1.85;padding:24px;border-radius:12px">Nothing fussy. Nothing with a million steps. Just honest, good food made with ingredients you probably already have.</p>
<!-- /wp:paragraph -->

<!-- wp:spacer {"height":"40px"} -->
<div style="height:40px" aria-hidden="true" class="wp-block-spacer"></div>
<!-- /wp:spacer -->

<!-- wp:separator {"className":"is-style-wide"} -->
<hr class="wp-block-separator has-alpha-channel-opacity is-style-wide"/>
<!-- /wp:separator -->

<!-- wp:spacer {"height":"30px"} -->
<div style="height:30px" aria-hidden="true" class="wp-block-spacer"></div>
<!-- /wp:spacer -->

<!-- wp:heading {"textAlign":"center","style":{"typography":{"fontSize":"32px"},"color":{"text":"#8B5E5E"}}} -->
<h2 class="wp-block-heading has-text-align-center" style="color:#8B5E5E;font-size:32px">Let's Cook Together</h2>
<!-- /wp:heading -->

<!-- wp:spacer {"height":"15px"} -->
<div style="height:15px" aria-hidden="true" class="wp-block-spacer"></div>
<!-- /wp:spacer -->

<!-- wp:paragraph {"align":"center","style":{"typography":{"fontSize":"18px","lineHeight":"1.85"}}} -->
<p class="has-text-align-center" style="font-size:18px;line-height:1.85">I would love to hear from you! Try a recipe, snap a photo, and share it with me. There is nothing that makes my day more than seeing your creations in the kitchen.</p>
<!-- /wp:paragraph -->

<!-- wp:spacer {"height":"20px"} -->
<div style="height:20px" aria-hidden="true" class="wp-block-spacer"></div>
<!-- /wp:spacer -->

<!-- wp:columns -->
<div class="wp-block-columns">
<!-- wp:column -->
<div class="wp-block-column">

<!-- wp:paragraph {"align":"center","style":{"typography":{"fontSize":"28px"}}} -->
<p class="has-text-align-center" style="font-size:28px"><a href="https://www.pinterest.com/LeagueOfCookingwithAmelia/">Pinterest</a></p>
<!-- /wp:paragraph -->

</div>
<!-- /wp:column -->

<!-- wp:column -->
<div class="wp-block-column">

<!-- wp:paragraph {"align":"center","style":{"typography":{"fontSize":"28px"}}} -->
<p class="has-text-align-center" style="font-size:28px"><a href="https://www.instagram.com/amelia_cooking_/">Instagram</a></p>
<!-- /wp:paragraph -->

</div>
<!-- /wp:column -->

<!-- wp:column -->
<div class="wp-block-column">

<!-- wp:paragraph {"align":"center","style":{"typography":{"fontSize":"28px"}}} -->
<p class="has-text-align-center" style="font-size:28px"><a href="mailto:contact@leagueofcooking.com">Email</a></p>
<!-- /wp:paragraph -->

</div>
<!-- /wp:column -->
</div>
<!-- /wp:columns -->

<!-- wp:spacer {"height":"30px"} -->
<div style="height:30px" aria-hidden="true" class="wp-block-spacer"></div>
<!-- /wp:spacer -->

<!-- wp:paragraph {"align":"center","style":{"typography":{"fontSize":"22px","lineHeight":"1.6"},"color":{"text":"#8B5E5E"}}} -->
<p class="has-text-align-center" style="color:#8B5E5E;font-size:22px;line-height:1.6">Happy cooking!<br><strong>Amelia</strong> x</p>
<!-- /wp:paragraph -->

<!-- wp:spacer {"height":"40px"} -->
<div style="height:40px" aria-hidden="true" class="wp-block-spacer"></div>
<!-- /wp:spacer -->`;

const resp = await fetch(s.wpUrl + '/wp-json/wp/v2/pages/198', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: aboutHTML })
});
console.log('About page:', resp.ok ? 'UPDATED' : 'FAILED ' + resp.status);

// ═══════════════════════════════════════
// PRIVACY POLICY (ID: 3)
// ═══════════════════════════════════════
const privacyHTML = `<!-- wp:heading {"level":1} -->
<h1 class="wp-block-heading">Privacy Policy</h1>
<!-- /wp:heading -->

<!-- wp:paragraph {"style":{"typography":{"fontSize":"16px","lineHeight":"1.8"}}} -->
<p style="font-size:16px;line-height:1.8"><strong>Last updated:</strong> March 28, 2026</p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"style":{"typography":{"fontSize":"16px","lineHeight":"1.8"}}} -->
<p style="font-size:16px;line-height:1.8">At League of Cooking ("we," "us," or "our"), accessible at <a href="https://leagueofcooking.com">leagueofcooking.com</a>, your privacy is important to us. This Privacy Policy explains how we collect, use, and protect your information when you visit our website.</p>
<!-- /wp:paragraph -->

<!-- wp:heading -->
<h2 class="wp-block-heading">Information We Collect</h2>
<!-- /wp:heading -->

<!-- wp:paragraph {"style":{"typography":{"fontSize":"16px","lineHeight":"1.8"}}} -->
<p style="font-size:16px;line-height:1.8"><strong>Personal Information:</strong> When you leave a comment, subscribe to our newsletter, or contact us via email, we may collect your name and email address. This information is provided voluntarily by you.</p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"style":{"typography":{"fontSize":"16px","lineHeight":"1.8"}}} -->
<p style="font-size:16px;line-height:1.8"><strong>Automatically Collected Information:</strong> Like most websites, we automatically collect certain data when you visit, including your IP address, browser type, operating system, referring URLs, and pages visited. This data helps us understand how visitors use our site and improve your experience.</p>
<!-- /wp:paragraph -->

<!-- wp:heading -->
<h2 class="wp-block-heading">Cookies</h2>
<!-- /wp:heading -->

<!-- wp:paragraph {"style":{"typography":{"fontSize":"16px","lineHeight":"1.8"}}} -->
<p style="font-size:16px;line-height:1.8">We use cookies to enhance your browsing experience. Cookies are small files stored on your device that help us remember your preferences and understand how you interact with our site. You can manage or disable cookies through your browser settings at any time.</p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"style":{"typography":{"fontSize":"16px","lineHeight":"1.8"}}} -->
<p style="font-size:16px;line-height:1.8">Third-party services we use (such as Google Analytics and advertising partners) may also place cookies on your device. These cookies help us analyze traffic and serve relevant advertisements.</p>
<!-- /wp:paragraph -->

<!-- wp:heading -->
<h2 class="wp-block-heading">Advertising</h2>
<!-- /wp:heading -->

<!-- wp:paragraph {"style":{"typography":{"fontSize":"16px","lineHeight":"1.8"}}} -->
<p style="font-size:16px;line-height:1.8">We may display advertisements on our website through third-party advertising networks. These networks may use cookies and similar technologies to serve ads based on your prior visits to this and other websites. You can opt out of personalized advertising by visiting <a href="https://www.aboutads.info/choices/">aboutads.info/choices</a> or <a href="https://www.networkadvertising.org/choices/">networkadvertising.org/choices</a>.</p>
<!-- /wp:paragraph -->

<!-- wp:heading -->
<h2 class="wp-block-heading">Comments</h2>
<!-- /wp:heading -->

<!-- wp:paragraph {"style":{"typography":{"fontSize":"16px","lineHeight":"1.8"}}} -->
<p style="font-size:16px;line-height:1.8">When you leave a comment on our site, we collect the data shown in the comment form, along with your IP address and browser user agent string to help with spam detection. Your comment and its associated data are retained indefinitely so we can recognize and approve any follow-up comments automatically.</p>
<!-- /wp:paragraph -->

<!-- wp:heading -->
<h2 class="wp-block-heading">Newsletter</h2>
<!-- /wp:heading -->

<!-- wp:paragraph {"style":{"typography":{"fontSize":"16px","lineHeight":"1.8"}}} -->
<p style="font-size:16px;line-height:1.8">If you subscribe to our newsletter, we collect your name and email address. We use this information solely to send you recipe updates and cooking tips. You can unsubscribe at any time using the link at the bottom of every email.</p>
<!-- /wp:paragraph -->

<!-- wp:heading -->
<h2 class="wp-block-heading">Affiliate Links and Sponsored Content</h2>
<!-- /wp:heading -->

<!-- wp:paragraph {"style":{"typography":{"fontSize":"16px","lineHeight":"1.8"}}} -->
<p style="font-size:16px;line-height:1.8">Some posts on League of Cooking may contain affiliate links. This means we may earn a small commission if you make a purchase through our links, at no additional cost to you. We only recommend products we genuinely use and believe in. Sponsored content will always be clearly disclosed.</p>
<!-- /wp:paragraph -->

<!-- wp:heading -->
<h2 class="wp-block-heading">Third-Party Services</h2>
<!-- /wp:heading -->

<!-- wp:paragraph {"style":{"typography":{"fontSize":"16px","lineHeight":"1.8"}}} -->
<p style="font-size:16px;line-height:1.8">We use the following third-party services that may collect data:</p>
<!-- /wp:paragraph -->

<!-- wp:list -->
<ul><li><strong>Google Analytics</strong> for website traffic analysis</li><li><strong>Google AdSense / Mediavine / AdThrive</strong> for display advertising</li><li><strong>Yoast SEO</strong> for search engine optimization</li><li><strong>WordPress.com</strong> for website hosting and comments</li></ul>
<!-- /wp:list -->

<!-- wp:paragraph {"style":{"typography":{"fontSize":"16px","lineHeight":"1.8"}}} -->
<p style="font-size:16px;line-height:1.8">Each of these services has their own privacy policy governing how they use your data.</p>
<!-- /wp:paragraph -->

<!-- wp:heading -->
<h2 class="wp-block-heading">Your Rights</h2>
<!-- /wp:heading -->

<!-- wp:paragraph {"style":{"typography":{"fontSize":"16px","lineHeight":"1.8"}}} -->
<p style="font-size:16px;line-height:1.8">You have the right to request access to, correction of, or deletion of your personal data. If you have left comments on our site, you can request to receive an exported file of the personal data we hold about you. You can also request that we erase any personal data we hold about you. To make a request, please email us at <a href="mailto:contact@leagueofcooking.com">contact@leagueofcooking.com</a>.</p>
<!-- /wp:paragraph -->

<!-- wp:heading -->
<h2 class="wp-block-heading">Children's Privacy</h2>
<!-- /wp:heading -->

<!-- wp:paragraph {"style":{"typography":{"fontSize":"16px","lineHeight":"1.8"}}} -->
<p style="font-size:16px;line-height:1.8">Our website is not directed to children under the age of 13. We do not knowingly collect personal information from children. If you believe a child has provided us with personal data, please contact us and we will delete it.</p>
<!-- /wp:paragraph -->

<!-- wp:heading -->
<h2 class="wp-block-heading">Changes to This Policy</h2>
<!-- /wp:heading -->

<!-- wp:paragraph {"style":{"typography":{"fontSize":"16px","lineHeight":"1.8"}}} -->
<p style="font-size:16px;line-height:1.8">We may update this Privacy Policy from time to time. Any changes will be posted on this page with an updated revision date. We encourage you to review this page periodically.</p>
<!-- /wp:paragraph -->

<!-- wp:heading -->
<h2 class="wp-block-heading">Contact Us</h2>
<!-- /wp:heading -->

<!-- wp:paragraph {"style":{"typography":{"fontSize":"16px","lineHeight":"1.8"}}} -->
<p style="font-size:16px;line-height:1.8">If you have any questions about this Privacy Policy, please contact us at <a href="mailto:contact@leagueofcooking.com">contact@leagueofcooking.com</a>.</p>
<!-- /wp:paragraph -->`;

const privacyResp = await fetch(s.wpUrl + '/wp-json/wp/v2/pages/3', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: privacyHTML, status: 'publish' })
});
console.log('Privacy Policy:', privacyResp.ok ? 'UPDATED + PUBLISHED' : 'FAILED ' + privacyResp.status);
