// AGY 2.0 Hub sidecar: the agy-local-telemetry page in a conversation's side pane.
// `sidecar_sdk` is provided by the Hub when it starts this sidecar (it is not a dependency of
// this repository). The SDK listens on the port the Hub assigns, serves /preload.js (theme and
// the active conversation for the page), and passes query parameters to the GET routes below.
// The record is the same file the command line uses, so both always agree.

import { SidecarApp } from "sidecar_sdk";
import { defaultStorePath, openStore } from "../../lib/store.mjs";
import { apiRoutes, page } from "../../lib/web.mjs";

const store = openStore(defaultStorePath());
const app = new SidecarApp();
app.page("/", page);
for (const [path, handler] of Object.entries(apiRoutes(store))) app.api(path, handler, "GET");
await app.run();
