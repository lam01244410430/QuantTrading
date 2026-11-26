import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        surface: "var(--surface)",
        "surface-subtle": "var(--surface-subtle)",
        text: "var(--text)",
        "text-muted": "var(--text-muted)",
        border: "var(--border)",
        "border-strong": "var(--border-strong)",
        accent: "var(--accent)",
        "accent-fg": "var(--accent-fg)",
        "primary-action": "var(--primary-action)",
        "primary-action-fg": "var(--primary-action-fg)",
        positive: "var(--positive)",
        "positive-bg": "var(--positive-bg)",
        negative: "var(--negative)",
        "negative-bg": "var(--negative-bg)",
        warning: "var(--warning)",
        "warning-bg": "var(--warning-bg)",
      },
      borderRadius: {
        DEFAULT: "var(--radius)",
        md: "var(--radius)",
        lg: "var(--radius)",
      },
      fontFamily: {
        sans: ["var(--font)"],
        serif: ["var(--font-heading)"],
        mono: ["var(--font-mono)"],
      },
    },
  },
  plugins: [],
};

export default config;
