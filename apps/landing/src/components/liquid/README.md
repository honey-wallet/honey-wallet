# Liquid UI

Liquid Button, Switch and Tabs from [vwakesahu/liquid-components](https://github.com/vwakesahu/liquid-components)
(commit f843b00, MIT, see LICENSE), copied unchanged in its own folder layout so the relative imports hold.
Used by the landing page for the theme switch, the waitlist buttons and the friends tiles.

Local change: each component file imports `type * as React from "react"` so its `React.*` types come from
this app's @types/react (the workspace has two copies, and the global namespace picked the other one).
