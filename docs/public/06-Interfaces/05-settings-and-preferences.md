# Settings and preferences

Shared account settings and typed presentation preferences provide user-level choices without creating app business records. Preferences never grant access.

## Shared settings

The shell exposes account and appearance settings through the runtime-owned settings panel. Theme selection uses the finite `theme_controller` choices and persists as a viewer preference. Application-specific preferences belong in declared typed settings and are scoped to the current user.

Keep business facts such as approval thresholds or team-wide policy in ordinary authorized models, not personal presentation preferences. A preference cannot change a query grant or operation permission. The control must tolerate missing preference state by using its declared default.
