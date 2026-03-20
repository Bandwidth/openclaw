---
name: voice-call
description: Start voice calls via the OpenClaw voice-call plugin (Twilio, Telnyx, Plivo, Bandwidth/ClawComm, or mock).
metadata:
  {
    "openclaw":
      {
        "emoji": "📞",
        "skillKey": "voice-call",
        "requires": { "config": ["plugins.entries.voice-call.enabled"] },
      },
  }
---

# Voice Call

Use the voice-call plugin to start or inspect calls (Twilio, Telnyx, Plivo, Bandwidth/ClawComm, or mock).

## CLI

```bash
openclaw voicecall call --to "+15555550123" --message "Hello from OpenClaw"
openclaw voicecall status --call-id <id>
```

## Tool

Use `voice_call` for agent-initiated calls.

Actions:

- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

Notes:

- Requires the voice-call plugin to be enabled.
- Plugin config lives under `plugins.entries.voice-call.config`.
- Twilio config: `provider: "twilio"` + `twilio.accountSid/authToken` + `fromNumber`.
- Telnyx config: `provider: "telnyx"` + `telnyx.apiKey/connectionId` + `fromNumber`.
- Plivo config: `provider: "plivo"` + `plivo.authId/authToken` + `fromNumber`.
- Bandwidth/ClawComm config: `provider: "bandwidth"` — see setup section below.
- Dev fallback: `provider: "mock"` (no network).

## Bandwidth / ClawComm Setup

ClawComm is the only provider that handles credential acquisition entirely through API calls —
no provider dashboard required. The agent can complete the full setup interactively.

**No public webhook URL, ngrok, or Tailscale needed** — ClawComm uses a WebSocket connection.
The gateway auto-restarts when plugin config changes (no manual restart needed).

### Setup Steps

1. **Health check** — Verify the ClawComm API is reachable:

   ```bash
   curl -sf https://labs.bandwidth.com/api/clawcomm/health
   ```

   If this fails, inform the user the service may be temporarily unavailable and stop.

2. **Check existing credentials** — If `CLAWCOMM_API_TOKEN` is already set, verify it works:

   ```bash
   curl -sf -H "Authorization: Bearer $CLAWCOMM_API_TOKEN" \
     https://labs.bandwidth.com/api/clawcomm/api/v1/accounts/me
   ```

   If valid (HTTP 200), skip to step 8 — already configured.

3. **Display 2FA consent disclaimer** (MANDATORY — display this exact text before asking for any phone number):

   "By providing your number, you consent to receive 2FA messages from Bandwidth. Message Frequency may vary. Message and Data rates may apply. Text Stop to opt-out or Help for support."

4. **Collect mobile number** — Ask the user for their mobile number in E.164 format (e.g. `+15551234567`).
   This is used for two-factor verification only.

5. **Register** — Send the registration request:

   ```bash
   curl -s -X POST https://labs.bandwidth.com/api/clawcomm/api/v1/accounts/register \
     -H "Content-Type: application/json" \
     -d '{"phone_number": "<user_phone>"}'
   ```

   Capture `session_id` from the JSON response.

6. **Collect verification code** — Ask the user for the 6-digit code sent to their phone.

7. **Verify** — Complete verification:

   ```bash
   curl -s -X POST https://labs.bandwidth.com/api/clawcomm/api/v1/accounts/verify \
     -H "Content-Type: application/json" \
     -d '{"session_id": "<session_id>", "code": "<code>"}'
   ```

   Capture `token`, `assigned_number`, and `account_sid` from the JSON response.

8. **Store credentials** — Add the token to the shell profile (not to `openclaw.json`):

   ```bash
   echo 'export CLAWCOMM_API_TOKEN="<token>"' >> ~/.zshrc  # or ~/.bashrc / ~/.profile
   export CLAWCOMM_API_TOKEN="<token>"
   ```

   The extension reads `CLAWCOMM_API_TOKEN` from the environment automatically via `resolveVoiceCallConfig()`.

9. **Write all plugin config in a single patch** — This triggers one gateway auto-restart:

   ```bash
   openclaw config patch '{"plugins":{"entries":{"voice-call":{"enabled":true,"config":{"provider":"bandwidth","fromNumber":"<assigned_number>","toNumber":"<user_phone>","inboundPolicy":"allowlist","allowFrom":["<user_phone>"]}}}}}'
   ```

   The gateway detects the config file change and restarts automatically (~5 seconds). No manual restart needed.

10. **Confirm** — Tell the user:

    > My phone number is `<assigned_number>`. You can reach me there anytime, or just tell me to call you.

11. **Test the setup** — Wait ~5 seconds for the gateway to restart, then:
    ```bash
    openclaw voicecall call --message "Hello! Voice calling is now set up."
    ```

### Error Handling

| Error                                  | Cause                                  | Resolution                                            |
| -------------------------------------- | -------------------------------------- | ----------------------------------------------------- |
| `409 Conflict` on `/register`          | Phone number already has an account    | Check if existing `CLAWCOMM_API_TOKEN` works (step 2) |
| `410 Gone` on `/verify`                | Verification session expired (>10 min) | Re-run from step 5 to get a new session               |
| `503 Service Unavailable` on `/verify` | No phone numbers available in pool     | Contact ClawComm support                              |
| Connection refused                     | ClawComm API not reachable             | Check API health (step 1)                             |
