import type { ThemeConfig } from "antd";
import type { ThemeMode } from "./theme";

/**
 * One place for the console's look. Neutral surfaces do the structural work
 * (borders, not shadows); the single accent is reserved for the primary action,
 * the active tab and keyboard focus. Status colors are muted so tables full of
 * "ready / cooling / error" tags stay calm.
 */
const PALETTE = {
  dark: {
    layout: "#13161B",
    container: "#1A1E25",
    elevated: "#21262E",
    border: "#2B313B",
    borderSoft: "#242A33",
    text: "#E8EBF0",
    textSecondary: "#A3ABB8",
    textTertiary: "#727B8A",
    accent: "#6F94FF",
    success: "#43B58C",
    warning: "#E0A344",
    error: "#E5675F",
    hover: "rgba(255,255,255,0.035)",
  },
  light: {
    layout: "#F4F5F7",
    container: "#FFFFFF",
    elevated: "#FFFFFF",
    border: "#DFE2E8",
    borderSoft: "#E9ECF0",
    text: "#161A20",
    textSecondary: "#5A6270",
    textTertiary: "#8A919D",
    accent: "#3F63E8",
    success: "#1F8F68",
    warning: "#B97A12",
    error: "#CC443C",
    hover: "rgba(20,26,36,0.035)",
  },
} as const;

// System stacks only: the page CSP (default-src 'none') blocks web-font downloads.
export const FONT_SANS =
  "'Segoe UI Variable Text', 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, 'Helvetica Neue', Arial, sans-serif";
export const FONT_MONO =
  "'Cascadia Mono', ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

export function buildTheme(mode: ThemeMode): ThemeConfig {
  const c = PALETTE[mode];
  return {
    token: {
      colorPrimary: c.accent,
      colorInfo: c.accent,
      colorSuccess: c.success,
      colorWarning: c.warning,
      colorError: c.error,
      colorBgLayout: c.layout,
      colorBgContainer: c.container,
      colorBgElevated: c.elevated,
      colorBorder: c.border,
      colorBorderSecondary: c.borderSoft,
      colorSplit: c.borderSoft,
      colorText: c.text,
      colorTextSecondary: c.textSecondary,
      colorTextTertiary: c.textTertiary,
      colorTextQuaternary: c.textTertiary,
      fontFamily: FONT_SANS,
      fontFamilyCode: FONT_MONO,
      fontSize: 14,
      lineHeight: 1.5,
      borderRadius: 6,
      borderRadiusSM: 4,
      borderRadiusLG: 10,
      controlHeight: 34,
      controlHeightSM: 28,
      boxShadow: "none",
      boxShadowSecondary:
        mode === "dark"
          ? "0 8px 24px rgba(0,0,0,0.45)"
          : "0 8px 24px rgba(20,26,36,0.12)",
      boxShadowTertiary: "none",
      motionDurationMid: "0.15s",
    },
    components: {
      Card: {
        colorBorderSecondary: c.borderSoft,
        headerFontSize: 14,
        headerFontSizeSM: 14,
        paddingSM: 16,
      },
      Table: {
        headerBg: "transparent",
        headerColor: c.textSecondary,
        headerSplitColor: "transparent",
        borderColor: c.borderSoft,
        rowHoverBg: c.hover,
        cellPaddingBlock: 12,
        cellPaddingInline: 16,
        cellPaddingBlockSM: 8,
        cellPaddingInlineSM: 12,
        cellFontSize: 13.5,
      },
      Button: {
        primaryShadow: "none",
        defaultShadow: "none",
        dangerShadow: "none",
        fontWeight: 500,
        paddingInline: 14,
      },
      Tag: { defaultBg: "transparent" },
      Modal: { contentBg: c.elevated, headerBg: c.elevated, titleFontSize: 16 },
      Statistic: { titleFontSize: 13, contentFontSize: 24 },
    },
  };
}

/** Global CSS the token system can't express. Injected once from main.tsx. */
export const GLOBAL_CSS = `
html, body { background: var(--router-bg); }
body { font-feature-settings: 'cv11', 'ss01'; -webkit-font-smoothing: antialiased; }
/* Numbers line up in columns and don't jitter while live values tick. */
.ant-table-cell, .ant-statistic-content, .ant-tag { font-variant-numeric: tabular-nums; }
/* Env names, URLs, model ids. */
code, .ant-typography code, kbd { font-family: ${FONT_MONO}; font-size: 0.86em; }
/* Never wrap the brand mark in the header. */
header img { flex: none; }
::selection { background: color-mix(in srgb, var(--router-accent) 35%, transparent); }
:focus-visible { outline: 2px solid var(--router-accent); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
`;

export function cssVars(mode: ThemeMode): string {
  const c = PALETTE[mode];
  return `:root { --router-bg: ${c.layout}; --router-accent: ${c.accent}; color-scheme: ${mode}; }`;
}
