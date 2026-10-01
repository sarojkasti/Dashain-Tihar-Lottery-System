# Festival Lottery

Local Node.js application for central campaign administration. Requires Node.js 24 or later.

## Run

```powershell
npm.cmd install
npm.cmd start
```

Open http://localhost:3010, or double-click `Start Lottery.cmd` to start the server. Manual startup listens on this computer only unless `HOST` is configured. Sign-in is required for all campaign data. SQLite data is saved in `data/lottery.sqlite`. Stop the application before copying the `data` directory for a backup.

The app uses React Router URLs for its screens. Routes include `/overview`, `/sales-returns`, `/customers`, `/tickets`, `/sms`, `/sms/settings`, `/campaign-settings`, `/audit`, `/users` and `/account`. You can bookmark a screen or reload it directly; browser Back and Forward move between screens.

## Windows automatic startup (NSSM)

With Node.js 24+ and NSSM installed, run this once from an Administrator PowerShell:

```powershell
& '.\Install Service.ps1'
```

The `FestivalLottery` service starts at Windows boot without signing in, restarts the app after a failure, and uses the existing `data/lottery.sqlite` database. Open http://localhost:3010 in your browser. Do not also launch `Start Lottery.cmd` while the service is running. Keep this project folder and the installed Node.js and NSSM executables in place.

Service commands (Administrator terminal):

```powershell
nssm status FestivalLottery
nssm stop FestivalLottery
nssm start FestivalLottery
nssm restart FestivalLottery
```

Stop the service before backing up `data`, then start it again. Logs are in `logs/service-out.log` and `logs/service-error.log`, with rotation at 10 MB. To uninstall automatic startup, run `nssm stop FestivalLottery` followed by `nssm remove FestivalLottery confirm`; application data remains in place. NSSM settings follow the [official command reference](https://nssm.cc/commands).

## LAN access and initial administrator

After installing the service, run this from an Administrator PowerShell:

```powershell
& '.\Enable LAN.ps1'
```

This stops the service, backs up the SQLite files to `backups`, initializes the first administrator if no users exist, configures `HOST=0.0.0.0`, opens TCP 3010 for the local subnet on Windows Private/Domain networks, and starts the service. It leaves Public networks blocked. Check `logs/lan-setup.log` if setup fails. Users on the same LAN can open `http://<server-IP>:3010`; this computer can use http://localhost:3010. A guest Wi-Fi network may block communication between devices. If the server's DHCP address changes, use its new address or reserve an address on the router.

The initial username is `admin`. Its random temporary password is saved in `data/initial-admin.txt`, restricted to the Windows user running setup, SYSTEM, and Windows administrators. Change it at first sign-in, then delete that file. The setup never replaces an existing account or resets existing passwords. Administrators create other accounts in **Users** and share each temporary password privately. New users and users whose passwords were reset must set their own password before accessing records.

LAN access currently uses HTTP, so traffic is not encrypted. Use it on your trusted local network; do not forward this port to the internet. HTTPS is needed before using untrusted networks.

## Access permissions

| Capability | Administrator | Operator | Viewer |
| --- | --- | --- | --- |
| View campaigns, customers, tickets and SMS records | Yes | Yes | Yes |
| Download existing SMS exports | Yes | Yes | Yes |
| Import sales/returns, assign tickets, export pending SMS and update SMS results | Yes | Yes | No |
| Create campaigns or change campaign settings | Yes | No | No |
| Create, disable or update users and reset passwords | Yes | No | No |
| View and export the audit report | Yes | No | No |
| Change own password | Yes | Yes | Yes |

Roles cover all campaigns. Disabling an account, changing its role, or resetting its password revokes its sessions. Administrators cannot disable or demote themselves. Passwords use salted scrypt hashes; session tokens are hashed in SQLite, expire after eight hours, and use HttpOnly/SameSite cookies. Mutations require a session CSRF token; sign-in attempts are rate limited. These controls follow the [OWASP session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).

## Audit report

Administrators can open **Audit report**, filter by Gregorian UTC date range, user, campaign, action and outcome, browse pages, or download all matching records as CSV (up to 100,000 per export). The report includes account activity, failed sign-ins, denied actions, user changes, campaign settings before/after changes, upload previews/imports, ticket assignment and SMS operations. Business changes and their audit records commit in the same transaction. Passwords and session tokens are never included in audit details.

Existing records remain in place and display **Legacy / system** when no user was recorded. Failed sign-ins include the attempted username in Details. Report timestamps are UTC, distinct from the BS dates used for campaigns. Audit records cannot be edited or deleted through the app; local database administrators still control the database file.

## Workflow

1. Create a campaign using BS dates and an amount per ticket. Dates must be YYYY/MM/DD. Only records within these dates are accepted; balances are separate for each campaign.
2. Upload an `.xlsx` sales or returns report. The importer finds headers within the first 30 rows and groups invoice item rows. Required headers: Date BS, Invoice No, TotalNet Amount; add Phone Number to identify customers. Customer is the buyer name. Supported mobile numbers are ten-digit Nepal numbers beginning with 9; +977 is normalized.
3. Review invoices before importing. `Ab/83/84/Ne-` series is excluded. Deselect other outlet-level transactions, especially returns. Correct missing phones, date errors or conflicting invoice rows in Excel and upload again. Names do not identify customers.
4. Import all applicable sales and returns before assigning EOD tickets. Column H / TotalNet Amount is used as provided, including tax. Returns report values must be positive; the application subtracts them. The return reference in Invoice No is treated as a distinct return-document identifier. Duplicate checking uses campaign + document type + reference. Previously imported invoice details are never overwritten.
5. Review the ticket count and assign. Balances are consumed atomically; random ticket numbers are globally unique. Remaining balances carry forward. Returns may make balances negative but never cancel tickets. Threshold changes apply to subsequent assignments only.
6. In **SMS centre**, review the pending messages and choose **Send all pending SMS** to send through Aakash. Confirm the count and use of credits. The server processes the queue in the background; use **Refresh progress** to see results. Alternatively, export CSV for manual portal upload. Exported messages are excluded from API sending. Failed messages can be explicitly queued for retry; the original attempt remains in history.

## Current boundaries

- Aakash API acceptance is tracked automatically; delivery results must be confirmed in the Aakash portal and recorded using **Record portal result**. CSV upload formatting still depends on the portal template.
- Outlet-level returns without a distinct reference pattern require manual exclusion in preview.
- The same buyer must have the same phone across all invoice rows. Phone corrections to already committed records require a future correction workflow; review carefully before importing.
- BS date validation checks format, month and day bounds; it does not convert dates or validate the varying lengths of individual BS months.
- Dates in audit logs are UTC. No automated scheduling or winning draw selection is included.
- The application retains campaign records; it does not automatically delete old campaigns.
- Upload previews expire after 30 minutes. Input limit is 12 MB in the browser and 50,000 worksheet rows.

## Verification

```powershell
npm.cmd test
```

Tests cover balance carry-forward, repeated imports, negative balances, retained tickets after returns, threshold changes, stale assignment previews, rollback, phone normalization, Excel parsing, audit migrations, actor attribution, CSV filters, authentication, permissions, CSRF, password changes/resets, session revocation, upload ownership and sign-in rate limiting. Tests use separate temporary databases.

## Aakash SMS setup

1. Sign in as an administrator and open **SMS API settings** from the sidebar, or click **API settings** in the SMS centre. Paste your Aakash API token and click **Save API settings**.
2. Settings apply immediately to future batches without restarting. The token is stored in the server SQLite database and is never returned to the browser or included in audit logs. Protect the database and its backups as credentials. The saved status does not verify the token or balance. **Disable API sending** returns queued messages to pending; an in-flight batch may still complete.
3. To check the connection, enter a phone you can access and a short message in **Send a test message**, then confirm. This sends one real SMS and uses Aakash credits. The screen shows Aakash's immediate queue status, provider reference, credit and network. Use **Fetch delivery report** to retrieve and reconcile later carrier status; `delivered` means handset delivery is confirmed. Report rows that Aakash has not returned yet remain queued and unconfirmed.
4. Review the pending lottery messages in **SMS centre**, then click **Send all pending SMS** and confirm. Administrators and operators can send; viewers cannot.

Integration uses the [official Aakash send API](https://bitbucket.org/aakashsms/api/src/v4/). Each customer receives their own existing lottery message. The v4 `/sms/v4/send-user` endpoint receives the API token in the `auth-token` header and JSON `to`/`text` arrays for personalized messages. Requests contain up to 100 distinct phone numbers, with one request in flight and at most one batch started per second. This is an application batch size, not a documented provider limit. Additional messages for the same phone are sent in later batches. Each response is matched by phone and message text; missing or ambiguous results require review. Keep one app process running against the database. The queue persists across restarts and continues while the browser is closed.

Delivery reports use Aakash's `POST /sms/v4/api-report` endpoint with `start_date` and `end_date`. The integration handles the provider's paginated `data.result.data` response as well as a flat `data` array, matches provider references or message details and send time, and updates recorded statuses. While the app service is running it automatically checks unresolved delivery statuses every two minutes (and shortly after a test SMS); the open SMS screen refreshes its status every 30 seconds. Manual reports are also available in SMS API settings. Reports cover up to 31 days per lookup; narrow the date range if Aakash returns more than 100 pages.

`api accepted` means Aakash accepted the request, not confirmed delivery. Provider references appear alongside messages. A rejection or uncertain response pauses untouched messages by returning them to pending. A timeout, malformed response, or interrupted request becomes `api unknown`; check the Aakash portal and record the result before retrying. Unknown messages are never retried automatically. For an Aakash API message marked **failed**, **Retry via Aakash** asks for confirmation, then sends a new queued attempt; the failed record remains in history. Other failed messages can be queued for retry and exported for portal sending. Queued requests not yet started survive a restart. Long or Unicode messages may consume multiple credits under your provider plan.

Only pending lottery messages are sent in bulk; this does not add a general announcement composer. No live SMS is sent during automated tests.

Administrators can configure SMS even before creating a campaign. A saved API setting takes precedence over `AAKASH_SMS_TOKEN` in the server environment or `.env`; disabling in the app also overrides this fallback. Operators and viewers cannot read or change API settings.
