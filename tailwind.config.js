/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        gesfin: {
          bg: "#080B12",
          card: "#0E1420",
          cardAlt: "#141C2E",
          accent: "#00E5A0",
          purple: "#7B61FF",
          red: "#FF6B6B",
          text: "#F0F4FF",
          muted: "#8892AA",
          border: "#1E2D45",
        },
      },
      fontFamily: {
        sans: ["Space Grotesk", "system-ui", "sans-serif"],
        mono: ["Space Mono", "monospace"],
      },
    },
  },
  plugins: [],
};
