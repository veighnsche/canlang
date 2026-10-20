# Settings and preferences

Shared account settings and typed presentation preferences provide user-level choices without creating app business records. Preferences never grant access.

## Shared settings

The shell exposes account and appearance settings through the runtime-owned settings panel. Theme selection uses the finite `theme_controller` choices and persists as a viewer preference. Application-specific preferences belong in declared typed settings and are scoped to the current user.

Keep business facts such as approval thresholds or team-wide policy in ordinary authorized models, not personal presentation preferences. A preference cannot change a query grant or operation permission. The control must tolerate missing preference state by using its declared default.

## Find shared presentation settings

Open Settings from the shell’s account menu, then select the relevant section in the dialog’s internal sidebar. Language offers the application’s available locales; Appearance provides supported presentation choices. The dialog displays the active section’s panel, so inspect each section separately.

### Language

```doc-visual
{
  "placeholder": "Select Language in Settings to see the locales offered by the application.",
  "caption": "The Settings dialog with Language active and an offered locale selected. Marker 1 identifies the active section; marker 2 identifies the locale control.",
  "alt": "Settings dialog showing the active Language section and its offered locale control",
  "production": {
    "method": "screenshot",
    "instructions": [
      "Use a real approved documentation instance with the shared Language section available and a synthetic signed-in account allowed to change its own viewer settings. Open the shell account menu, choose Settings, then select Language in the dialog sidebar. Obtain the actual instance address from its operator.",
      "Capture only the active Language panel and section sidebar, with a locale actually offered by this application selected. Keep the existing selection and any actual confirmation controls visible; do not fabricate locale options, save controls or another section panel. If the deployed revision lacks this shared section, defer capture until it is available.",
      "Record the captured application and runtime revisions and capture date in the asset notes; do not include credentials, private addresses, session tokens or real personal data.",
      "Capture at 1280 by 800 with English interface text and the light theme. Use a focused crop so essential labels remain readable at narrow article widths."
    ],
    "edits": [
      "Crop browser chrome and unrelated application content, retaining the Settings title, section sidebar, active Language heading and locale control.",
      "Add marker 1 beside the active Language section and marker 2 beside the locale control. Preserve actual labels and explain both markers in the caption.",
      "Exclude personal account information and verify the alt text against the completed capture."
    ]
  }
}
```

### Appearance

```doc-visual
{
  "placeholder": "Select Appearance in Settings to find the supported theme and density controls.",
  "caption": "The Settings dialog with Appearance active and sample light-theme, comfortable-density selections. Marker 1 identifies the active section; marker 2 identifies the theme and density controls.",
  "alt": "Settings dialog with the Appearance section active and supported theme and density controls",
  "production": {
    "method": "screenshot",
    "instructions": [
      "Use a real approved documentation instance with shared Appearance settings and a synthetic signed-in account permitted to change its own viewer preferences. Open the shell account menu, choose Settings, then select Appearance in its section sidebar; use the actual address supplied by the operator.",
      "Select the offered light theme and Comfortable density for sample viewer settings. Capture the active Appearance panel, its actual theme choices, density controls and existing save/reset affordances with the section sidebar. Do not show Language controls alongside the active Appearance panel. If the instance does not yet expose this shared panel, defer capture instead of composing a mock interface.",
      "Record the captured application and runtime revisions and capture date in the asset notes; do not include credentials, private addresses, session tokens or real personal data.",
      "Capture at 1280 by 800 with English interface text and the light theme. Use a focused crop so essential labels remain readable at narrow article widths."
    ],
    "edits": [
      "Crop browser chrome and unrelated content, keeping the Settings title, sidebar, active Appearance heading, theme and density labels and their real controls visible.",
      "Add marker 1 beside the active Appearance section and marker 2 beside the theme and density control group; explain both markers in the caption and preserve all interface text.",
      "Exclude account details and verify the caption and alt text against the finished capture."
    ]
  }
}
```
