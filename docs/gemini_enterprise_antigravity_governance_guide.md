# Implementation Guide: Telemetry, Compliance Logging and Access Governance for Google Antigravity in Gemini Enterprise

This guide is for platform administrators, security engineers and FinOps practitioners who run Google Antigravity through Gemini Enterprise. It covers four things:

1. Configuring compliance logging in Gemini Enterprise.
2. Routing Antigravity's logs to BigQuery, with prompts locked away from analysts.
3. Reporting on adoption, usage and agent behaviour.
4. Optionally, restricting Antigravity for individual users without removing their Gemini Enterprise search and chat.

Sections 2 to 4 are implemented by the [`ge-app-telemetry`](../ge-app-telemetry/) module in this repository. This guide explains the design; the module's [README](../ge-app-telemetry/README.md) is the operational reference. Sections 5 to 7 describe a **reference design** for usage-based access control. It is not part of the module: adapt it and test it in a non-production project before use.

## 1. Architecture

Two planes, deployed independently:

1. **Observability and compliance.** Antigravity writes its logs to Cloud Logging (`businessaicode.googleapis.com`). A Log Router sink copies every entry into a **locked RAW dataset** (`ge_app_agy_raw`) that only project owners can read, because it contains prompts and responses. Analysts and dashboards use a separate **views dataset** (`ge_app_agy_telemetry`) of authorized views. These views read RAW but **never return prompt or response text**.
2. **Access governance (optional).** A scheduled job reads daily consumption from the views. It moves users who exceed a limit to a custom role without Antigravity permissions, and moves them back when the window resets. Gemini Enterprise search and chat keep working throughout.

```text
+---------------------------------------------------------------------------+
|  Developers: Antigravity Hub · Antigravity CLI (agy) · IDE extensions      |
+---------------------------------------------------------------------------+
                                   | businessaicode.googleapis.com
                                   v
+---------------------------------------------------------------------------+
|  Cloud Logging · resource businessaicode.googleapis.com/BAICInstance       |
|  logs: inference_request · inference_response · client_telemetry           |
+---------------------------------------------------------------------------+
                                   | Log Router sink (all fields, no exclusions)
                                   v
+---------------------------------------------------------------------------+
|  RAW dataset  ge_app_agy_raw          project owners only                  |
|  3 tables, daily partitions, retention 90 days by default                  |
+---------------------------------------------------------------------------+
                                   | authorized views (computed on query)
                                   v
+------------------------------------------+     +--------------------------+
|  Views dataset  ge_app_agy_telemetry     |     |  Quota job (optional)    |
|  7 views, no prompt or response text     |---->|  Cloud Run job, hourly   |
+------------------------------------------+     |  changes IAM bindings    |
          |                     |                +--------------------------+
          v                     v
   Local web dashboard    Looker Studio / BigQuery
```

## 2. Gemini Enterprise settings

Logging must be enabled in Gemini Enterprise before any telemetry exists.

### 2.1 Where to find them

1. Open the **Google Cloud console**.
2. Go to **Gemini Enterprise › Settings**.
3. Select the **AI developer tools** tab.

### 2.2 Activation

- Set **AI developer tools** to **Enabled**. Licensed Gemini Enterprise users with the required IAM roles can then use Antigravity.

### 2.3 Security policies

Choose the execution boundaries for developers:

- **Outside of file access policy:** `Always ask`, so users confirm before the agent reads or edits files outside the workspace.
- **Terminal auto-execution mode:** `Require review`, so a person approves commands before they run.
- **Sandbox mode:** according to your environment's requirements.
- **Browser access:** `Enabled`, with **Browser JavaScript execution policy** set to `Request review`.
- **MCP servers:** `Enabled` or `Disabled`, depending on whether Model Context Protocol servers are permitted.

### 2.4 Compliance logging

Under **Compliance**, select **Edit**:

- **Metadata logging:** **Enabled**. Records request metadata: token counts, timestamps, the user (`labels.user_id`), the client application and the model. All reporting in this guide depends on it.
- **Prompts and responses logging:** your decision. When enabled, prompts and model responses are written to Cloud Logging (and, with `ge-app-telemetry`, kept in the locked RAW dataset for the retention period). When disabled, only metadata is logged. Reporting works either way, because no view uses prompt text.

### 2.5 Model availability

Under **Model availability**, allow all models or restrict Antigravity to approved ones (for example `gemini-3.8-flash` or `gemini-4-argon`).

## 3. Routing logs to BigQuery

### 3.1 What Antigravity writes

All entries use the monitored resource `businessaicode.googleapis.com/BAICInstance`, in three logs:

| Log | Written when | Contains |
|---|---|---|
| `inference_request` | A model call starts | Conversation messages and context (subject to prompt logging) |
| `inference_response` | A model call completes | Token counts, model, reasoning tier ("experience"), the response (subject to prompt logging), code citations |
| `client_telemetry` | A user interacts with the agent | Event type and, for permission prompts, the decision (`PERMISSION_GRANT` · `ACCEPTED` / `REJECTED`) |

Each entry carries `labels.user_id`, `labels.client_name`, `labels.client_version`, `labels.model`, `labels.trajectory_id` (the conversation) and `labels.request_id`.

### 3.2 Why a locked RAW dataset plus views

Cloud Logging exclusions can only drop whole entries, not individual fields. A response entry carries both the token counts (needed for reporting) and the model's output (sensitive). Excluding it would lose the telemetry. So every entry is stored, the storage is locked, and access is through authorized views that leave the text out:

| Data | RAW `ge_app_agy_raw` | Views `ge_app_agy_telemetry` |
|---|---|---|
| User, model, client, conversation and request IDs, timestamps | Yes | Yes |
| Token counts and permission decisions | Yes | Yes (aggregated) |
| Code citations: source URL, licence and matched character range | Yes | Yes (never the matched text) |
| Prompt and response text | Yes | Never |

| Principal | RAW | Views |
|---|---|---|
| Project owners | Read | Read |
| The sink's writer identity | Write only | None |
| People or groups granted **BigQuery Data Viewer** on the views dataset | None | Read |
| Basic **Viewer** role | None (the default reader entry is removed) | None |
| Project-level **Editor**, **BigQuery Admin / Data Owner / Data Viewer** | Read (inherited; dataset settings cannot block it) | Read |

> [!IMPORTANT]
> Keep project-level Editor and BigQuery data roles to a minimum, or host the datasets in a separate project (`--dest-project-id`), because those roles inherit read access to RAW. Grant analysts **BigQuery Data Viewer on the views dataset only**, never Data Editor or Data Owner: anyone who can replace a view could rewrite it to return prompt text.

### 3.3 Deploying

Use the module's deployment script or its Terraform; both create the same resources:

```bash
cd ge-app-telemetry
./deploy.sh                                   # interactive; or headless:
./deploy.sh -p <PROJECT_ID> -l <LOCATION> -r 90 -y
```

The script:

1. Enables the Logging and BigQuery APIs.
2. Creates the RAW and views datasets in the chosen location. The location cannot be changed later.
3. Creates the three RAW tables from `schemas/raw/`, partitioned daily on `timestamp`, with the chosen retention.
4. Creates or updates the sink `ge-app-agy-telemetry-sink` with the filter `resource.type="businessaicode.googleapis.com/BAICInstance" AND logName=~"businessaicode.googleapis.com"`, writing to RAW with no exclusions.
5. Grants the sink's writer identity write access to RAW, and removes BigQuery's default `projectReaders` and `projectWriters` entries from both datasets.
6. Creates the seven views and authorizes each one on RAW.

Re-running it is safe. Terraform users: see [§6.7 of the module README](../ge-app-telemetry/README.md#67-deploying-with-terraform-alternative-to-deploysh).

> [!NOTE]
> A new sink takes a few minutes to start routing; entries written in the first minutes may not be exported. After that, entries reach RAW within about a minute. `backfill.sh` copies earlier entries that are still in Cloud Logging (30 days in the `_Default` bucket by default).

### 3.4 Verifying

```bash
gcloud logging sinks describe ge-app-agy-telemetry-sink --format="yaml(name,destination,exclusions)"
bq ls <PROJECT_ID>:ge_app_agy_raw          # 3 tables
bq ls <PROJECT_ID>:ge_app_agy_telemetry    # 7 views, no tables
bq show --format=prettyjson <PROJECT_ID>:ge_app_agy_raw | jq '.access'
```

## 4. Reporting

### 4.1 The views

All views live in `ge_app_agy_telemetry` and follow the same rules:
- No prompt or response text.
- Duplicate log entries removed on `(insertId, timestamp)`.
- Days and windows in UTC.
- `user_email` is `labels.user_id` without its `user:` prefix.

The SQL is in [`ge-app-telemetry/views/`](../ge-app-telemetry/views/), the single source of truth. Each column has a description in BigQuery.

| View | One row per | Use it for |
|---|---|---|
| `v_ge_app_agy_user_summary` | User and window (rolling 7 and 90 days), plus an all-users row | Active users, sessions, tokens by type, top model, permission acceptance; leaderboards |
| `v_ge_app_agy_model_summary` | Model and window (7 and 90 days), plus an all-models row | Model mix and share of tokens |
| `v_ge_app_agy_adoption` | Day, user, client, client version, model | Daily active users, surface mix (Hub, CLI, IDE), version rollout |
| `v_ge_app_agy_token_economics` | Day, user, client, model, reasoning tier | Daily tokens: prompt, output, thinking, cached |
| `v_ge_app_agy_trust_quality` | Day, user, client, model | Permission requests accepted and rejected; finished turns |
| `v_ge_app_agy_daily_sessions` | Day and every combination of user, client and model | Exact daily sessions and users for any filter |
| `v_ge_app_agy_code_citations` | Citation | Responses that closely matched public code: source URL and licence |

**Not reported, by design:**
- **Cost.** The logs contain token counts, not billing data, and pricing depends on the subscription.
- **Proposal acceptance.** Not observed in live logs.
- **Turn "resolution rate".** `InferenceResolved` also fires after a rejected permission, so it doesn't indicate success.

### 4.2 Active users

```sql
-- Daily, weekly and monthly active users (UTC days)
SELECT
  COUNT(DISTINCT IF(event_date = CURRENT_DATE(), user_email, NULL))                          AS dau,
  COUNT(DISTINCT IF(event_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 6 DAY), user_email, NULL))  AS wau,
  COUNT(DISTINCT IF(event_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 29 DAY), user_email, NULL)) AS mau
FROM `<PROJECT_ID>.ge_app_agy_telemetry.v_ge_app_agy_adoption`
WHERE event_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 29 DAY);
```

### 4.3 Tokens and sessions

```sql
-- Team totals over rolling 7 and 90 days
SELECT window_days, active_users, inferences, trajectories AS sessions, total_tokens, permission_grant_rate
FROM `<PROJECT_ID>.ge_app_agy_telemetry.v_ge_app_agy_user_summary`
WHERE scope = 'all_users' ORDER BY window_days;

-- Tokens by type and model, last 30 days
SELECT model, SUM(prompt_tokens) AS prompt, SUM(candidates_tokens) AS output,
       SUM(thoughts_tokens) AS thinking, SUM(cached_content_tokens) AS cached, SUM(total_tokens) AS total
FROM `<PROJECT_ID>.ge_app_agy_telemetry.v_ge_app_agy_token_economics`
WHERE event_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
GROUP BY model ORDER BY total DESC;
```

More queries are in [§11 of the module README](../ge-app-telemetry/README.md#11-sample-queries).

### 4.4 Dashboards and sharing

- **Local web dashboard:** `ge-app-telemetry/dashboards/local-web/` (`fetch_data.sh`, then `start.sh`). It reads the views only.
- **Looker Studio:** connect to the views and set **Data credentials › Owner's credentials**. Report viewers then need no BigQuery access.
- **Analysts:** grant **BigQuery Data Viewer** on `ge_app_agy_telemetry` (BigQuery console › dataset › **Sharing › Permissions**) and **BigQuery Job User** on a project.

## 5. Restricting Antigravity for selected users

### 5.1 The constraint

Gemini Enterprise users normally hold `roles/discoveryengine.agentspaceUser` (Gemini Enterprise User). It covers both search and chat, **and** Antigravity (`businessaicode.*` permissions). Removing it to stop Antigravity also removes search and chat.

### 5.2 The approach

As described in [Create a custom role to restrict access to AI developer tools](https://docs.cloud.google.com/gemini/enterprise/docs/ai-developer-tools-creating-custom-roles), create a custom role that copies `roles/discoveryengine.agentspaceUser` without the `businessaicode.*` permissions. A user moved to that role keeps search and chat; Antigravity calls fail with `PERMISSION_DENIED`.

### 5.3 Two marker roles

To tell an automatic cap from an administrator's decision, use two roles with the same permissions:

| Role ID | Applied by | Restored automatically? |
|---|---|---|
| `CustomAntigravityCapBlocked` | The quota job, when a user exceeds the limit | Yes, when the window resets |
| `CustomAntigravityAdminBlocked` | An administrator, by hand | Never |

### 5.4 Creating them

```bash
export PROJECT_ID="<PROJECT_ID>"

# Permissions of the Gemini Enterprise User role, without Antigravity's (businessaicode.*)
PERMS=$(gcloud iam roles describe roles/discoveryengine.agentspaceUser \
  --format="value(includedPermissions)" | tr ';' '\n' \
  | grep -v '^businessaicode\.' | grep -v '^resourcemanager\.projects\.list' | paste -sd, -)

for ROLE in CustomAntigravityCapBlocked CustomAntigravityAdminBlocked; do
  gcloud iam roles create "${ROLE}" --project="${PROJECT_ID}" \
    --title="${ROLE}" \
    --description="Gemini Enterprise search and chat without AI developer tools (Antigravity)." \
    --permissions="${PERMS}" --stage=GA
done
```

Check the result with `gcloud iam roles describe CustomAntigravityCapBlocked --project="${PROJECT_ID}"`. Re-create the roles if Google changes the predefined role's permissions.

## 6. Reference design: automatic daily limits

A scheduled job compares each user's consumption today (UTC) with a limit, and swaps their role. It reads consumption from `v_ge_app_agy_token_economics`, so it uses the same de-duplicated figures as the reports.

### 6.1 Classifying users first

Before changing anything, the job puts every user in exactly one state:

| State | Condition | Action |
|---|---|---|
| `ENFORCEABLE_ALLOWED` | Direct `user:` binding on `roles/discoveryengine.agentspaceUser` | May be capped |
| `CAPPED_BY_TOOL` | Direct binding on `CustomAntigravityCapBlocked` | May be restored |
| `BLOCKED_BY_ADMIN` | Direct binding on `CustomAntigravityAdminBlocked` | Never touched |
| `NOT_ENFORCEABLE` | Also holds Owner, Editor or a Discovery Engine admin/editor role | Never touched |

Access through groups (`group:`), domains (`domain:`) or inherited folder and organisation bindings can't be removed by changing a project binding. Users with such access are never capped automatically, and the job reports those bindings.

### 6.2 Safety gates

| Gate | Rule |
|---|---|
| G1 · policy readable | If the project's IAM policy can't be read, stop |
| G2 · users found | If no direct user bindings exist, stop |
| G3 · telemetry healthy | If the consumption query fails, or the views show no activity at all for 72 hours, make **no restorations** (a broken pipeline must not unblock everyone) |
| G4 · change budget | If planned changes exceed `max(10, 20% of direct users)`, stop and report |
| G5 · indirect access | Report group and domain bindings on the Gemini Enterprise User role; never act on them |

The job runs in **dry-run mode by default** and only reports what it would change. Set `DRY_RUN=false` once the output is right.

### 6.3 Reference implementation

`quota_enforcer.py`:

```python
"""Reference implementation: daily Antigravity limits through IAM role swaps.

Reads today's consumption (UTC) from the ge-app-telemetry views, then moves users between
roles/discoveryengine.agentspaceUser and the CustomAntigravityCapBlocked role.
Dry run by default: set DRY_RUN=false to apply changes. Test in a non-production project first.
"""

import os
import sys
from datetime import datetime, timezone

from google.cloud import bigquery, resourcemanager_v3
from google.cloud import logging as cloud_logging

PROJECT_ID = os.environ["GCP_PROJECT_ID"]                    # project holding the IAM bindings
VIEWS = os.environ.get("TELEMETRY_VIEWS", f"{PROJECT_ID}.ge_app_agy_telemetry")
DAILY_TOKEN_CAP = int(os.environ.get("DAILY_TOKEN_CAP", "5000000"))   # includes cached tokens
DAILY_REQUEST_CAP = int(os.environ.get("DAILY_REQUEST_CAP", "2000"))  # model calls
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() != "false"
MAX_SILENCE_HOURS = int(os.environ.get("TELEMETRY_MAX_SILENCE_HOURS", "72"))

ROLE_BASE = "roles/discoveryengine.agentspaceUser"
ROLE_CAP = f"projects/{PROJECT_ID}/roles/CustomAntigravityCapBlocked"
ROLE_ADMIN = f"projects/{PROJECT_ID}/roles/CustomAntigravityAdminBlocked"
NEVER_TOUCH_ROLES = {
    "roles/owner", "roles/editor",
    "roles/discoveryengine.admin", "roles/discoveryengine.editor", "roles/discoveryengine.agentspaceAdmin",
}


def audit(logger, action, user, reason):
    record = {"action": action, "user_email": user, "reason": reason, "dry_run": DRY_RUN,
              "actor": "antigravity-quota-job", "at": datetime.now(timezone.utc).isoformat()}
    print(record)
    logger.log_struct(record, severity="NOTICE")


def todays_consumption(bq):
    """{user_email: (model_calls, tokens)} for today (UTC), and whether telemetry looks healthy."""
    usage_sql = f"""
        SELECT user_email, SUM(total_inferences) AS calls, SUM(total_tokens) AS tokens
        FROM `{VIEWS}.v_ge_app_agy_token_economics`
        WHERE event_date = CURRENT_DATE() AND user_email != 'unknown'
        GROUP BY user_email"""
    fresh_sql = f"""
        SELECT MAX(last_activity_utc) AS last_seen
        FROM `{VIEWS}.v_ge_app_agy_adoption`
        WHERE event_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)"""
    try:
        usage = {r.user_email: (r.calls, r.tokens) for r in bq.query(usage_sql).result()}
        last_seen = next(iter(bq.query(fresh_sql).result())).last_seen
    except Exception as error:  # G3: no data means no restorations
        print(f"G3: telemetry query failed: {error}", file=sys.stderr)
        return {}, False
    healthy = last_seen is not None and (datetime.now(timezone.utc) - last_seen).total_seconds() < MAX_SILENCE_HOURS * 3600
    if not healthy:
        print(f"G3: no telemetry for over {MAX_SILENCE_HOURS}h (last activity: {last_seen}); restorations withheld.")
    return usage, healthy


def unconditional(binding):
    return not binding.HasField("condition")


def main():
    projects = resourcemanager_v3.ProjectsClient()
    resource = f"projects/{PROJECT_ID}"

    # G1: read the policy (version 3, so conditional bindings are visible and preserved)
    try:
        policy = projects.get_iam_policy(request={"resource": resource, "options": {"requested_policy_version": 3}})
    except Exception as error:
        sys.exit(f"G1: cannot read the IAM policy: {error}")

    members_of = {}
    for b in policy.bindings:
        members_of.setdefault(b.role, set()).update(b.members)
        if b.role == ROLE_BASE:
            for m in b.members:
                if m.startswith(("group:", "domain:")):
                    print(f"G5: {m} has {ROLE_BASE}; its members are never capped automatically.")

    direct = {m[5:] for b in policy.bindings for m in b.members if m.startswith("user:")}
    if not direct:
        sys.exit("G2: no direct user bindings found.")
    protected = {m[5:] for r in NEVER_TOUCH_ROLES for m in members_of.get(r, ()) if m.startswith("user:")}
    has = lambda role, user: f"user:{user}" in members_of.get(role, set())

    usage, healthy = todays_consumption(bigquery.Client(project=PROJECT_ID))

    to_cap, to_restore = [], []
    for user in sorted(direct - protected):
        if has(ROLE_ADMIN, user):
            continue                                   # BLOCKED_BY_ADMIN: never touched
        calls, tokens = usage.get(user, (0, 0))
        over = calls >= DAILY_REQUEST_CAP or tokens >= DAILY_TOKEN_CAP
        if has(ROLE_BASE, user) and over:
            to_cap.append((user, f"{calls} calls, {tokens} tokens today"))
        elif has(ROLE_CAP, user) and not over and healthy:
            to_restore.append((user, "below today's limits"))

    budget = max(10, int(len(direct) * 0.2))           # G4
    if len(to_cap) + len(to_restore) > budget:
        sys.exit(f"G4: {len(to_cap) + len(to_restore)} changes planned, above the budget of {budget}. Nothing changed.")

    logger = cloud_logging.Client(project=PROJECT_ID).logger("antigravity-quota-job")
    for user, reason in to_cap:
        audit(logger, "CAP", user, reason)
    for user, reason in to_restore:
        audit(logger, "RESTORE", user, reason)
    if DRY_RUN or not (to_cap or to_restore):
        print(f"{'Dry run: ' if DRY_RUN else ''}{len(to_cap)} to cap, {len(to_restore)} to restore.")
        return

    def add(role, member):
        for b in policy.bindings:
            if b.role == role and unconditional(b):
                if member not in b.members:
                    b.members.append(member)
                return
        policy.bindings.add(role=role, members=[member])

    def remove(role, member):
        for b in policy.bindings:
            if b.role == role and unconditional(b) and member in b.members:
                b.members.remove(member)

    for user, _ in to_cap:
        remove(ROLE_BASE, f"user:{user}")
        add(ROLE_CAP, f"user:{user}")
    for user, _ in to_restore:
        remove(ROLE_CAP, f"user:{user}")
        add(ROLE_BASE, f"user:{user}")

    policy.version = 3
    # The policy's etag makes this fail, rather than overwrite, if someone changed IAM meanwhile.
    projects.set_iam_policy(request={"resource": resource, "policy": policy})
    print(f"Applied: {len(to_cap)} capped, {len(to_restore)} restored.")


if __name__ == "__main__":
    main()
```

`requirements.txt`:

```text
google-cloud-bigquery>=3.25.0
google-cloud-resource-manager>=1.12.0
google-cloud-logging>=3.11.0
```

Notes:
- **Caps include cached tokens.** `total_tokens` counts input, cache reads and output. Long agent sessions read most of their context from cache, so set token caps from your own data (`v_ge_app_agy_user_summary`, 7-day window), not from a guess.
- **Daily windows reset at midnight UTC.** The views use UTC dates.
- **Telemetry lag.** Entries reach the views within about a minute, so a user can exceed a cap slightly before the next run.
- **Audit trail.** Every planned or applied change is written to the `antigravity-quota-job` log in Cloud Logging, including in dry-run mode.

## 7. Deploying the job

### 7.1 Service accounts and permissions

```bash
export PROJECT_ID="<PROJECT_ID>" REGION="<REGION>"
export JOB_SA="antigravity-quota-job@${PROJECT_ID}.iam.gserviceaccount.com"
export SCHEDULER_SA="antigravity-quota-scheduler@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud iam service-accounts create antigravity-quota-job --project="${PROJECT_ID}" \
  --display-name="Antigravity quota job"
gcloud iam service-accounts create antigravity-quota-scheduler --project="${PROJECT_ID}" \
  --display-name="Antigravity quota scheduler"

# The job: change project IAM bindings, run BigQuery queries, write its audit log
for ROLE in roles/resourcemanager.projectIamAdmin roles/bigquery.jobUser roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" --member="serviceAccount:${JOB_SA}" --role="${ROLE}"
done
```

Then give the job read access to the **views dataset only**: BigQuery console › `ge_app_agy_telemetry` › **Sharing › Permissions** › add `${JOB_SA}` as **BigQuery Data Viewer**. Do not grant it access to the RAW dataset.

> [!WARNING]
> `roles/resourcemanager.projectIamAdmin` can change any binding on the project. Keep the job's service account to this one purpose, and limit who can act as it or change its code.

### 7.2 The Cloud Run job

From a folder containing `quota_enforcer.py` and `requirements.txt`:

```bash
gcloud run jobs deploy antigravity-quota-job --source . \
  --region="${REGION}" --project="${PROJECT_ID}" \
  --service-account="${JOB_SA}" \
  --command=python --args=quota_enforcer.py \
  --set-env-vars="GCP_PROJECT_ID=${PROJECT_ID},DAILY_TOKEN_CAP=5000000,DAILY_REQUEST_CAP=2000,DRY_RUN=true"

gcloud run jobs execute antigravity-quota-job --region="${REGION}" --project="${PROJECT_ID}" --wait
```

Read the dry-run output in the job's logs. When it's correct, set `DRY_RUN=false` with `gcloud run jobs update antigravity-quota-job --update-env-vars=DRY_RUN=false --region="${REGION}"`.

### 7.3 Schedule

```bash
gcloud run jobs add-iam-policy-binding antigravity-quota-job --region="${REGION}" --project="${PROJECT_ID}" \
  --member="serviceAccount:${SCHEDULER_SA}" --role="roles/run.invoker"

gcloud scheduler jobs create http antigravity-quota-trigger \
  --location="${REGION}" --project="${PROJECT_ID}" \
  --schedule="0 * * * *" \
  --uri="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/antigravity-quota-job:run" \
  --http-method=POST \
  --oauth-service-account-email="${SCHEDULER_SA}"
```

## 8. Checklist

| Step | Task | Check |
|---|---|---|
| 1 | Enable AI developer tools and metadata logging (§2) | Entries appear in Logs Explorer for `resource.type="businessaicode.googleapis.com/BAICInstance"` |
| 2 | Deploy `ge-app-telemetry` (§3.3) | RAW has 3 tables, the views dataset 7 views; RAW access is owners, the sink writer and the 7 views |
| 3 | Share reporting (§4.4) | Analysts have Data Viewer on the views dataset only; Looker Studio uses owner's credentials |
| 4 | *(Optional)* Create the marker roles (§5.4) | Neither role contains a `businessaicode.*` permission |
| 5 | *(Optional)* Deploy the quota job in dry-run mode (§7) | Planned changes in its log match expectations; G4 has not tripped |
| 6 | *(Optional)* Switch the job to `DRY_RUN=false` | A test user over the cap loses Antigravity but keeps search and chat, and is restored after midnight UTC |

## 9. References

- [`ge-app-telemetry` README](../ge-app-telemetry/README.md): deployment, views, dashboards, operations
- [Create a custom role to restrict access to AI developer tools](https://docs.cloud.google.com/gemini/enterprise/docs/ai-developer-tools-creating-custom-roles)
- [Gemini Enterprise access control](https://docs.cloud.google.com/gemini/enterprise/docs/access-control)
- [Route logs to BigQuery](https://docs.cloud.google.com/logging/docs/export/bigquery)
- [Authorized views in BigQuery](https://docs.cloud.google.com/bigquery/docs/authorized-views)
- [Creating and managing custom roles](https://docs.cloud.google.com/iam/docs/creating-custom-roles)
- [Execute Cloud Run jobs on a schedule](https://docs.cloud.google.com/run/docs/execute/jobs-on-schedule)
