/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    './node_modules/konsta/**/*.{js,mjs,cjs}',
  ],
  // Hook Tailwind's dark variant to our existing data-theme="dark" attribute
  // (set by src/lib/theme.ts). Falls back to media query if attribute absent.
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {},
  },
  plugins: [],
};
