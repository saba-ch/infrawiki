import { describe, expect, test } from "bun:test";
import { codexOAuthFetch } from "./codex-transport";

const MESSAGE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text: "hi" }],
};
// The backend's final response object carries an empty output array; the
// transport reassembles it from the streamed output items.
const COMPLETED = { id: "resp_1", status: "completed", output: [] };

function sse(
  events: { type: string; response?: unknown; item?: unknown }[],
): string {
  return events
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`)
    .join("\n");
}

describe("codexOAuthFetch", () => {
  test("forces store:false and stream:true, reassembles JSON for non-streaming callers", async () => {
    let sent: { body: string; headers: Headers } | undefined;
    const fetchFn = codexOAuthFetch(async (_input, init) => {
      sent = {
        body: init?.body as string,
        headers: new Headers(init?.headers),
      };
      return new Response(
        sse([
          { type: "response.created", response: { status: "in_progress" } },
          { type: "response.output_item.done", item: MESSAGE },
          { type: "response.completed", response: COMPLETED },
        ]),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    });

    const response = await fetchFn(
      "https://chatgpt.com/backend-api/codex/responses",
      {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-5.6-sol",
          input: [],
          max_output_tokens: 16,
        }),
      },
    );

    const sentBody = JSON.parse(sent?.body ?? "{}");
    expect(sentBody.store).toBe(false);
    expect(sentBody.stream).toBe(true);
    expect(sentBody).not.toHaveProperty("max_output_tokens");
    expect(sent?.headers.get("session_id")).toBeTruthy();
    expect(await response.json()).toEqual({ ...COMPLETED, output: [MESSAGE] });
  });

  test("passes streaming requests through untouched apart from store", async () => {
    const stream = sse([{ type: "response.created" }]);
    const fetchFn = codexOAuthFetch(async (_input, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body.store).toBe(false);
      return new Response(stream, { status: 200 });
    });
    const response = await fetchFn("https://x", {
      body: JSON.stringify({ stream: true }),
    });
    expect(await response.text()).toBe(stream);
  });

  test("error responses pass through for the SDK to parse", async () => {
    const fetchFn = codexOAuthFetch(
      async () =>
        new Response(JSON.stringify({ detail: "model not supported" }), {
          status: 400,
        }),
    );
    const response = await fetchFn("https://x", { body: "{}" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ detail: "model not supported" });
  });
});
