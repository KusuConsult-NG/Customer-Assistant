/** @type {import('tailwindcss').Config} */

// The brand ramp is measured, not picked by eye. Every pair the UI actually
// renders is asserted in apps/api/test/palette-contrast.spec.ts — change a
// value here and that test tells you which role stopped passing WCAG AA.
//
// The roles, and why the steps sit where they do:
//   600  solid fill under white text            4.94:1 on #fff  (AA normal)
//   700  hover/active fill, and brand text on a light surface
//   300  brand text on a dark surface          11.32:1 on surface-card
//   400  icons and borders on a dark surface
//   500  the original mark colour — decorative tints only, never under text
//
// Hover DARKENS (600 -> 700). The palette this replaced went the other way:
// `bg-[#558A02] hover:bg-[#74BA03] text-white` lifted the fill to #74BA03,
// where white text measures 2.40:1 — so every primary button in the app
// failed AA at the exact moment the pointer was on it, and failed it worse
// than at rest (4.18:1, itself under the 4.5 line).
const brand = {
  50: '#f5faea',
  100: '#e7f4c9',
  200: '#d0e999',
  300: '#b0d95f',
  400: '#8fc22c',
  500: '#74ba03',
  600: '#4d7d02',
  700: '#3b6102',
  800: '#2b4703',
  900: '#1a2c02',
  950: '#0d1708',
};

// The green-tinted dark surfaces, which were six near-identical hexes spread
// across the pages that use them.
const surface = {
  canvas: '#070d04',
  card: '#0d1708',
  raised: '#14240c',
  border: '#1c3310',
  muted: '#284717',
};

module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand,
        surface,
        // `indigo`, `blue` and `purple` were each redefined to the ramp above.
        // That is deliberately NOT done any more. It made three semantic
        // families render as one green: scheduling draws booking chips blue
        // and reservation chips purple, so the two statuses were the same
        // colour on screen, and every `text-blue-600` in the app — toast
        // info icons, ticket references, focus rings — came out acid green.
        // Anything that genuinely means "the brand" names `brand-*`.
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
