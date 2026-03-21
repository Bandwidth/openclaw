import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
      provider.startListening({ callId: "test", providerCallId: "jambonz-sid" }),
    ).resolves.toBeUndefined();
  });

  it("stopListening is a no-op in Phase 1", async () => {
    const provider = new BandwidthProvider(config);
    await expect(
      provider.stopListening({ callId: "test", providerCallId: "jambonz-sid" }),
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
      }),
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
      }),
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

    it("normalizes call.initiated events", () => {
      const provider = new BandwidthProvider(config);
      const wsMessage = JSON.stringify({
        type: "call.event",
        data: {
          type: "call.initiated",
          id: "event-uuid",
          callId: "call-uuid",
          providerCallId: "provider-uuid",
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
      expect(event?.type).toBe("call.initiated");
      expect(event?.callId).toBe("call-uuid");
    });

    it("normalizes call.ringing events", () => {
      const provider = new BandwidthProvider(config);
      const wsMessage = JSON.stringify({
        type: "call.event",
        data: {
          type: "call.ringing",
          id: "event-uuid",
          callId: "call-uuid",
          providerCallId: "provider-uuid",
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
      expect(event?.type).toBe("call.ringing");
      expect(event?.callId).toBe("call-uuid");
    });

    it("normalizes call.answered events", () => {
      const provider = new BandwidthProvider(config);
      const wsMessage = JSON.stringify({
        type: "call.event",
        data: {
          type: "call.answered",
          id: "event-uuid",
          callId: "call-uuid",
          providerCallId: "provider-uuid",
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
      expect(event?.type).toBe("call.answered");
      expect(event?.callId).toBe("call-uuid");
    });

    it("normalizes call.active events", () => {
      const provider = new BandwidthProvider(config);
      const wsMessage = JSON.stringify({
        type: "call.event",
        data: {
          type: "call.active",
          id: "event-uuid",
          callId: "call-uuid",
          providerCallId: "provider-uuid",
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
      expect(event?.type).toBe("call.active");
      expect(event?.callId).toBe("call-uuid");
    });

    it("normalizes call.speaking events with text", () => {
      const provider = new BandwidthProvider(config);
      const wsMessage = JSON.stringify({
        type: "call.event",
        data: {
          type: "call.speaking",
          id: "event-uuid",
          callId: "call-uuid",
          providerCallId: "provider-uuid",
          timestamp: 1710000000000,
          text: "hello agent",
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
      expect(event?.type).toBe("call.speaking");
      if (event?.type === "call.speaking") {
        expect(event.text).toBe("hello agent");
      }
    });

    it("normalizes call.speaking events with default text when omitted", () => {
      const provider = new BandwidthProvider(config);
      const wsMessage = JSON.stringify({
        type: "call.event",
        data: {
          type: "call.speaking",
          id: "event-uuid",
          callId: "call-uuid",
          providerCallId: "provider-uuid",
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
      expect(event?.type).toBe("call.speaking");
      if (event?.type === "call.speaking") {
        expect(event.text).toBe("");
      }
    });

    it("normalizes call.silence events with durationMs", () => {
      const provider = new BandwidthProvider(config);
      const wsMessage = JSON.stringify({
        type: "call.event",
        data: {
          type: "call.silence",
          id: "event-uuid",
          callId: "call-uuid",
          providerCallId: "provider-uuid",
          timestamp: 1710000000000,
          durationMs: 500,
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
      expect(event?.type).toBe("call.silence");
      if (event?.type === "call.silence") {
        expect(event.durationMs).toBe(500);
      }
    });

    it("normalizes call.silence events with default durationMs when omitted", () => {
      const provider = new BandwidthProvider(config);
      const wsMessage = JSON.stringify({
        type: "call.event",
        data: {
          type: "call.silence",
          id: "event-uuid",
          callId: "call-uuid",
          providerCallId: "provider-uuid",
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
      expect(event?.type).toBe("call.silence");
      if (event?.type === "call.silence") {
        expect(event.durationMs).toBe(0);
      }
    });

    it("normalizes call.error events with error and retryable", () => {
      const provider = new BandwidthProvider(config);
      const wsMessage = JSON.stringify({
        type: "call.event",
        data: {
          type: "call.error",
          id: "event-uuid",
          callId: "call-uuid",
          providerCallId: "provider-uuid",
          timestamp: 1710000000000,
          error: "boom",
          retryable: true,
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
      expect(event?.type).toBe("call.error");
      if (event?.type === "call.error") {
        expect(event.error).toBe("boom");
        expect(event.retryable).toBe(true);
      }
    });

    it("normalizes call.error events with defaults when error/retryable omitted", () => {
      const provider = new BandwidthProvider(config);
      const wsMessage = JSON.stringify({
        type: "call.event",
        data: {
          type: "call.error",
          id: "event-uuid",
          callId: "call-uuid",
          providerCallId: "provider-uuid",
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
      expect(event?.type).toBe("call.error");
      if (event?.type === "call.error") {
        expect(event.error).toBe("Unknown error");
        expect(event.retryable).toBe(false);
      }
    });
  });

  describe("BandwidthProvider WebSocket", () => {
    class FakeWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      readyState = FakeWebSocket.CONNECTING;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: ((err: unknown) => void) | null = null;
      onclose: (() => void) | null = null;

      constructor(public readonly url: string) {}

      close(): void {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.();
      }
    }

    const originalWebSocket = globalThis.WebSocket;

    beforeEach(() => {
      (globalThis as { WebSocket: typeof globalThis.WebSocket }).WebSocket =
        FakeWebSocket as unknown as typeof globalThis.WebSocket;
    });

    afterEach(() => {
      (globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket;
      vi.restoreAllMocks();
    });

    it("connect() initializes websocket state and callback", async () => {
      const provider = new BandwidthProvider(config);
      const mockCallback = vi.fn();

      await provider.connect(mockCallback);

      expect(typeof provider.connect).toBe("function");
      expect(typeof provider.disconnect).toBe("function");
      expect((provider as unknown as { _shouldConnect: boolean })._shouldConnect).toBe(true);
      expect((provider as unknown as { _eventCallback: unknown })._eventCallback).toBe(
        mockCallback,
      );

      const ws = (provider as unknown as { _ws: FakeWebSocket | null })._ws;
      expect(ws).not.toBeNull();
      expect(ws?.url).toBe("wss://api.clawcomm.test/ws?token=test-token-123");
    });

    it("disconnect() cleans up without error when not connected", () => {
      const provider = new BandwidthProvider(config);
      expect(() => provider.disconnect()).not.toThrow();
    });
  });
});
