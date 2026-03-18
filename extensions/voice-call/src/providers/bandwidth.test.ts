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

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as Response);
    global.fetch = mockFetch;

    const result = await provider.initiateCall({
      callId: "internal-uuid",
      from: "+15550001234",
      to: "+15559876543",
      webhookUrl: "https://clawcomm.example.com/ws",
    });

    expect(result.providerCallId).toBe("clawcomm-call-123");
    expect(result.status).toBe("initiated");

    // Verify fetch was called with correct args
    expect(mockFetch).toHaveBeenCalledWith(
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

  describe("parseWebhookEvent", () => {
    it("parses call.speech event from ClawComm WebSocket message", () => {
      const provider = new BandwidthProvider(config);
      const wsMessage = JSON.stringify({
        type: "call.event",
        data: {
          type: "call.speech",
          id: "event-uuid",
          callId: "call-uuid",
          transcript: "Hello agent",
          isFinal: true,
          confidence: 0.95,
          timestamp: 1710000000000,
        },
      });

      const result = provider.parseWebhookEvent({
        headers: {},
        rawBody: wsMessage,
        url: "/ws",
        method: "POST",
      });

      expect(result.events).toHaveLength(1);
      const event = result.events[0];
      expect(event?.type).toBe("call.speech");
      if (event?.type === "call.speech") {
        expect(event.transcript).toBe("Hello agent");
        expect(event.isFinal).toBe(true);
        expect(event.confidence).toBe(0.95);
      }
    });

    it("parses call.dtmf event", () => {
      const provider = new BandwidthProvider(config);
      const wsMessage = JSON.stringify({
        type: "call.event",
        data: {
          type: "call.dtmf",
          id: "event-uuid",
          callId: "call-uuid",
          digits: "5",
          timestamp: 1710000000000,
        },
      });

      const result = provider.parseWebhookEvent({
        headers: {},
        rawBody: wsMessage,
        url: "/ws",
        method: "POST",
      });

      expect(result.events).toHaveLength(1);
      const event = result.events[0];
      expect(event?.type).toBe("call.dtmf");
      if (event?.type === "call.dtmf") {
        expect(event.digits).toBe("5");
      }
    });

    it("parses call.ended event with reason", () => {
      const provider = new BandwidthProvider(config);
      const wsMessage = JSON.stringify({
        type: "call.event",
        data: {
          type: "call.ended",
          id: "event-uuid",
          callId: "call-uuid",
          reason: "hangup-user",
          timestamp: 1710000000000,
        },
      });

      const result = provider.parseWebhookEvent({
        headers: {},
        rawBody: wsMessage,
        url: "/ws",
        method: "POST",
      });

      expect(result.events).toHaveLength(1);
      const event = result.events[0];
      expect(event?.type).toBe("call.ended");
      if (event?.type === "call.ended") {
        expect(event.reason).toBe("hangup-user");
      }
    });

    it("returns empty events for unknown message type", () => {
      const provider = new BandwidthProvider(config);
      const result = provider.parseWebhookEvent({
        headers: {},
        rawBody: JSON.stringify({ type: "unknown.event" }),
        url: "/ws",
        method: "POST",
      });

      expect(result.events).toHaveLength(0);
    });

    it("returns empty events for malformed JSON", () => {
      const provider = new BandwidthProvider(config);
      const result = provider.parseWebhookEvent({
        headers: {},
        rawBody: "not valid json",
        url: "/ws",
        method: "POST",
      });

      expect(result.events).toHaveLength(0);
    });
  });
});
