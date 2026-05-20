import konstaConfig from 'konsta/config';

/** @type {import('tailwindcss').Config} */
export default konstaConfig({
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    './node_modules/konsta/**/*.{js,mjs,cjs}',
  ],
  // Tailwind dark variants follow Konsta's <App dark> prop, which sets a
  // `.k-color-scheme-dark` class. Our theme store also writes
  // [data-theme="dark"] on <html> — list both so explicit user override
  // wins regardless of class location.
  darkMode: ['class', '[data-theme="dark"]', '.k-color-scheme-dark'],
  theme: {
    extend: {},
  },
  plugins: [],
});
