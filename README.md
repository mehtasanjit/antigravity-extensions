# Antigravity Extensions

Enterprise extensions, telemetry pipelines, and integrations for **Google Antigravity** across Gemini Enterprise and Vertex AI Agent Platform.

---

## Modules and Architecture

* **[`ge-app-telemetry/`](ge-app-telemetry/):** Telemetry, data pipeline, and observability for Antigravity with Gemini Enterprise (GE App). **Start with its [README](ge-app-telemetry/README.md).**
  * Scope: **Cloud Logging → BigQuery**. A Log Router sink writes into a locked RAW dataset (`ge_app_agy_raw`), deployed with [`deploy.sh`](ge-app-telemetry/deploy.sh) or [`terraform/`](ge-app-telemetry/terraform/).
  * [`views/`](ge-app-telemetry/views/): Authorized views in `ge_app_agy_telemetry` that never return prompt text.
  * [`dashboards/local-web/`](ge-app-telemetry/dashboards/local-web/): Local web dashboard over the views.
* **[`agy-local-telemetry/`](agy-local-telemetry/):** On-device token usage for AGY 2.0 (Hub), agy CLI and IDE conversations, read from Antigravity's local files. An Antigravity plugin: a command, a local web page, an AGY 2.0 Hub side pane and a skill. Install by asking agy (it follows [`INSTALL.md`](agy-local-telemetry/INSTALL.md)) or with `agy plugin install`. **Start with its [README](agy-local-telemetry/README.md).**
* *(Upcoming)* **`geap-paygo-telemetry/`:** Telemetry pipeline for Antigravity used via standalone Agent Platform (GEAP / Vertex AI) consumption.

---

## Quickstart

To deploy the Gemini Enterprise Antigravity telemetry pipeline:
```bash
cd ge-app-telemetry
./deploy.sh
```
See the [ge-app-telemetry README](ge-app-telemetry/README.md) for the full guide.
