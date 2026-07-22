# Assessment Connect — Minimal Permission Recipes

The security-review artifact for read-only assessment connects. Give this to
the customer's CRM admin before the connect call. The design guarantee it
pairs with: assessment organisations are hard-gated at three code paths
(settings PATCH, nightly write-back, orchestrator write-back) — write attempts
return 403 `ASSESSMENT_ORG_READONLY` / skip with reason `assessment_org`.

---

## Salesforce

Tokens inherit the permissions of the user who completes the OAuth. So the
recipe is: create a dedicated integration user, grant it a read-only
permission set, and have THAT user complete the connect.

### 1. Create the integration user
- Setup → Users → New User
- License: Salesforce (or Salesforce Integration license if available —
  cheaper and API-only)
- Profile: **Minimum Access — Salesforce**

### 2. Create the permission set  `GoWarm Assessment (Read-Only)`
Setup → Permission Sets → New, then grant:

**Object permissions — Read ONLY (no Create/Edit/Delete) on:**
- Opportunity, Account, Contact, Lead, Task, Event, User, Product2

**System permissions:**
- API Enabled
- View Setup and Configuration  *(lets discovery read stage definitions,
  record types, and — via the Tooling API — validation rules and flow
  counts; without it the report simply notes the gap)*

**Field-level security:** default visible fields are sufficient. If custom
Opportunity fields are FLS-restricted, discovery reports them as unreadable
rather than failing.

**Explicitly NOT granted (and not requested):**
- Modify All Data, View All Data (View All on the objects above is only
  needed if the org uses private sharing and the assessment should cover all
  reps' deals — decide with the customer; role-hierarchy top placement is the
  alternative)
- Any Create/Edit/Delete on any object
- Author Apex, Customize Application

### 3. Assign and connect
- Assign the permission set to the integration user
- On the connect call, log in to GoWarm as the assessment org admin, click
  Connect Salesforce — and have the CUSTOMER's admin sign in to Salesforce as
  the integration user in the OAuth window
- OAuth scopes requested by the app: `api refresh_token offline_access id`
  (scope narrowing to the objects above is enforced by the permission set,
  which is how Salesforce's model works — the OAuth scope is coarse, the
  user's permissions are the fine control)

### What the assessment reads
`OpportunityHistory` (always on — no Field History Tracking setup needed),
Opportunity/Account/Contact/Lead records, Task/Event roll-ups
(LastActivityDate), OpportunityContactRole counts, OpportunityStage
definitions, RecordTypes, and — Tooling API — ValidationRule names/messages
and active Flow/WorkflowRule counts. No record is ever created, modified, or
deleted; the connection can be revoked at any time from Setup → Connected
Apps OAuth Usage.

---

## HubSpot

HubSpot's OAuth scopes ARE the fine-grained control, so the recipe is scope
selection, not a permission set.

### Scopes requested by the GoWarm app for assessment
- `crm.objects.deals.read`
- `crm.objects.companies.read`
- `crm.objects.contacts.read`
- `crm.objects.owners.read`
- `crm.schemas.deals.read`
- `crm.schemas.custom.read`   *(custom-object inventory; omit → report notes gap)*
- `oauth`

No `*.write` scope is requested. HubSpot will show exactly this list on the
consent screen — that screen is itself the security-review evidence.

### Who connects
Any HubSpot user with access to the objects above (Super Admin not required).
Deal-stage history comes from HubSpot's built-in property history
(`propertiesWithHistory=dealstage`) — no portal configuration needed.

### Known asymmetries vs Salesforce (stated in the report, not hidden)
- No validation-rule analog → process-enforcement findings rely on pipeline
  stage metadata and workflow inventory only
- Property fill rates are sampled (most recent ~200 deals), flagged as such

---

## Revocation

Either side, any time:
- Salesforce: Setup → Connected Apps OAuth Usage → Revoke; or GoWarm →
  Settings → Salesforce → Disconnect
- HubSpot: Settings → Integrations → Connected Apps → Uninstall; or GoWarm →
  Settings → HubSpot → Disconnect
Revocation invalidates the refresh token; GoWarm retains only the already-
frozen snapshots (which contain aggregates + record IDs, not record bodies).
