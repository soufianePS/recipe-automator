/**
 * List Styles — modern numbered/iconic list markers for recipe posts.
 *
 * Each style generates CSS that targets `.entry-content ul` in WordPress.
 * The CSS is meant to be pasted into Appearance > Customize > Additional CSS.
 * Works retroactively on all existing posts since it targets all lists in post content.
 */

export const LIST_STYLES = {
  'default': {
    label: 'Default (plain dots)',
    description: 'Standard bullet points — no custom styling',
    css: '/* No custom list styles — uses theme default. */'
  },

  'rose-circle': {
    label: 'Rose Circle',
    description: 'Dusty pink filled circle with white numbers',
    css: `
/* Rose Circle list style */
.entry-content ul { counter-reset: li-item; list-style: none; padding-left: 0; }
.entry-content ul li { counter-increment: li-item; position: relative; padding-left: 42px; margin-bottom: 10px; min-height: 28px; }
.entry-content ul li::before {
  content: counter(li-item);
  position: absolute;
  left: 0;
  top: 2px;
  width: 28px;
  height: 28px;
  background: #c9879b;
  color: #ffffff;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 13px;
  font-family: 'Inter', sans-serif;
  line-height: 1;
}`.trim()
  },

  'navy-circle': {
    label: 'Navy Circle',
    description: 'Dark navy filled circle with white numbers (professional)',
    css: `
/* Navy Circle list style */
.entry-content ul { counter-reset: li-item; list-style: none; padding-left: 0; }
.entry-content ul li { counter-increment: li-item; position: relative; padding-left: 42px; margin-bottom: 10px; min-height: 28px; }
.entry-content ul li::before {
  content: counter(li-item);
  position: absolute;
  left: 0;
  top: 2px;
  width: 28px;
  height: 28px;
  background: #1e2d4a;
  color: #ffffff;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 13px;
  line-height: 1;
}`.trim()
  },

  'green-check': {
    label: 'Green Check',
    description: 'Green circle with white checkmark (wellness vibe)',
    css: `
/* Green Check list style */
.entry-content ul { list-style: none; padding-left: 0; }
.entry-content ul li { position: relative; padding-left: 38px; margin-bottom: 10px; min-height: 26px; }
.entry-content ul li::before {
  content: '✓';
  position: absolute;
  left: 0;
  top: 2px;
  width: 24px;
  height: 24px;
  background: #4caf50;
  color: #ffffff;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 14px;
  line-height: 1;
}`.trim()
  },

  'number-pill': {
    label: 'Number Pill',
    description: '"01", "02" in rounded rectangle pill (magazine style)',
    css: `
/* Number Pill list style */
.entry-content ul { counter-reset: li-item; list-style: none; padding-left: 0; }
.entry-content ul li { counter-increment: li-item; position: relative; padding-left: 52px; margin-bottom: 12px; min-height: 26px; }
.entry-content ul li::before {
  content: "0" counter(li-item);
  position: absolute;
  left: 0;
  top: 2px;
  padding: 3px 10px;
  background: #2a2a2a;
  color: #ffffff;
  border-radius: 6px;
  font-weight: 700;
  font-size: 12px;
  letter-spacing: 0.5px;
  line-height: 1.4;
  font-family: 'Inter', sans-serif;
}`.trim()
  },

  'gradient-circle': {
    label: 'Gradient Circle',
    description: 'Pink-to-orange gradient circle (vibrant)',
    css: `
/* Gradient Circle list style */
.entry-content ul { counter-reset: li-item; list-style: none; padding-left: 0; }
.entry-content ul li { counter-increment: li-item; position: relative; padding-left: 44px; margin-bottom: 10px; min-height: 30px; }
.entry-content ul li::before {
  content: counter(li-item);
  position: absolute;
  left: 0;
  top: 1px;
  width: 30px;
  height: 30px;
  background: linear-gradient(135deg, #ff6e7f 0%, #ff9966 100%);
  color: #ffffff;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 13px;
  line-height: 1;
  box-shadow: 0 2px 4px rgba(255, 105, 127, 0.3);
}`.trim()
  },

  'outline-circle': {
    label: 'Outline Circle',
    description: 'White circle with pink border and pink number (minimal)',
    css: `
/* Outline Circle list style */
.entry-content ul { counter-reset: li-item; list-style: none; padding-left: 0; }
.entry-content ul li { counter-increment: li-item; position: relative; padding-left: 42px; margin-bottom: 10px; min-height: 28px; }
.entry-content ul li::before {
  content: counter(li-item);
  position: absolute;
  left: 0;
  top: 2px;
  width: 26px;
  height: 26px;
  background: #ffffff;
  color: #c9879b;
  border: 2px solid #c9879b;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 13px;
  line-height: 1;
  box-sizing: border-box;
}`.trim()
  },

  'gold-star': {
    label: 'Gold Star',
    description: 'Gold star badge (rating/highlight feel)',
    css: `
/* Gold Star list style */
.entry-content ul { list-style: none; padding-left: 0; }
.entry-content ul li { position: relative; padding-left: 34px; margin-bottom: 10px; min-height: 24px; }
.entry-content ul li::before {
  content: '★';
  position: absolute;
  left: 0;
  top: 0;
  color: #f4b400;
  font-size: 22px;
  line-height: 1.2;
}`.trim()
  },

  'arrow-bullet': {
    label: 'Arrow Bullet',
    description: 'Small right-arrow instead of dots (sleek)',
    css: `
/* Arrow Bullet list style */
.entry-content ul { list-style: none; padding-left: 0; }
.entry-content ul li { position: relative; padding-left: 26px; margin-bottom: 8px; }
.entry-content ul li::before {
  content: '›';
  position: absolute;
  left: 0;
  top: -4px;
  color: #c9879b;
  font-size: 22px;
  font-weight: 700;
  line-height: 1;
}`.trim()
  }
};

/**
 * Get CSS for a given style key. Falls back to 'default' if key is unknown.
 */
export function getListStyleCSS(styleKey) {
  const style = LIST_STYLES[styleKey] || LIST_STYLES['default'];
  return style.css;
}

/**
 * Get all style options as a sorted array for the dashboard dropdown.
 */
export function getListStyleOptions() {
  return Object.entries(LIST_STYLES).map(([key, val]) => ({
    key,
    label: val.label,
    description: val.description
  }));
}
