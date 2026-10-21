/**
 * Real proof of the optional SMTP email path (spec section 6), both
 * sides of it:
 *
 *  1. Unconfigured (no SMTP_URL) — must no-op, never throw, never block.
 *     This is the default/production-safe state; no real SMTP exists in
 *     this sandbox, so this is the path that matters most to prove.
 *
 *  2. Configured against a real local SMTP catcher (the `smtp-server`
 *     package, a dev dependency used ONLY by this test — no real SMTP
 *     credentials involved) — proves the actual send path (nodemailer ->
 *     SMTP_URL -> a real socket -> a real SMTP DATA command) genuinely
 *     delivers a message, not just that it would, when SMTP_URL IS set.
 */
import { describe, it, expect, afterEach } from "vitest";
import { SMTPServer } from "smtp-server";
import { sendEmailNotification } from "./email";

describe("sendEmailNotification", () => {
  const originalSmtpUrl = process.env.SMTP_URL;

  afterEach(() => {
    if (originalSmtpUrl === undefined) delete process.env.SMTP_URL;
    else process.env.SMTP_URL = originalSmtpUrl;
  });

  it("no-ops safely when SMTP_URL is not set (never throws, reports why)", async () => {
    delete process.env.SMTP_URL;
    const result = await sendEmailNotification({ to: "someone@example.test", subject: "Test", text: "Body" });
    expect(result.sent).toBe(false);
    expect(result.reason).toBe("smtp_not_configured");
  });

  it("no-ops when there is no recipient to send to", async () => {
    process.env.SMTP_URL = "smtp://127.0.0.1:1";
    const result = await sendEmailNotification({ to: null, subject: "Test", text: "Body" });
    expect(result.sent).toBe(false);
    expect(result.reason).toBe("no_recipient");
  });

  it("genuinely delivers a message through a real local SMTP server when SMTP_URL is configured", async () => {
    const received: Array<{ from: string; to: string[]; body: string }> = [];
    const server = new SMTPServer({
      authOptional: true,
      disabledCommands: ["STARTTLS"],
      onData(stream, session, callback) {
        const chunks: Buffer[] = [];
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () => {
          received.push({
            from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
            to: session.envelope.rcptTo.map((r) => r.address),
            body: Buffer.concat(chunks).toString("utf8"),
          });
          callback();
        });
      },
    });

    const port = 2525 + Math.floor(Math.random() * 1000);
    await new Promise<void>((resolve, reject) => {
      server.on("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });

    try {
      process.env.SMTP_URL = `smtp://127.0.0.1:${port}`;
      const result = await sendEmailNotification({
        to: "recipient@example.test",
        subject: "Phase 5 SMTP proof",
        text: "This is a real message delivered over a real socket to a real local SMTP server.",
      });

      expect(result.sent).toBe(true);
      expect(result.messageId).toBeTruthy();

      expect(received).toHaveLength(1);
      expect(received[0].to).toContain("recipient@example.test");
      expect(received[0].body).toContain("Phase 5 SMTP proof");
      expect(received[0].body).toContain("This is a real message delivered over a real socket");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);
});
