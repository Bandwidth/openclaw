import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildConfigSetCommands,
  checkHealth,
  CLAWCOMM_DEFAULT_API_URL,
  detectShellProfile,
  register,
  resolveApiUrl,
  verify,
  validatePhone,
} from "./setup.js";

describe("setup helpers", () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = originalFetch;
    vi.restoreAllMocks();

    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  });

  describe("checkHealth", () => {
    it("returns ok true on 200", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
      } as Response);
      global.fetch = mockFetch;

      await expect(checkHealth("https://api.example.test")).resolves.toEqual({ ok: true });
    });

    it("returns ok false on network errors", async () => {
      const mockFetch = vi.fn().mockRejectedValueOnce(new Error("network down"));
      global.fetch = mockFetch;

      const result = await checkHealth("https://api.example.test");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("network down");
    });

    it("returns ok false on non-200 responses", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => "unavailable",
      } as Response);
      global.fetch = mockFetch;

      const result = await checkHealth("https://api.example.test");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("503");
    });
  });

  describe("register", () => {
    it("returns session id on 201", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ session_id: "abc" }),
      } as Response);
      global.fetch = mockFetch;

      await expect(register("https://api.example.test", "+15551234567")).resolves.toEqual({
        session_id: "abc",
      });
    });

    it("throws already registered error on 409", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 409,
        text: async () => "already exists",
      } as Response);
      global.fetch = mockFetch;

      await expect(register("https://api.example.test", "+15551234567")).rejects.toThrow(
        "Phone number already registered",
      );
    });

    it("throws generic registration failure on non-ok", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "server boom",
      } as Response);
      global.fetch = mockFetch;

      await expect(register("https://api.example.test", "+15551234567")).rejects.toThrow(
        "Registration failed",
      );
    });
  });

  describe("verify", () => {
    it("returns token payload on success", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: "token-123",
          assigned_number: "+15557654321",
          account_sid: "AC123",
        }),
      } as Response);
      global.fetch = mockFetch;

      await expect(verify("https://api.example.test", "session-123", "123456")).resolves.toEqual({
        token: "token-123",
        assigned_number: "+15557654321",
        account_sid: "AC123",
      });
    });

    it("throws expired session error on 410", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 410,
        text: async () => "expired",
      } as Response);
      global.fetch = mockFetch;

      await expect(verify("https://api.example.test", "session-123", "123456")).rejects.toThrow(
        "expired",
      );
    });

    it("throws generic verification failure on non-ok", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => "bad request",
      } as Response);
      global.fetch = mockFetch;

      await expect(verify("https://api.example.test", "session-123", "123456")).rejects.toThrow(
        "Verification failed",
      );
    });
  });

  describe("validatePhone", () => {
    it("returns same value for valid e164 number", () => {
      expect(validatePhone("+15551234567")).toBe("+15551234567");
    });

    it("auto-prepends plus when input starts with digit", () => {
      expect(validatePhone("15551234567")).toBe("+15551234567");
    });

    it("auto-prepends + and accepts short valid numbers", () => {
      expect(validatePhone("555")).toBe("+555");
    });

    it("rejects leading zero after +", () => {
      expect(validatePhone("+05551234567")).toBeNull();
    });

    it("rejects too-short number (2 chars)", () => {
      expect(validatePhone("+1")).toBeNull();
    });

    it("accepts minimum valid (3 chars)", () => {
      expect(validatePhone("+12")).toBe("+12");
    });

    it("returns null for non-numeric input", () => {
      expect(validatePhone("abc")).toBeNull();
    });

    it("returns null for empty input", () => {
      expect(validatePhone("")).toBeNull();
    });
  });

  describe("detectShellProfile", () => {
    it("returns zsh profile for zsh shell", () => {
      process.env.SHELL = "/bin/zsh";
      expect(detectShellProfile()).toBe("~/.zshrc");
    });

    it("returns bash profile for bash shell", () => {
      process.env.SHELL = "/bin/bash";
      expect(detectShellProfile()).toBe("~/.bashrc");
    });

    it("returns null for unsupported shell", () => {
      process.env.SHELL = "/bin/fish";
      expect(detectShellProfile()).toBeNull();
    });

    it("returns null on win32 platform", () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      process.env.SHELL = "/bin/zsh";

      expect(detectShellProfile()).toBeNull();
    });
  });

  describe("buildConfigSetCommands", () => {
    it("returns the exact sequence of config key/value pairs", () => {
      const result = buildConfigSetCommands({
        apiUrl: "https://labs.bandwidth.com/api/clawcomm",
        apiToken: "token-abc",
        fromNumber: "+15550001111",
        toNumber: "+15550002222",
      });

      expect(result).toEqual([
        ["plugins.entries.voice-call.config.provider", "bandwidth"],
        [
          "plugins.entries.voice-call.config.bandwidth.apiUrl",
          "https://labs.bandwidth.com/api/clawcomm",
        ],
        ["plugins.entries.voice-call.config.bandwidth.apiToken", "token-abc"],
        ["plugins.entries.voice-call.config.fromNumber", "+15550001111"],
        ["plugins.entries.voice-call.config.toNumber", "+15550002222"],
        ["plugins.entries.voice-call.config.inboundPolicy", "allowlist"],
      ]);
      expect(result).toHaveLength(6);
    });
  });

  describe("resolveApiUrl", () => {
    it("returns env URL when set", () => {
      process.env.CLAWCOMM_API_URL = "https://custom.example.test";
      expect(resolveApiUrl()).toBe("https://custom.example.test");
    });

    it("returns default URL when env var is unset", () => {
      delete process.env.CLAWCOMM_API_URL;
      expect(resolveApiUrl()).toBe(CLAWCOMM_DEFAULT_API_URL);
    });
  });
});
