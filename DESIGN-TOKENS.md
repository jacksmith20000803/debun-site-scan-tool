# Pentest-Tools visual reference tokens

**Inspection date:** 2026-10-18  
**Scope:** Public sign-in route and CSS bundles loaded by that route, plus a visual inspection of the authenticated dashboard in the browser session. The public root resolves to `/login`. In the authenticated browser session, `/login` redirected to `/dashboard`. The page and bundle values below are recorded from the prior computed-style and CSS-rule inspection; dashboard-specific numeric values are called out as unverified rather than inferred.

## Sources inspected

- [Application sign-in page](https://app.pentest-tools.com/login)
- [Application stylesheet](https://app.pentest-tools.com/build/assets/app-0WJcJxWc.css)
- [Guest header stylesheet](https://app.pentest-tools.com/build/assets/GuestTopbar-CEFzJGkc.css)
- [Button component stylesheet](https://app.pentest-tools.com/build/assets/BaseButton-BlU5CNHK.css)
- [Alert component stylesheet](https://app.pentest-tools.com/build/assets/Alert-Cq3cA6b1.css)
- [Tooltip stylesheet](https://app.pentest-tools.com/build/assets/tippy-Lcq2UOUK.css)
- [Guest page stylesheet](https://app.pentest-tools.com/build/assets/guest-D0VfJbfD.css)

## Verified CSS custom properties

The first group reflects elements actually rendered on the public sign-in page. The status colors come from the loaded alert component stylesheet. Named palette entries below are present in the application bundle; a palette entry alone does not establish which authenticated dashboard surface uses it.

```css
:root {
  /* Public sign-in surfaces */
  --ptt-public-page: #262626;
  --ptt-public-card: #ffffff;
  --ptt-public-input: #f8fafb;
  --ptt-public-input-focus: #ffffff;

  /* Text, links, borders, and focus */
  --ptt-text-primary: #404040;
  --ptt-text-input: #001e4a;
  --ptt-text-secondary: #4d70a3;
  --ptt-text-placeholder: #99adcb;
  --ptt-link: #2a76d1;
  --ptt-border-default: #e5e7eb;
  --ptt-border-input: #bfccde;
  --ptt-focus-ring: #b4d6ff;

  /* Brand and action colors */
  --ptt-brand-blue: #3e94ff;
  --ptt-brand-green: #00ca82;
  --ptt-accent-coral: #fa8072;
  --ptt-accent-yellow: #f1c40f;

  /* Alert component states */
  --ptt-info-bg: #ecf4ff;
  --ptt-info-border: #3e94ff;
  --ptt-info-text: #3276cc;
  --ptt-success-bg: #f5fffc;
  --ptt-success-border: #00794e;
  --ptt-success-text: #00794e;
  --ptt-warning-bg: #fffbf5;
  --ptt-warning-border: #ff9b26;
  --ptt-warning-text: #cc7c1e;
  --ptt-danger-bg: #fff6f6;
  --ptt-danger-border: #c94343;
  --ptt-danger-text: #973232;
  --ptt-neutral-bg: #f3f4f6;
  --ptt-neutral-text: rgba(0, 0, 0, 0.75);
  --ptt-neutral-border: rgba(0, 0, 0, 0.4);

  /* Typography */
  --ptt-font-sans: Inter, ui-sans-serif, system-ui, sans-serif;
  --ptt-font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
    "Liberation Mono", "Courier New", monospace;
  --ptt-font-body-size: 16px;
  --ptt-font-body-line-height: 24px;
  --ptt-font-heading-1-size: 24px;
  --ptt-font-heading-1-line-height: 32px;
  --ptt-font-heading-2-size: 20px;
  --ptt-font-heading-2-line-height: 30px;
  --ptt-font-heading-3-size: 18px;
  --ptt-font-heading-3-line-height: 28px;
  --ptt-font-paragraph-size: 14px;
  --ptt-font-paragraph-line-height: 22px;
  --ptt-font-caption-size: 12px;
  --ptt-font-caption-line-height: 18px;

  /* Public sign-in component geometry */
  --ptt-topbar-height: 64px;
  --ptt-card-radius: 12px;
  --ptt-input-radius: 4px;
  --ptt-button-radius: 4px;
  --ptt-control-height: 40px;
  --ptt-card-padding: 24px;
  --ptt-form-width: 400px;
  --ptt-control-transition: 150ms;
  --ptt-card-shadow:
    0 20px 25px -5px rgb(0 0 0 / 0.1),
    0 8px 10px -6px rgb(0 0 0 / 0.1);
}
```

## Available named palette ramps

These color values were read from named utility rules in the loaded application CSS. They are listed as palette entries, not assigned to unobserved sidebar/card/dashboard roles.

| Palette | CSS values observed |
| --- | --- |
| Dark blue | `25 #f8fafb`, `50 #f2f5f8`, `100 #e6ebf2`, `200 #bfccde`, `300 #99adcb`, `400 #4d70a3`, `500 #00327c`, `700 #00265d`, `800 #001e4a` |
| Light blue | `50 #f4f8fd`, `100 #ecf5ff`, `200 #b4d6ff`, `300 #7db8ff`, `400 #4497fa`, `500 #2a76d1`, `700 #20599d`, `800 #19477d`, `900 #153a66` |
| Brand blue | `50 #ecf4ff`, `200 #b2d4ff`, `500 #3e94ff`, `600 #3276cc`, `700 #255999` |
| Brand green | `25 #f5fffc`, `50 #e6faf3`, `500 #00ca82`, `600 #00a268`, `700 #00794e` |
| Brand orange | `25 #fffbf5`, `50 #fff5e9`, `500 #ff9b26`, `600 #cc7c1e` |
| Brand red | `25 #fff6f6`, `500 #fb5454`, `600 #c94343` |
| Risk colors | Blue `#3e94ff`; green `#00ca82`; orange `#ff9b26`; red `#fb5454`; maroon `#973232` |
| Primary accent | `50 #fff9f8`, `100 #fff2f1`, `200 #fedfdc`, `400 #fca69c`, `500 #fa8072`, `700 #bc6056` |
| Secondary accent | `50 #fefcf3`, `100 #fef9e7`, `300 #f9e79f`, `400 #f5d657`, `500 #f1c40f`, `900 #766007` |
| Neutral utilities | `50 #fafafa`, `100 #f5f5f5`, `200 #e5e5e5`, `300 #d4d4d4`, `400 #a3a3a3`, `500 #737373`, `600 #525252`, `700 #404040`, `800 #262626`, `900 #171717` |

The bundle also contains generic gray utilities. The public login card does not establish those grays as authenticated-dashboard surfaces.

## Typography and spacing

- Font family: Inter, followed by the system sans-serif stack. The CSS reset defines the monospace stack shown above for `code`, `pre`, and related elements.
- Base text: `16px / 24px`, weight `400`.
- Heading classes: heading 1 `24px / 32px, 600`; heading 2 `20px / 30px, 600`; heading 3 `18px / 28px, 600`.
- Paragraph classes: `14px / 22px`, with regular `400`, medium `500`, and semibold `600` variants.
- Caption classes: `12px / 18px`, with regular `400`, medium `500`, semibold `600`, and black `900` variants.
- Observed spacing values include `4px`, `6px`, `8px`, `12px`, `16px`, `24px`, `32px`, and `48px`. The public login form uses a `32px` vertical gap; its card uses `24px` padding and increases to `48px` at the large breakpoint.
- Compiled container breakpoints: `640px`, `768px`, `1024px`, `1280px`, `1440px`, `1536px`, and `1920px`. These are container utility breakpoints; they do not prove dashboard sidebar collapse behavior.

## Component measurements available from the public route

| Component | Verified styling |
| --- | --- |
| Guest/top bar | CSS custom property `--topbar-height: 64px`; the guest stylesheet maps the safe top space to this value. |
| Sign-in card | White background, `12px` radius, `24px` padding (`48px` at large widths), Tailwind `shadow-xl`; form max width `400px`. |
| Inputs/selects | `40px` rendered height; `4px` radius; default fill `#f8fafb`; input text `#001e4a`; inset border/ring `#bfccde`; focus fill white with a `3px` `#b4d6ff` ring; desktop input text `14px / 22px`; common input padding `9px 14px`. |
| Primary sign-in button | `40px` height, `4px` radius, `8px 12px` padding, `14px / 24px`, weight `600`; yellow fill `#f1c40f`, hover fill `#f9e79f`. This is the login action’s observed styling. |
| Secondary/ghost controls | Shared button rules include `4px` radius and `150ms` transitions. The visible carousel links include a dark-mode ghost variant with white text at 75%, white/15% ring, and white/5% hover/focus fill. |
| Tooltip | Tippy rule: `#333` background, white text, `4px` radius, `14px / 1.4`, `5px 9px` content padding. |
| Progress | NProgress rule: `2px` top bar in `#2299dd`; spinner `18px`, `2px` border, `400ms` rotation. |
| Tables | Compiled table utilities include body fill `#f9fafb` and expanded subrow fill `#fdfdfd`. No table was rendered on the public route, so row separators, sticky-header behavior, and hover color are not confirmed. |
| Alerts | Info, confirmation/success, warning, error/danger, and neutral colors are captured in the token block above from the loaded `Alert` stylesheet. |

## Dashboard inspection and unresolved values

The authenticated dashboard was visible in the browser session at `/dashboard`. It has a dark top bar, but the page canvas, navigation strip, and dashboard cards are light. The active navigation indicator is blue; the account-upgrade control is yellow; and the scan-activity progress bar is orange. This live dashboard is **not a dark-theme-by-default interface**. The public sign-in page uses a dark `#262626` outer background and a white sign-in card, so the reference itself uses different surface treatments across routes.

The screenshot-level inspection does not establish exact CSS measurements. The following dashboard-specific values therefore remain **unverified** and must not be guessed: sidebar width and collapsed states; top-bar height; authenticated card and panel colors; table striping, separators, row hover, and sticky-header behavior; exact severity chip mapping for Critical/High/Medium/Low; modal surface/radius/shadow; and responsive sidebar collapse/hide breakpoints. The compiled stylesheet includes a `--sidebar-width` reference, but the public route styles inspected earlier do not define its value.

## Step 2 implementation mapping

The requested default dark appearance is implemented as an adaptation using only neutral and accent colors already recorded from the reference CSS. This honors the explicit dark-theme requirement while keeping the dashboard's deviation from the mostly light live reference visible in this document. No additional color values were introduced.

```css
:root {
  --color-page: var(--ptt-neutral-900);       /* #171717 */
  --color-sidebar: var(--ptt-neutral-800);    /* #262626 */
  --color-panel: var(--ptt-neutral-800);      /* #262626 */
  --color-card: var(--ptt-neutral-700);       /* #404040 */
  --color-control: var(--ptt-neutral-900);    /* #171717 */
  --color-border: var(--ptt-neutral-600);     /* #525252 */
  --color-text-primary: var(--ptt-blue-25);   /* #f8fafb */
  --color-text-secondary: var(--ptt-neutral-200); /* #e5e5e5 */
  --color-text-muted: var(--ptt-neutral-400); /* #a3a3a3 */
  --color-accent: var(--ptt-brand-blue-500);  /* #3e94ff */
  --color-action: var(--ptt-accent-yellow-500); /* #f1c40f */
  --color-success: var(--ptt-brand-green-500); /* #00ca82 */
  --color-warning: var(--ptt-brand-orange-500); /* #ff9b26 */
  --color-danger: var(--ptt-brand-red-500);   /* #fb5454 */
  --color-info: var(--ptt-brand-blue-500);    /* #3e94ff */
  --color-severity-critical: var(--ptt-brand-red-500); /* #fb5454 */
  --color-severity-high: var(--ptt-brand-orange-500); /* #ff9b26 */
  --color-severity-medium: var(--ptt-accent-yellow-500); /* #f1c40f */
  --color-severity-low: var(--ptt-brand-green-500); /* #00ca82 */
  --color-severity-info: var(--ptt-brand-blue-500); /* #3e94ff */
}
```

All component colors reference these shared variables. The frontend now uses the extracted Inter/system and monospace font stacks, the recorded spacing and radius scales, a 64px top bar, visible focus rings, and 150ms interaction transitions. The authenticated sidebar width was not exposed by the reference stylesheet; the app uses a 252px width chosen to fit its own navigation, then collapses to icons below 1024px and becomes a toggleable drawer below 768px. Severity chips map Critical to red, High to orange, Medium to yellow, Low to green, and Info to blue using extracted palette colors. Table, modal, dropdown, tooltip, and responsive table-scroll styles are defined for consistent use across results and forms.
