/**
 * Build Home 3 page — clean white/rose design with dynamic content.
 */
import { readFileSync } from 'fs';

const settings = JSON.parse(readFileSync('data/sites/leagueofcooking/settings.json', 'utf8'));
const WP_URL = settings.wpUrl;
const AUTH = 'Basic ' + Buffer.from(`${settings.wpUsername}:${settings.wpAppPassword}`).toString('base64');
const PAGE_ID = 2244;

async function updatePage(content, meta = {}) {
  const body = { content, ...meta };
  const resp = await fetch(`${WP_URL}/wp-json/wp/v2/pages/${PAGE_ID}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': AUTH },
    body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error(`Failed: ${resp.status} ${await resp.text()}`);
  console.log('Page updated');
}

// ════════════════════════════════════════════
// SECTION 1: HERO
// ════════════════════════════════════════════
const hero = `
<!-- wp:group {"style":{"spacing":{"padding":{"top":"60px","bottom":"40px","left":"24px","right":"24px"}},"color":{"background":"#faf5f2"}},"layout":{"type":"constrained","contentSize":"700px"}} -->
<div class="wp-block-group has-background" style="background-color:#faf5f2;padding-top:60px;padding-right:24px;padding-bottom:40px;padding-left:24px">

<!-- wp:image {"id":366,"width":"100px","height":"100px","sizeSlug":"thumbnail","linkDestination":"none","align":"center","style":{"border":{"radius":"50%"}}} -->
<figure class="wp-block-image aligncenter size-thumbnail is-resized" style="border-radius:50%"><img src="https://leagueofcooking.com/wp-content/uploads/2026/03/Avatar-perso.jpg" alt="Amelia" class="wp-image-366" style="border-radius:50%;width:100px;height:100px;object-fit:cover"/></figure>
<!-- /wp:image -->

<!-- wp:heading {"textAlign":"center","level":1,"style":{"typography":{"fontSize":"38px","fontWeight":"700","fontFamily":"Playfair Display"},"color":{"text":"#3a2a24"},"spacing":{"margin":{"top":"16px","bottom":"8px"}}}} -->
<h1 class="wp-block-heading has-text-align-center" style="color:#3a2a24;margin-top:16px;margin-bottom:8px;font-family:Playfair Display;font-size:38px;font-weight:700">League of Cooking</h1>
<!-- /wp:heading -->

<!-- wp:paragraph {"align":"center","style":{"typography":{"fontSize":"16px","fontFamily":"Lora"},"color":{"text":"#9a8a82"}}} -->
<p class="has-text-align-center" style="color:#9a8a82;font-family:Lora;font-size:16px">Simple, delicious recipes for everyday kitchens</p>
<!-- /wp:paragraph -->

</div>
<!-- /wp:group -->`;

// ════════════════════════════════════════════
// SECTION 2: LATEST RECIPES (wp:query loop — proper grid)
// ════════════════════════════════════════════
const latestRecipes = `
<!-- wp:group {"style":{"spacing":{"padding":{"top":"50px","bottom":"50px","left":"24px","right":"24px"}},"color":{"background":"#ffffff"}},"layout":{"type":"constrained","contentSize":"1100px"}} -->
<div class="wp-block-group has-background" style="background-color:#ffffff;padding-top:50px;padding-right:24px;padding-bottom:50px;padding-left:24px">

<!-- wp:heading {"textAlign":"center","style":{"typography":{"fontSize":"30px","fontWeight":"700","fontFamily":"Playfair Display"},"color":{"text":"#3a2a24"},"spacing":{"margin":{"bottom":"32px"}}}} -->
<h2 class="wp-block-heading has-text-align-center" style="color:#3a2a24;margin-bottom:32px;font-family:Playfair Display;font-size:30px;font-weight:700">Latest Recipes</h2>
<!-- /wp:heading -->

<!-- wp:query {"queryId":1,"query":{"perPage":8,"pages":0,"offset":0,"postType":"post","order":"desc","orderBy":"date","author":"","search":"","exclude":[],"sticky":"","inherit":false},"displayLayout":{"type":"flex","columns":4}} -->
<div class="wp-block-query">
<!-- wp:post-template {"style":{"spacing":{"blockGap":"24px"}},"layout":{"type":"grid","columnCount":4}} -->

<!-- wp:group {"style":{"spacing":{"padding":{"bottom":"16px"}},"border":{"radius":"12px"},"color":{"background":"#faf5f2"}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group has-background" style="border-radius:12px;background-color:#faf5f2;padding-bottom:16px">

<!-- wp:post-featured-image {"isLink":true,"style":{"border":{"radius":{"topLeft":"12px","topRight":"12px"}}}} /-->

<!-- wp:post-title {"textAlign":"center","level":3,"isLink":true,"style":{"typography":{"fontSize":"15px","fontWeight":"600","fontFamily":"Playfair Display"},"color":{"text":"#3a2a24"},"spacing":{"padding":{"left":"12px","right":"12px"},"margin":{"top":"10px"}},"elements":{"link":{"color":{"text":"#3a2a24"}}}}} /-->

</div>
<!-- /wp:group -->

<!-- /wp:post-template -->

<!-- wp:query-no-results -->
<!-- wp:paragraph {"align":"center","style":{"color":{"text":"#9a8a82"}}} -->
<p class="has-text-align-center" style="color:#9a8a82">No recipes yet — check back soon!</p>
<!-- /wp:paragraph -->
<!-- /wp:query-no-results -->
</div>
<!-- /wp:query -->

</div>
<!-- /wp:group -->`;

// ════════════════════════════════════════════
// SECTION 3: ABOUT AMELIA
// ════════════════════════════════════════════
const about = `
<!-- wp:group {"style":{"spacing":{"padding":{"top":"50px","bottom":"50px","left":"24px","right":"24px"}},"color":{"background":"#faf5f2"}},"layout":{"type":"constrained","contentSize":"650px"}} -->
<div class="wp-block-group has-background" style="background-color:#faf5f2;padding-top:50px;padding-right:24px;padding-bottom:50px;padding-left:24px">

<!-- wp:columns {"verticalAlignment":"center","style":{"spacing":{"blockGap":{"left":"32px"}}}} -->
<div class="wp-block-columns are-vertically-aligned-center">

<!-- wp:column {"verticalAlignment":"center","width":"35%"} -->
<div class="wp-block-column is-vertically-aligned-center" style="flex-basis:35%">
<!-- wp:image {"id":367,"sizeSlug":"medium","linkDestination":"none","style":{"border":{"radius":"14px"}}} -->
<figure class="wp-block-image size-medium" style="border-radius:14px"><img src="https://leagueofcooking.com/wp-content/uploads/2026/03/big-image-2.jpg" alt="Amelia Bernik" class="wp-image-367" style="border-radius:14px"/></figure>
<!-- /wp:image -->
</div>
<!-- /wp:column -->

<!-- wp:column {"verticalAlignment":"center","width":"65%"} -->
<div class="wp-block-column is-vertically-aligned-center" style="flex-basis:65%">

<!-- wp:heading {"style":{"typography":{"fontSize":"26px","fontWeight":"700","fontFamily":"Playfair Display"},"color":{"text":"#3a2a24"},"spacing":{"margin":{"bottom":"4px"}}}} -->
<h2 class="wp-block-heading" style="color:#3a2a24;margin-bottom:4px;font-family:Playfair Display;font-size:26px;font-weight:700">Hi, I'm Amelia!</h2>
<!-- /wp:heading -->

<!-- wp:paragraph {"style":{"typography":{"fontSize":"13px","fontFamily":"Lora"},"color":{"text":"#c9a89c"},"spacing":{"margin":{"top":"0px","bottom":"12px"}}}} -->
<p style="color:#c9a89c;margin-top:0px;margin-bottom:12px;font-family:Lora;font-size:13px">Founder of League of Cooking</p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"style":{"typography":{"fontSize":"15px","fontFamily":"Lora","lineHeight":"1.7"},"color":{"text":"#5a5a5a"}}} -->
<p style="color:#5a5a5a;font-family:Lora;font-size:15px;line-height:1.7">I share simple, delicious recipes designed for everyday kitchens. From quick breakfasts to comforting dinners and sweet desserts, you will find meals anyone can cook and everyone will love.</p>
<!-- /wp:paragraph -->

<!-- wp:buttons -->
<div class="wp-block-buttons">
<!-- wp:button {"style":{"color":{"background":"#c9a89c","text":"#ffffff"},"border":{"radius":"20px"},"typography":{"fontSize":"13px","fontFamily":"Lora"},"spacing":{"padding":{"top":"8px","bottom":"8px","left":"24px","right":"24px"}}}} -->
<div class="wp-block-button" style="font-family:Lora;font-size:13px"><a class="wp-block-button__link has-text-color has-background wp-element-button" href="/about/" style="border-radius:20px;color:#ffffff;background-color:#c9a89c;padding-top:8px;padding-right:24px;padding-bottom:8px;padding-left:24px">Read More</a></div>
<!-- /wp:button -->
</div>
<!-- /wp:buttons -->

</div>
<!-- /wp:column -->

</div>
<!-- /wp:columns -->

</div>
<!-- /wp:group -->`;

// ════════════════════════════════════════════
// SECTION 4: BROWSE BY CATEGORY
// ════════════════════════════════════════════
function categoryCard(name, catId, slug) {
  return `
<!-- wp:column -->
<div class="wp-block-column">
<!-- wp:group {"style":{"color":{"background":"#faf5f2"},"border":{"radius":"12px"},"spacing":{"padding":{"top":"20px","bottom":"20px","left":"16px","right":"16px"}}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group has-background" style="border-radius:12px;background-color:#faf5f2;padding-top:20px;padding-right:16px;padding-bottom:20px;padding-left:16px">

<!-- wp:heading {"textAlign":"center","level":3,"style":{"typography":{"fontSize":"20px","fontFamily":"Playfair Display","fontWeight":"600"},"color":{"text":"#c9a89c"},"spacing":{"margin":{"bottom":"16px"}}}} -->
<h3 class="wp-block-heading has-text-align-center" style="color:#c9a89c;margin-bottom:16px;font-family:Playfair Display;font-size:20px;font-weight:600"><a href="/category/${slug}/">${name}</a></h3>
<!-- /wp:heading -->

<!-- wp:query {"queryId":${catId},"query":{"perPage":2,"postType":"post","order":"desc","orderBy":"date","taxQuery":{"category":[${catId}]},"inherit":false}} -->
<div class="wp-block-query">
<!-- wp:post-template {"layout":{"type":"default"}} -->
<!-- wp:post-featured-image {"isLink":true,"height":"140px","style":{"border":{"radius":"8px"},"spacing":{"margin":{"bottom":"8px"}}}} /-->
<!-- wp:post-title {"textAlign":"center","level":4,"isLink":true,"style":{"typography":{"fontSize":"13px","fontWeight":"600","fontFamily":"Lora"},"color":{"text":"#3a2a24"},"elements":{"link":{"color":{"text":"#3a2a24"}}}}} /-->
<!-- /wp:post-template -->
<!-- wp:query-no-results -->
<!-- wp:paragraph {"align":"center","style":{"color":{"text":"#bbb"},"typography":{"fontSize":"13px"}}} -->
<p class="has-text-align-center" style="color:#bbb;font-size:13px">Coming soon</p>
<!-- /wp:paragraph -->
<!-- /wp:query-no-results -->
</div>
<!-- /wp:query -->

</div>
<!-- /wp:group -->
</div>
<!-- /wp:column -->`;
}

const categories = `
<!-- wp:group {"style":{"spacing":{"padding":{"top":"50px","bottom":"50px","left":"24px","right":"24px"}},"color":{"background":"#ffffff"}},"layout":{"type":"constrained","contentSize":"1100px"}} -->
<div class="wp-block-group has-background" style="background-color:#ffffff;padding-top:50px;padding-right:24px;padding-bottom:50px;padding-left:24px">

<!-- wp:heading {"textAlign":"center","style":{"typography":{"fontSize":"30px","fontWeight":"700","fontFamily":"Playfair Display"},"color":{"text":"#3a2a24"},"spacing":{"margin":{"bottom":"32px"}}}} -->
<h2 class="wp-block-heading has-text-align-center" style="color:#3a2a24;margin-bottom:32px;font-family:Playfair Display;font-size:30px;font-weight:700">Browse by Category</h2>
<!-- /wp:heading -->

<!-- wp:columns {"style":{"spacing":{"blockGap":{"left":"20px"}}}} -->
<div class="wp-block-columns">
${categoryCard('Breakfast', 4, 'breakfast')}
${categoryCard('Lunch', 6, 'lunch')}
${categoryCard('Dinner', 5, 'dinner')}
${categoryCard('Dessert', 7, 'dessert')}
</div>
<!-- /wp:columns -->

</div>
<!-- /wp:group -->`;

// ════════════════════════════════════════════
// SECTION 5: CTA
// ════════════════════════════════════════════
const cta = `
<!-- wp:group {"style":{"spacing":{"padding":{"top":"50px","bottom":"50px","left":"24px","right":"24px"}},"color":{"background":"#f5e6e0"}},"layout":{"type":"constrained","contentSize":"550px"}} -->
<div class="wp-block-group has-background" style="background-color:#f5e6e0;padding-top:50px;padding-right:24px;padding-bottom:50px;padding-left:24px">

<!-- wp:heading {"textAlign":"center","style":{"typography":{"fontSize":"28px","fontWeight":"700","fontFamily":"Playfair Display"},"color":{"text":"#3a2a24"},"spacing":{"margin":{"bottom":"10px"}}}} -->
<h2 class="wp-block-heading has-text-align-center" style="color:#3a2a24;margin-bottom:10px;font-family:Playfair Display;font-size:28px;font-weight:700">Find Your Next Favorite Recipe</h2>
<!-- /wp:heading -->

<!-- wp:paragraph {"align":"center","style":{"typography":{"fontSize":"15px","fontFamily":"Lora"},"color":{"text":"#6a5a52"},"spacing":{"margin":{"bottom":"20px"}}}} -->
<p class="has-text-align-center" style="color:#6a5a52;margin-bottom:20px;font-family:Lora;font-size:15px">Explore simple recipes you can cook today using everyday ingredients</p>
<!-- /wp:paragraph -->

<!-- wp:buttons {"layout":{"type":"flex","justifyContent":"center"}} -->
<div class="wp-block-buttons">
<!-- wp:button {"style":{"color":{"background":"#c9a89c","text":"#ffffff"},"border":{"radius":"22px"},"typography":{"fontSize":"14px","fontFamily":"Lora"},"spacing":{"padding":{"top":"10px","bottom":"10px","left":"28px","right":"28px"}}}} -->
<div class="wp-block-button" style="font-family:Lora;font-size:14px"><a class="wp-block-button__link has-text-color has-background wp-element-button" href="/recipes/" style="border-radius:22px;color:#ffffff;background-color:#c9a89c;padding-top:10px;padding-right:28px;padding-bottom:10px;padding-left:28px">Browse All Recipes</a></div>
<!-- /wp:button -->
</div>
<!-- /wp:buttons -->

</div>
<!-- /wp:group -->`;

// ════════════════════════════════════════════
// BUILD
// ════════════════════════════════════════════
const fullContent = [hero, latestRecipes, about, categories, cta].join('\n\n');
await updatePage(fullContent, { meta: { _kad_post_title: 'hide' } });
console.log('Home 3 built with all 5 sections!');
