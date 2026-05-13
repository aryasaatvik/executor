---
"@executor-js/desktop": patch
"executor": patch
---

Desktop now re-checks for updates every 4 hours while running. Previously
the only update check was at app launch, so a long-running session would
sit on an outdated build indefinitely until the user quit and relaunched.
The interval is a self-heal — once an update is downloaded, the existing
"Update ready" dialog drives the rest of the flow.
