export const CLAWCOMM_DEFAULT_API_URL = "https://labs.bandwidth.com/api/clawcomm";

export const TFA_DISCLAIMER =
  "By providing your number, you consent to receive 2FA messages from Bandwidth. Message Frequency may vary. Message and Data rates may apply. Text Stop to opt-out or Help for support.";

export function resolveApiUrl(): string {
  return process.env.CLAWCOMM_API_URL ?? CLAWCOMM_DEFAULT_API_URL;
}

export async function checkHealth(apiUrl: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(`${apiUrl}/health`);
    if (response.ok) {
      return { ok: true };
    }

    const errorBody = await response.text();
    return {
      ok: false,
      error: `Health check failed: ${response.status} ${errorBody}`,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function register(apiUrl: string, phone: string): Promise<{ session_id: string }> {
  const response = await fetch(`${apiUrl}/api/v1/accounts/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ phone_number: phone }),
  });

  if (!response.ok) {
    if (response.status === 409) {
      throw new Error(
        "Phone number already registered. Check if CLAWCOMM_API_TOKEN is already set.",
      );
    }

    const body = await response.text();
    throw new Error(`Registration failed: ${response.status} ${body}`);
  }

  return (await response.json()) as { session_id: string };
}

export async function verify(
  apiUrl: string,
  sessionId: string,
  code: string,
): Promise<{ token: string; assigned_number: string; account_sid: string }> {
  const response = await fetch(`${apiUrl}/api/v1/accounts/verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ session_id: sessionId, code }),
  });

  if (!response.ok) {
    if (response.status === 410) {
      throw new Error("Verification session expired. Run setup again to get a new code.");
    }

    const body = await response.text();
    throw new Error(`Verification failed: ${response.status} ${body}`);
  }

  return (await response.json()) as {
    token: string;
    assigned_number: string;
    account_sid: string;
  };
}

export function validatePhone(phone: string): string | null {
  if (!phone) {
    return null;
  }

  const normalized = /^\d/.test(phone) ? `+${phone}` : phone;

  if (!normalized.startsWith("+")) {
    return null;
  }

  if (!/^\+[0-9]+$/.test(normalized)) {
    return null;
  }

  if (normalized.length < 8 || normalized.length > 16) {
    return null;
  }

  return normalized;
}

export function detectShellProfile(): string | null {
  if (process.platform === "win32") {
    return null;
  }

  const shell = process.env.SHELL;
  if (!shell) {
    return null;
  }

  if (shell === "/bin/zsh" || shell.endsWith("zsh")) {
    return "~/.zshrc";
  }

  if (shell === "/bin/bash" || shell.endsWith("bash")) {
    return "~/.bashrc";
  }

  return null;
}

export function buildConfigSetCommands(params: {
  apiUrl: string;
  apiToken: string;
  fromNumber: string;
  toNumber: string;
}): Array<[string, string]> {
  return [
    ["plugins.entries.voice-call.config.provider", "bandwidth"],
    ["plugins.entries.voice-call.config.bandwidth.apiUrl", params.apiUrl],
    ["plugins.entries.voice-call.config.bandwidth.apiToken", params.apiToken],
    ["plugins.entries.voice-call.config.fromNumber", params.fromNumber],
    ["plugins.entries.voice-call.config.toNumber", params.toNumber],
    ["plugins.entries.voice-call.config.inboundPolicy", "allowlist"],
  ];
}
