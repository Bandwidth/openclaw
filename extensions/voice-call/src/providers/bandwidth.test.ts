import { describe, it, expect, vi } from "vitest";
import { BandwidthProvider } from "./bandwidth.js";

describe("BandwidthProvider", () => {
  const config = {
    apiUrl: "https://api.clawcomm.test",
    apiToken: "test-token-123",
  };

  it("has correct provider name", () => {
    const provider = new BandwidthProvider(config);
    expect(provider.name).toBe("bandwidth");
  });

  it("verifyWebhook always returns ok (pre-auth via WebSocket)", () => {
    const provider = new BandwidthProvider(config);
    const result = provider.verifyWebhook({
      headers: {},
      rawBody: "{}",
      url: "/ws/event",
      method: "POST",
    });
    expect(result.ok).toBe(true);
  });

  it("startListening is a no-op in Phase 1", async () => {
    const provider = new BandwidthProvider(config);
    // Should not throw — signaling-only, Jambonz gather handles STT
    await expect(
      provider.startListening({ callId: "test", providerCallId: "jambonz-sid" })
    ).resolves.toBeUndefined();
  });

  it("stopListening is a no-op in Phase 1", async () => {
    const provider = new BandwidthProvider(config);
    await expect(
      provider.stopListening({ callId: "test", providerCallId: "jambonz-sid" })
    ).resolves.toBeUndefined();
  });

  it("initiateCall sends correct request to ClawComm API", async () => {
    const provider = new BandwidthProvider(config);
    const mockResponse = { call_id: "clawcomm-call-123", status: "initiated" };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const result = await provider.initiateCall({
      callId: "internal-uuid",
      from: "+15550001234",
      to: "+15559876543",
      webhookUrl: "https://clawcomm.example.com/ws",
    });

    expect(result.providerCallId).toBe("clawcomm-call-123");
    expect(result.status).toBe("initiated");

    // Verify fetch was called with correct args
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "https://api.clawcomm.test/api/v1/calls/initiate",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-token-123",
        }),
      })
    );
  });

  it("hangupCall accepts 404 as success (call already ended)", async () => {
    const provider = new BandwidthProvider(config);

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => "Not found",
    } as unknown as Response);

    await expect(
      provider.hangupCall({
        callId: "test",
        providerCallId: "jambonz-sid",
        reason: "hangup-bot",
      })
    ).resolves.toBeUndefined();
  });

  it("getCallStatus returns isUnknown on network error (transient)", async () => {
    const provider = new BandwidthProvider(config);
    global.fetch = vi.fn().mockRejectedValueOnce(new Error("Network error"));

    const result = await provider.getCallStatus({
      providerCallId: "jambonz-sid",
    });

    expect(result.isUnknown).toBe(true);
  });
});
